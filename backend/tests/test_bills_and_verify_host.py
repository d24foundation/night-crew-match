"""Tests for iter-8 new features:
  - Split-the-bill in party group chats:
      POST /api/chats/{party_id}/bills, GET /api/chats/{party_id}/bills,
      POST /api/payments/checkout (bill_id), POST /api/bills/{id}/mark-paid,
      DELETE /api/bills/{id}
  - Host ID verification:
      POST /api/me/verify-host (multipart),
      GET  /api/admin/host-verifications (x-admin-secret),
      POST /api/admin/host-verifications/{user_id}

Uses the public preview URL from EXPO_PUBLIC_BACKEND_URL.
Note: /api/auth/* has 20/min per-IP rate limit — sleep on 429.
"""
import io
import os
import struct
import time
import uuid
import zlib
import pytest
import requests
from datetime import datetime, timedelta, timezone
from pathlib import Path


# ---------------- helpers ----------------
def _load_env(key: str) -> str:
    txt = Path("/app/frontend/.env").read_text()
    for line in txt.splitlines():
        if line.startswith(key):
            return line.split("=", 1)[1].strip().strip('"').rstrip("/")
    raise RuntimeError(f"{key} not found in /app/frontend/.env")


def _load_backend_env(key: str) -> str:
    txt = Path("/app/backend/.env").read_text()
    for line in txt.splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"')
    raise RuntimeError(f"{key} not found in /app/backend/.env")


BASE = _load_env("EXPO_PUBLIC_BACKEND_URL")
API = f"{BASE}/api"
ADMIN_SECRET = _load_backend_env("ADMIN_SECRET")


def _hdr(tok: str):
    return {"Authorization": f"Bearer {tok}"}


def _post_with_retry(http, url, **kwargs):
    for _ in range(3):
        r = http.post(url, **kwargs)
        if r.status_code != 429:
            return r
        time.sleep(float(r.headers.get("Retry-After", 60)))
    return r


def _tiny_png_bytes(w: int = 2, h: int = 2) -> bytes:
    """A valid 2x2 PNG using the correct magic bytes."""
    sig = b"\x89PNG\r\n\x1a\n"
    def chunk(ctype, data):
        return struct.pack("!I", len(data)) + ctype + data + struct.pack("!I", zlib.crc32(ctype + data) & 0xFFFFFFFF)
    ihdr = struct.pack("!IIBBBBB", w, h, 8, 2, 0, 0, 0)  # 8-bit RGB
    raw = b""
    for _y in range(h):
        raw += b"\x00" + (b"\xff\xff\xff" * w)
    idat = zlib.compress(raw)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


PNG_BYTES = _tiny_png_bytes()


# ---------------- fixtures ----------------
@pytest.fixture(scope="module")
def http():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def kofi(http):
    r = _post_with_retry(http, f"{API}/auth/login",
                         json={"email": "kofi@demo.afterparty.app", "password": "demo1234"})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def test_user(http):
    r = _post_with_retry(http, f"{API}/auth/login",
                         json={"email": "test@afterparty.app", "password": "Test1234!"})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def zara(http):
    r = _post_with_retry(http, f"{API}/auth/login",
                         json={"email": "zara@demo.afterparty.app", "password": "demo1234"})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def shared_party(http, kofi, test_user):
    """A party where kofi hosts and test@ attends."""
    # Try /parties/mine for kofi first
    mine = http.get(f"{API}/parties/mine", headers=_hdr(kofi["token"])).json()
    pid = None
    for p in mine:
        if p.get("host_id") == kofi["user"]["user_id"]:
            # Check if test@ is attending
            det = http.get(f"{API}/parties/{p['party_id']}", headers=_hdr(test_user["token"])).json()
            if det.get("attending"):
                pid = p["party_id"]
                break
    if not pid:
        # Create a fresh party and have test@ join
        starts = (datetime.now(timezone.utc) + timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%SZ")
        pr = http.post(f"{API}/parties", headers=_hdr(kofi["token"]), json={
            "title": "TEST_BillsParty", "description": "Testing bills",
            "city": "London", "area": "Soho", "starts_at": starts,
            "vibe": "chill", "drinks_needed": True, "house_provided": True,
            "chip_in": 5, "capacity": 10,
        })
        assert pr.status_code == 200, pr.text
        pid = pr.json()["party_id"]
        jr = http.post(f"{API}/parties/{pid}/join", headers=_hdr(test_user["token"]),
                       json={"role": "chipin", "use_credits": False})
        assert jr.status_code == 200, jr.text
    return pid


# ---------------- Bills ----------------
class TestBills:
    def test_create_bill_as_host(self, http, kofi, test_user, shared_party):
        pid = shared_party
        r = http.post(f"{API}/chats/{pid}/bills", headers=_hdr(kofi["token"]),
                      json={"title": "TEST_Drinks", "amount": 40})
        assert r.status_code == 201, r.text
        b = r.json()
        assert b["title"] == "TEST_Drinks"
        assert b["amount"] == 40.0
        assert b["creator_id"] == kofi["user"]["user_id"]
        assert b["is_creator"] is True
        assert b["my_paid"] is True  # creator counts as paid
        assert isinstance(b["my_share"], (int, float))
        assert len(b["people"]) >= 2
        # Shares should sum to amount
        total = round(sum(p["share"] for p in b["people"]), 2)
        assert abs(total - 40.0) < 0.02, f"shares sum {total} != 40.00"
        # Save for later tests
        pytest.bill_id = b["bill_id"]
        pytest.bill_chat_id = pid

    def test_list_bills_as_guest(self, http, test_user, shared_party):
        pid = shared_party
        r = http.get(f"{API}/chats/{pid}/bills", headers=_hdr(test_user["token"]))
        assert r.status_code == 200, r.text
        bills = r.json()
        mine = next((b for b in bills if b["bill_id"] == pytest.bill_id), None)
        assert mine is not None, "created bill not visible to guest"
        assert mine["my_paid"] is False
        assert mine["my_share"] > 0
        assert mine["is_creator"] is False

    def test_guest_checkout_for_share_returns_stripe_url(self, http, test_user):
        r = http.post(f"{API}/payments/checkout", headers=_hdr(test_user["token"]),
                      json={"bill_id": pytest.bill_id, "origin_url": BASE})
        assert r.status_code == 200, r.text
        d = r.json()
        assert "checkout.stripe.com" in d["url"]
        assert d["session_id"]

    def test_creator_cannot_checkout_own_bill(self, http, kofi):
        r = http.post(f"{API}/payments/checkout", headers=_hdr(kofi["token"]),
                      json={"bill_id": pytest.bill_id, "origin_url": BASE})
        assert r.status_code == 400, r.text

    def test_non_creator_cannot_mark_paid(self, http, test_user):
        r = http.post(f"{API}/bills/{pytest.bill_id}/mark-paid",
                      headers=_hdr(test_user["token"]),
                      json={"user_id": test_user["user"]["user_id"]})
        assert r.status_code == 403, r.text

    def test_creator_mark_paid_updates_state(self, http, kofi, test_user, shared_party):
        tid = test_user["user"]["user_id"]
        before = http.get(f"{API}/chats/{shared_party}/bills",
                          headers=_hdr(kofi["token"])).json()
        before_bill = next(b for b in before if b["bill_id"] == pytest.bill_id)
        collected_before = before_bill["collected"]

        r = http.post(f"{API}/bills/{pytest.bill_id}/mark-paid",
                      headers=_hdr(kofi["token"]),
                      json={"user_id": tid})
        assert r.status_code == 200, r.text

        # Verify from test@'s view
        after = http.get(f"{API}/chats/{shared_party}/bills",
                        headers=_hdr(test_user["token"])).json()
        after_bill = next(b for b in after if b["bill_id"] == pytest.bill_id)
        assert after_bill["my_paid"] is True
        # Collected should go up
        after_host = http.get(f"{API}/chats/{shared_party}/bills",
                              headers=_hdr(kofi["token"])).json()
        after_host_bill = next(b for b in after_host if b["bill_id"] == pytest.bill_id)
        assert after_host_bill["collected"] > collected_before

    def test_non_participant_checkout_403(self, http, zara, shared_party, test_user, kofi):
        # Create a brand new bill (previous one may be settled)
        r = http.post(f"{API}/chats/{shared_party}/bills", headers=_hdr(kofi["token"]),
                      json={"title": "TEST_Drinks2", "amount": 20})
        assert r.status_code == 201, r.text
        bid = r.json()["bill_id"]
        # Confirm zara is NOT on it (she's not an attendee)
        people_ids = {p["user_id"] for p in r.json()["people"]}
        if zara["user"]["user_id"] in people_ids:
            pytest.skip("zara is attending the party, cannot assert 403")
        rr = http.post(f"{API}/payments/checkout", headers=_hdr(zara["token"]),
                       json={"bill_id": bid, "origin_url": BASE})
        assert rr.status_code == 403, rr.text
        pytest.bill_id_2 = bid

    def test_delete_bill_cash_only_ok(self, http, kofi):
        # The bill from the previous test (if cash-only or no payments) should be deletable
        r = http.delete(f"{API}/bills/{pytest.bill_id_2}", headers=_hdr(kofi["token"]))
        assert r.status_code == 200, r.text

    def test_bill_split_message_posted(self, http, kofi, shared_party):
        r = http.get(f"{API}/chats/{shared_party}", headers=_hdr(kofi["token"]))
        assert r.status_code == 200
        msgs = r.json()["messages"]
        splits = [m for m in msgs if "💸" in m.get("text", "") or m.get("text", "").startswith("💸 Split")
                  or "Split:" in m.get("text", "")]
        assert len(splits) >= 1, "no 💸 Split: system message posted"

    def test_bill_on_match_chat_400(self, http, test_user):
        """Try creating a bill on a match chat (if test@ has one)."""
        r = http.get(f"{API}/chats", headers=_hdr(test_user["token"]))
        chats = r.json()
        match = next((c for c in chats if c["kind"] == "match"), None)
        if not match:
            pytest.skip("test@ has no match chat")
        rr = http.post(f"{API}/chats/{match['chat_id']}/bills",
                       headers=_hdr(test_user["token"]),
                       json={"title": "x", "amount": 5})
        assert rr.status_code == 400, rr.text


# ---------------- Host verification ----------------
class TestHostVerification:
    @pytest.fixture(scope="class")
    def fresh(self, http):
        email = f"test_{uuid.uuid4().hex[:10]}@afterparty.app"
        r = _post_with_retry(http, f"{API}/auth/register",
                             json={"email": email, "password": "Test1234!",
                                   "name": "TEST_HostKYC", "dob": "1995-01-01"})
        assert r.status_code == 200, r.text
        return r.json()

    def test_submit_verify_host_with_valid_pngs(self, http, fresh):
        files = {
            "id_document": ("id.png", io.BytesIO(PNG_BYTES), "image/png"),
            "selfie":      ("selfie.png", io.BytesIO(PNG_BYTES), "image/png"),
        }
        # multipart — do not send JSON Content-Type
        r = requests.post(f"{API}/me/verify-host",
                          headers={"Authorization": f"Bearer {fresh['token']}"},
                          files=files)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("host_verification_status") == "pending"

    def test_second_submission_under_review_400(self, http, fresh):
        files = {
            "id_document": ("id.png", io.BytesIO(PNG_BYTES), "image/png"),
            "selfie":      ("selfie.png", io.BytesIO(PNG_BYTES), "image/png"),
        }
        r = requests.post(f"{API}/me/verify-host",
                          headers={"Authorization": f"Bearer {fresh['token']}"},
                          files=files)
        assert r.status_code == 400, r.text
        assert "review" in r.text.lower()

    def test_text_plain_rejected(self, http):
        # Use a different fresh user (otherwise 'under review' blocks us first)
        email = f"test_{uuid.uuid4().hex[:10]}@afterparty.app"
        r = _post_with_retry(http, f"{API}/auth/register",
                             json={"email": email, "password": "Test1234!",
                                   "name": "TEST_HostKYC2", "dob": "1995-01-01"})
        assert r.status_code == 200, r.text
        tok = r.json()["token"]
        files = {
            "id_document": ("id.txt", io.BytesIO(b"hello"), "text/plain"),
            "selfie":      ("selfie.txt", io.BytesIO(b"hi"), "text/plain"),
        }
        rr = requests.post(f"{API}/me/verify-host",
                           headers={"Authorization": f"Bearer {tok}"},
                           files=files)
        assert rr.status_code == 400, rr.text

    def test_admin_list_without_secret_403(self, http):
        r = http.get(f"{API}/admin/host-verifications")
        assert r.status_code == 403, r.text

    def test_admin_list_with_secret_includes_fresh(self, http, fresh):
        r = http.get(f"{API}/admin/host-verifications",
                     headers={"x-admin-secret": ADMIN_SECRET})
        assert r.status_code == 200, r.text
        ids = {d["user_id"] for d in r.json()}
        assert fresh["user"]["user_id"] in ids

    def test_admin_approve_sets_approved_and_host_verified(self, http, fresh):
        r = http.post(f"{API}/admin/host-verifications/{fresh['user']['user_id']}",
                      headers={"x-admin-secret": ADMIN_SECRET},
                      json={"approve": True, "note": ""})
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "approved"
        # /auth/me reflects it
        me = http.get(f"{API}/auth/me", headers=_hdr(fresh["token"]))
        assert me.status_code == 200, me.text
        assert me.json().get("host_verified") is True

    def test_second_approve_returns_404(self, http, fresh):
        r = http.post(f"{API}/admin/host-verifications/{fresh['user']['user_id']}",
                      headers={"x-admin-secret": ADMIN_SECRET},
                      json={"approve": True, "note": ""})
        assert r.status_code == 404, r.text

    def test_verify_host_after_approved_400(self, http, fresh):
        files = {
            "id_document": ("id.png", io.BytesIO(PNG_BYTES), "image/png"),
            "selfie":      ("selfie.png", io.BytesIO(PNG_BYTES), "image/png"),
        }
        r = requests.post(f"{API}/me/verify-host",
                          headers={"Authorization": f"Bearer {fresh['token']}"},
                          files=files)
        assert r.status_code == 400, r.text
        assert "verified" in r.text.lower()
