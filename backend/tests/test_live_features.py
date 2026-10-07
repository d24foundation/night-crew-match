"""Tests for Jan-2026 new features:
  - Age verification (register with DOB, /me/verify-age)
  - Party ratings (POST /parties/{id}/rate, pending list)
  - Check-in QR tickets + host check-in
  - WebSocket live chat
Uses public preview URL from EXPO_PUBLIC_BACKEND_URL.
"""
import asyncio
import json
import uuid
import pytest
import requests
import websockets
from datetime import datetime, timedelta, timezone
from pathlib import Path


def _load_base() -> str:
    env = Path("/app/frontend/.env").read_text()
    for line in env.splitlines():
        if line.startswith("EXPO_PUBLIC_BACKEND_URL"):
            return line.split("=", 1)[1].strip().strip('"').rstrip("/")
    raise RuntimeError("EXPO_PUBLIC_BACKEND_URL not found")


BASE = _load_base()
API = f"{BASE}/api"
WS_BASE = BASE.replace("https://", "wss://").replace("http://", "ws://")


def _hdr(tok: str):
    return {"Authorization": f"Bearer {tok}"}


# ---------------- shared fixtures ----------------
@pytest.fixture(scope="module")
def http():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def existing_user(http):
    r = http.post(f"{API}/auth/login", json={"email": "test@afterparty.app", "password": "Test1234!"})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def kofi(http):
    r = http.post(f"{API}/auth/login", json={"email": "kofi@demo.afterparty.app", "password": "demo1234"})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def maya(http):
    r = http.post(f"{API}/auth/login", json={"email": "maya@demo.afterparty.app", "password": "demo1234"})
    assert r.status_code == 200, r.text
    return r.json()


# ---------------- Age verification ----------------
class TestAgeRegister:
    def test_register_under_18_returns_403(self, http):
        email = f"test_{uuid.uuid4().hex[:10]}@afterparty.app"
        r = http.post(f"{API}/auth/register",
                      json={"email": email, "password": "Pass1234", "name": "TEST_U18", "dob": "2012-01-01"})
        assert r.status_code == 403, r.text
        assert "18" in r.text

    def test_register_bad_dob_returns_400(self, http):
        email = f"test_{uuid.uuid4().hex[:10]}@afterparty.app"
        r = http.post(f"{API}/auth/register",
                      json={"email": email, "password": "Pass1234", "name": "TEST_Bad", "dob": "nonsense"})
        assert r.status_code == 400, r.text

    def test_register_missing_dob_returns_422(self, http):
        email = f"test_{uuid.uuid4().hex[:10]}@afterparty.app"
        r = http.post(f"{API}/auth/register",
                      json={"email": email, "password": "Pass1234", "name": "TEST_NoDOB"})
        assert r.status_code == 422, r.text

    def test_register_adult_ok_and_age_verified(self, http):
        email = f"test_{uuid.uuid4().hex[:10]}@afterparty.app"
        r = http.post(f"{API}/auth/register",
                      json={"email": email, "password": "Pass1234", "name": "TEST_Adult", "dob": "1999-05-05"})
        assert r.status_code == 200, r.text
        body = r.json()
        user = body["user"]
        assert user["age_verified"] is True
        # age should be computed and > 18
        assert isinstance(user.get("age"), int) and user["age"] >= 18


class TestVerifyAgeEndpoint:
    def test_verify_age_under_18_rejected(self, http, existing_user):
        r = http.post(f"{API}/me/verify-age", json={"dob": "2015-01-01"},
                      headers=_hdr(existing_user["token"]))
        assert r.status_code == 403, r.text

    def test_verify_age_adult_ok(self, http, existing_user):
        r = http.post(f"{API}/me/verify-age", json={"dob": "1998-01-01"},
                      headers=_hdr(existing_user["token"]))
        assert r.status_code == 200, r.text
        # Verify persisted
        me = http.get(f"{API}/auth/me", headers=_hdr(existing_user["token"])).json()
        assert me.get("age_verified") is True


@pytest.fixture(scope="module")
def fresh_host(http):
    """A brand new registered host - avoids state pollution across runs."""
    email = f"test_host_{uuid.uuid4().hex[:10]}@afterparty.app"
    r = http.post(f"{API}/auth/register",
                  json={"email": email, "password": "Pass1234", "name": "TEST_Host", "dob": "1990-01-01"})
    assert r.status_code == 200, r.text
    return r.json()


# ---------------- Ratings + Check-in: build a started party as fresh_host + guest join ----------------
@pytest.fixture(scope="module")
def started_party(http, fresh_host, maya):
    """Create a party as fresh_host starting 1h ago in London, join as maya (super ⇒ bypasses limit)."""
    starts_at = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    payload = {"title": "TEST_Rating Test", "description": "test rating", "city": "London",
               "area": "Test", "address": "9 Rating Rd", "vibe": "House",
               "starts_at": starts_at,
               "house_provided": True, "drinks_needed": 1, "chip_in": 0, "capacity": 10}
    cr = http.post(f"{API}/parties", json=payload, headers=_hdr(fresh_host["token"]))
    assert cr.status_code == 200, cr.text
    pid = cr.json()["party_id"]

    # Maya (super) joins — bypasses 3-join limit
    jr = http.post(f"{API}/parties/{pid}/join", json={"role": "chipin"},
                   headers=_hdr(maya["token"]))
    assert jr.status_code == 200, jr.text
    return {"party_id": pid, "host": fresh_host, "guest": maya}


class TestRatings:
    def test_pending_contains_started_party(self, http, started_party):
        g = started_party["guest"]
        pr = http.get(f"{API}/ratings/pending", headers=_hdr(g["token"]))
        assert pr.status_code == 200, pr.text
        ids = [p["party_id"] for p in pr.json()]
        assert started_party["party_id"] in ids

    def test_rate_5_stars_updates_host_avg(self, http, started_party):
        g = started_party["guest"]
        pid = started_party["party_id"]
        r = http.post(f"{API}/parties/{pid}/rate", json={"stars": 5},
                      headers=_hdr(g["token"]))
        assert r.status_code == 200, r.text
        # Verify host rating via GET /parties/{id}
        d = http.get(f"{API}/parties/{pid}", headers=_hdr(g["token"])).json()
        assert d["host"]["rating_avg"] == 5.0, d["host"]
        assert d["host"]["rating_count"] == 1

    def test_rerate_updates_avg_count_unchanged(self, http, started_party):
        g = started_party["guest"]
        pid = started_party["party_id"]
        r = http.post(f"{API}/parties/{pid}/rate", json={"stars": 3},
                      headers=_hdr(g["token"]))
        assert r.status_code == 200
        d = http.get(f"{API}/parties/{pid}", headers=_hdr(g["token"])).json()
        assert d["host"]["rating_avg"] == 3.0
        assert d["host"]["rating_count"] == 1

    def test_pending_excludes_after_rating(self, http, started_party):
        g = started_party["guest"]
        pr = http.get(f"{API}/ratings/pending", headers=_hdr(g["token"]))
        ids = [p["party_id"] for p in pr.json()]
        assert started_party["party_id"] not in ids

    def test_non_attendee_cannot_rate(self, http, started_party, existing_user):
        pid = started_party["party_id"]
        r = http.post(f"{API}/parties/{pid}/rate", json={"stars": 4},
                      headers=_hdr(existing_user["token"]))
        assert r.status_code == 403, r.text

    def test_future_party_rate_returns_400(self, http, started_party):
        """Create a future party as kofi, maya joins, maya rates → 400."""
        host = started_party["host"]
        guest = started_party["guest"]
        starts = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
        cr = http.post(f"{API}/parties",
                       json={"title": "TEST_Future", "description": "", "city": "London",
                             "area": "Test", "address": "1 Future Rd", "vibe": "House",
                             "starts_at": starts, "house_provided": True,
                             "drinks_needed": 1, "chip_in": 0, "capacity": 10},
                       headers=_hdr(host["token"]))
        assert cr.status_code == 200, cr.text
        pid = cr.json()["party_id"]
        jr = http.post(f"{API}/parties/{pid}/join", json={"role": "chipin"},
                       headers=_hdr(guest["token"]))
        assert jr.status_code == 200
        r = http.post(f"{API}/parties/{pid}/rate", json={"stars": 5},
                      headers=_hdr(guest["token"]))
        assert r.status_code == 400, r.text


# ---------------- Check-in ----------------
class TestCheckin:
    def test_ticket_and_checkin_flow(self, http, started_party):
        host = started_party["host"]
        guest = started_party["guest"]
        pid = started_party["party_id"]

        # guest fetches ticket
        tk = http.get(f"{API}/parties/{pid}/ticket", headers=_hdr(guest["token"]))
        assert tk.status_code == 200, tk.text
        tbody = tk.json()
        assert isinstance(tbody["code"], str) and len(tbody["code"]) == 6
        assert tbody["qr"] == f"afterparty:{pid}:{tbody['code']}"
        assert tbody["checked_in"] is False

        # host checks in using the qr string
        r = http.post(f"{API}/parties/{pid}/checkin", json={"code": tbody["qr"]},
                      headers=_hdr(host["token"]))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["already"] is False
        assert body["guest"]["name"]

        # idempotent → already=true
        r2 = http.post(f"{API}/parties/{pid}/checkin", json={"code": tbody["qr"]},
                      headers=_hdr(host["token"]))
        assert r2.status_code == 200
        assert r2.json()["already"] is True

        # party view: checked_in_count == 1 and attendee flagged
        d = http.get(f"{API}/parties/{pid}", headers=_hdr(host["token"])).json()
        assert d["checked_in_count"] == 1
        guest_att = next((a for a in d["attendees"] if a["user_id"] == guest["user"]["user_id"]), None)
        assert guest_att and guest_att["checked_in"] is True

    def test_wrong_code_404(self, http, started_party):
        host = started_party["host"]
        pid = started_party["party_id"]
        r = http.post(f"{API}/parties/{pid}/checkin", json={"code": "ZZZZZZ"},
                      headers=_hdr(host["token"]))
        assert r.status_code == 404, r.text

    def test_non_host_checkin_403(self, http, started_party):
        guest = started_party["guest"]
        pid = started_party["party_id"]
        # fetch its own ticket code
        tk = http.get(f"{API}/parties/{pid}/ticket", headers=_hdr(guest["token"])).json()
        r = http.post(f"{API}/parties/{pid}/checkin", json={"code": tk["code"]},
                      headers=_hdr(guest["token"]))
        assert r.status_code == 403, r.text

    def test_qr_with_wrong_party_id_400(self, http, started_party):
        host = started_party["host"]
        pid = started_party["party_id"]
        r = http.post(f"{API}/parties/{pid}/checkin",
                      json={"code": "afterparty:party_different:ABCDEF"},
                      headers=_hdr(host["token"]))
        assert r.status_code == 400, r.text


# ---------------- WebSocket Live Chat ----------------
class TestLiveChatWS:
    def test_message_broadcast_and_typing(self, http, started_party):
        host = started_party["host"]
        guest = started_party["guest"]
        pid = started_party["party_id"]

        async def _run():
            guest_url = f"{WS_BASE}/api/ws/chats/{pid}?token={guest['token']}"
            host_url = f"{WS_BASE}/api/ws/chats/{pid}?token={host['token']}"

            async with websockets.connect(guest_url) as ws_g:
                async with websockets.connect(host_url) as ws_h:
                    # host posts a chat message via REST
                    await asyncio.sleep(0.3)
                    r = await asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda: http.post(f"{API}/chats/{pid}",
                                          json={"text": "TEST_hello live"},
                                          headers=_hdr(host["token"]))
                    )
                    assert r.status_code == 200, r.text

                    # guest should receive {type:'message', message:...}
                    msg_raw = await asyncio.wait_for(ws_g.recv(), timeout=6)
                    msg = json.loads(msg_raw)
                    assert msg.get("type") == "message", msg
                    assert msg["message"]["text"] == "TEST_hello live"

                    # host sends typing on → guest receives typing event
                    await ws_h.send(json.dumps({"type": "typing", "on": True}))
                    typ_raw = await asyncio.wait_for(ws_g.recv(), timeout=4)
                    typ = json.loads(typ_raw)
                    assert typ["type"] == "typing"
                    assert typ.get("name"), typ
                    assert typ["on"] is True

        asyncio.run(_run())

    def test_invalid_token_closes_with_4401(self, started_party):
        pid = started_party["party_id"]

        async def _run():
            url = f"{WS_BASE}/api/ws/chats/{pid}?token=invalidtoken"
            try:
                async with websockets.connect(url) as ws:
                    # Should be closed immediately — recv raises
                    await asyncio.wait_for(ws.recv(), timeout=5)
                    pytest.fail("ws did not close for invalid token")
            except websockets.ConnectionClosed as e:
                assert e.code == 4401, f"expected 4401, got {e.code}"
            except websockets.InvalidStatus as e:
                # Some servers reject the handshake outright — acceptable for invalid token
                assert e.response.status_code in (401, 403, 404), e.response.status_code

        asyncio.run(_run())
