"""After Party backend regression tests.

Covers: auth, parties CRUD + role join + join limits, discover/swipe/match,
chat access control, boost + profile, payments checkout + status + X-Store-Tier.
Uses public preview URL from EXPO_PUBLIC_BACKEND_URL.
"""
import os
import time
import uuid
import pytest
import requests
from pathlib import Path

# Load EXPO_PUBLIC_BACKEND_URL from /app/frontend/.env
def _load_base():
    env = Path("/app/frontend/.env").read_text()
    for line in env.splitlines():
        if line.startswith("EXPO_PUBLIC_BACKEND_URL"):
            return line.split("=", 1)[1].strip().strip('"').rstrip("/")
    raise RuntimeError("EXPO_PUBLIC_BACKEND_URL not found")

BASE = _load_base()
API = f"{BASE}/api"


# ---------------- fixtures ----------------
@pytest.fixture(scope="session")
def http():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def _hdr(tok, store=None):
    h = {"Authorization": f"Bearer {tok}"}
    if store:
        h["X-Store-Tier"] = store
    return h


@pytest.fixture(scope="session")
def fresh_user(http):
    """Register a brand new user to avoid join-limit history."""
    email = f"test_{uuid.uuid4().hex[:10]}@afterparty.app"
    r = http.post(f"{API}/auth/register",
                  json={"email": email, "password": "Test1234!", "name": "TEST_Fresh", "dob": "1998-01-01"})
    assert r.status_code == 200, r.text
    data = r.json()
    return {"email": email, "password": "Test1234!", "token": data["token"], "user": data["user"]}


@pytest.fixture(scope="session")
def existing_user(http):
    r = http.post(f"{API}/auth/login", json={"email": "test@afterparty.app", "password": "Test1234!"})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="session")
def super_user(http):
    r = http.post(f"{API}/auth/login", json={"email": "maya@demo.afterparty.app", "password": "demo1234"})
    assert r.status_code == 200, r.text
    return r.json()


# ---------------- auth ----------------
class TestAuth:
    def test_register_creates_user(self, http):
        email = f"test_{uuid.uuid4().hex[:8]}@afterparty.app"
        r = http.post(f"{API}/auth/register", json={"email": email, "password": "Pass1234", "name": "TEST_Reg", "dob": "1998-01-01"})
        assert r.status_code == 200
        d = r.json()
        assert d["token"] and d["user"]["email"] == email
        assert d["user"]["tier"] == "free"

    def test_register_duplicate_409(self, http, existing_user):
        r = http.post(f"{API}/auth/register",
                      json={"email": "test@afterparty.app", "password": "Test1234!", "name": "X", "dob": "1998-01-01"})
        assert r.status_code == 409

    def test_login_success_returns_token_and_user(self, existing_user):
        assert "token" in existing_user and existing_user["user"]["email"] == "test@afterparty.app"

    def test_login_wrong_password_401(self, http):
        r = http.post(f"{API}/auth/login", json={"email": "test@afterparty.app", "password": "wrong"})
        assert r.status_code == 401

    def test_me_requires_token(self, http):
        assert http.get(f"{API}/auth/me").status_code == 401

    def test_me_returns_profile(self, http, existing_user):
        r = http.get(f"{API}/auth/me", headers=_hdr(existing_user["token"]))
        assert r.status_code == 200
        assert r.json()["email"] == "test@afterparty.app"


# ---------------- parties ----------------
class TestParties:
    def test_list_london_super_first(self, http, existing_user):
        r = http.get(f"{API}/parties?city=London", headers=_hdr(existing_user["token"]))
        assert r.status_code == 200
        parties = r.json()
        assert len(parties) >= 1
        # super hosts (if any among top) should be first
        tiers = [p["host"]["tier"] for p in parties if p.get("host")]
        if "super" in tiers:
            assert tiers[0] == "super", f"super host not first: {tiers}"

    def test_address_hidden_for_non_attendee(self, http, existing_user):
        r = http.get(f"{API}/parties?city=London", headers=_hdr(existing_user["token"]))
        details = [http.get(f"{API}/parties/{p['party_id']}", headers=_hdr(existing_user["token"])).json() for p in r.json()]
        outsiders = [d for d in details if not d["is_host"] and not d["attending"]]
        if not outsiders:
            pytest.skip("test user is in every London party")
        d = outsiders[0]
        assert d["address"] is None
        # non-super viewing someone else's party → cannot see attendees
        if not d["is_host"]:
            assert d["can_see_attendees"] is False
            assert d["attendees"] == []

    def test_super_tier_sees_attendees(self, http, super_user):
        r = http.get(f"{API}/parties?city=London", headers=_hdr(super_user["token"]))
        parties = r.json()
        other = next((p for p in parties if not p["is_host"]), None)
        assert other is not None
        d = http.get(f"{API}/parties/{other['party_id']}", headers=_hdr(super_user["token"])).json()
        assert d["can_see_attendees"] is True

    def test_create_party_persists(self, http, fresh_user):
        payload = {"title": "TEST_Rooftop Afters", "description": "test", "city": "London",
                   "area": "Camden", "address": "1 Test Rd", "vibe": "House",
                   "starts_at": "2030-01-01T22:00:00+00:00",
                   "house_provided": True, "drinks_needed": 3, "chip_in": 5, "capacity": 10}
        r = http.post(f"{API}/parties", json=payload, headers=_hdr(fresh_user["token"]))
        assert r.status_code == 200, r.text
        pid = r.json()["party_id"]
        # verify persisted
        g = http.get(f"{API}/parties/{pid}", headers=_hdr(fresh_user["token"]))
        assert g.status_code == 200
        assert g.json()["title"] == "TEST_Rooftop Afters"
        assert g.json()["is_host"] is True
        assert g.json()["address"] == "1 Test Rd"  # host sees address
        fresh_user["my_party_id"] = pid

    def test_join_party_with_role(self, http, fresh_user):
        parties = http.get(f"{API}/parties?city=London", headers=_hdr(fresh_user["token"])).json()
        target = next(p for p in parties if not p["is_host"] and not p["attending"])
        r = http.post(f"{API}/parties/{target['party_id']}/join",
                      json={"role": "drinks"}, headers=_hdr(fresh_user["token"]))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["attending"] is True
        assert body["my_role"] == "drinks"
        assert body["address"] is not None  # now revealed
        fresh_user["joined_party_id"] = target["party_id"]

    def test_free_join_limit_402(self, http):
        # create isolated free user and burn 3 joins then expect 402
        email = f"test_{uuid.uuid4().hex[:8]}@afterparty.app"
        tok = http.post(f"{API}/auth/register",
                        json={"email": email, "password": "Pass1234", "name": "TEST_Limit", "dob": "1998-01-01"}).json()["token"]
        parties = http.get(f"{API}/parties?city=London", headers=_hdr(tok)).json()
        joinable = [p for p in parties if not p["is_host"] and not p["attending"]][:4]
        if len(joinable) < 4:
            pytest.skip("Need at least 4 non-host parties for limit test")
        statuses = []
        for p in joinable:
            r = http.post(f"{API}/parties/{p['party_id']}/join",
                          json={"role": "chipin"}, headers=_hdr(tok))
            statuses.append(r.status_code)
        assert statuses.count(200) == 3 and statuses[-1] == 402, statuses

    def test_store_tier_header_elevates(self, http):
        """X-Store-Tier=premium should bypass free join limit."""
        email = f"test_{uuid.uuid4().hex[:8]}@afterparty.app"
        tok = http.post(f"{API}/auth/register",
                        json={"email": email, "password": "Pass1234", "name": "TEST_Store", "dob": "1998-01-01"}).json()["token"]
        parties = http.get(f"{API}/parties?city=London", headers=_hdr(tok, "premium")).json()
        joinable = [p for p in parties if not p["is_host"] and not p["attending"]][:4]
        if len(joinable) < 4:
            pytest.skip("not enough parties")
        oks = 0
        for p in joinable:
            r = http.post(f"{API}/parties/{p['party_id']}/join",
                          json={"role": "chipin"}, headers=_hdr(tok, "premium"))
            if r.status_code == 200:
                oks += 1
        assert oks == 4, f"X-Store-Tier premium should allow 4 joins, got {oks}"

    def test_leave_party(self, http, fresh_user):
        pid = fresh_user.get("joined_party_id")
        if not pid:
            pytest.skip("no joined party")
        r = http.post(f"{API}/parties/{pid}/leave", headers=_hdr(fresh_user["token"]))
        assert r.status_code == 200
        assert r.json()["attending"] is False


# ---------------- discover / swipe / match ----------------
class TestSwipe:
    def test_discover(self, http, fresh_user):
        r = http.get(f"{API}/discover", headers=_hdr(fresh_user["token"]))
        assert r.status_code == 200
        people = r.json()
        assert len(people) >= 1
        fresh_user["discover"] = people

    def test_swipe_like_demo_user_matches(self, http, fresh_user):
        people = fresh_user.get("discover") or http.get(f"{API}/discover", headers=_hdr(fresh_user["token"])).json()
        # iterate until we find a demo user (verified super demo users auto-match)
        match_id = None
        for target in people:
            r = http.post(f"{API}/swipe", json={"target_id": target["user_id"], "like": True},
                          headers=_hdr(fresh_user["token"]))
            assert r.status_code == 200, r.text
            if r.json().get("match"):
                match_id = r.json()["match"]["match_id"]
                break
        assert match_id is not None, "expected at least one demo auto-match"
        fresh_user["match_id"] = match_id

    def test_matches_list(self, http, fresh_user):
        r = http.get(f"{API}/matches", headers=_hdr(fresh_user["token"]))
        assert r.status_code == 200
        assert any(m["match_id"] == fresh_user.get("match_id") for m in r.json())


# ---------------- chat ----------------
class TestChat:
    def test_chats_list(self, http, fresh_user):
        r = http.get(f"{API}/chats", headers=_hdr(fresh_user["token"]))
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_match_chat_send_and_read(self, http, fresh_user):
        mid = fresh_user.get("match_id")
        if not mid:
            pytest.skip("no match")
        r = http.post(f"{API}/chats/{mid}", json={"text": "TEST hi"}, headers=_hdr(fresh_user["token"]))
        assert r.status_code == 200
        g = http.get(f"{API}/chats/{mid}", headers=_hdr(fresh_user["token"]))
        assert g.status_code == 200
        texts = [m["text"] for m in g.json()["messages"]]
        assert "TEST hi" in texts

    def test_chat_access_denied_for_stranger(self, http, existing_user, fresh_user):
        mid = fresh_user.get("match_id")
        if not mid:
            pytest.skip("no match")
        r = http.get(f"{API}/chats/{mid}", headers=_hdr(existing_user["token"]))
        assert r.status_code == 403

    def test_party_chat_requires_attendance(self, http, fresh_user, existing_user):
        pid = fresh_user.get("my_party_id")
        if not pid:
            pytest.skip("no party")
        # non-attendee existing_user → 403
        r = http.get(f"{API}/chats/{pid}", headers=_hdr(existing_user["token"]))
        assert r.status_code == 403
        # host can access
        r2 = http.get(f"{API}/chats/{pid}", headers=_hdr(fresh_user["token"]))
        assert r2.status_code == 200


# ---------------- profile / boost ----------------
class TestProfileBoost:
    def test_update_profile(self, http, fresh_user):
        r = http.put(f"{API}/me", json={"bio": "TEST bio", "city": "London", "age": 25, "vibes": ["House"]},
                     headers=_hdr(fresh_user["token"]))
        assert r.status_code == 200
        assert r.json()["bio"] == "TEST bio"
        # verify persistence
        me = http.get(f"{API}/auth/me", headers=_hdr(fresh_user["token"])).json()
        assert me["bio"] == "TEST bio"

    def test_boost_free_402(self, http, fresh_user):
        r = http.post(f"{API}/me/boost", headers=_hdr(fresh_user["token"]))
        assert r.status_code == 402

    def test_boost_store_tier_premium_ok(self, http, fresh_user):
        r = http.post(f"{API}/me/boost", headers=_hdr(fresh_user["token"], "premium"))
        assert r.status_code == 200
        assert "boosted_until" in r.json()


# ---------------- payments ----------------
class TestPayments:
    def test_checkout_premium_returns_url(self, http, fresh_user):
        r = http.post(f"{API}/payments/checkout",
                      json={"plan": "premium", "origin_url": BASE},
                      headers=_hdr(fresh_user["token"]))
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["url"].startswith("http") and d["session_id"]
        fresh_user["sess"] = d["session_id"]

    def test_checkout_super_returns_url(self, http, fresh_user):
        r = http.post(f"{API}/payments/checkout",
                      json={"plan": "super", "origin_url": BASE},
                      headers=_hdr(fresh_user["token"]))
        assert r.status_code == 200
        assert r.json()["url"].startswith("http")

    def test_checkout_invalid_plan(self, http, fresh_user):
        r = http.post(f"{API}/payments/checkout",
                      json={"plan": "ultra", "origin_url": BASE},
                      headers=_hdr(fresh_user["token"]))
        assert r.status_code == 422

    def test_payment_status_returns(self, http, fresh_user):
        sid = fresh_user.get("sess")
        if not sid:
            pytest.skip("no session")
        r = http.get(f"{API}/payments/status/{sid}", headers=_hdr(fresh_user["token"]))
        # Allow 200 even if unpaid; just verify shape
        assert r.status_code == 200, r.text
        body = r.json()
        assert "payment_status" in body and "plan" in body
