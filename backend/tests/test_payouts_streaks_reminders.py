"""Tests for iter-7 new features:
  - Host wallet & payouts (GET /wallet, PUT /wallet/payout-method, POST /wallet/payout)
  - Chip-in checkout (POST /payments/checkout with party_id)
  - party_view fields: my_paid, paid_count, collected
  - Smart reminders (GET /reminders/upcoming)
  - Weekend streaks (GET /me/streak, check-in → night recorded + streak credit + badge)

Uses the public preview URL from EXPO_PUBLIC_BACKEND_URL.
Note: /api/auth/* has 20/min per-IP rate limit — sleep 60s on 429.
"""
import time
import uuid
import pytest
import requests
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


def _hdr(tok: str):
    return {"Authorization": f"Bearer {tok}"}


def _post_with_retry(http, url, **kwargs):
    """Register/login with 429 backoff."""
    for _ in range(3):
        r = http.post(url, **kwargs)
        if r.status_code != 429:
            return r
        time.sleep(float(r.headers.get("Retry-After", 60)))
    return r


# ---------------- fixtures ----------------
@pytest.fixture(scope="module")
def http():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def test_user(http):
    r = _post_with_retry(http, f"{API}/auth/login",
                         json={"email": "test@afterparty.app", "password": "Test1234!"})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def kofi(http):
    r = _post_with_retry(http, f"{API}/auth/login",
                         json={"email": "kofi@demo.afterparty.app", "password": "demo1234"})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def fresh_user(http):
    email = f"test_{uuid.uuid4().hex[:10]}@afterparty.app"
    r = _post_with_retry(http, f"{API}/auth/register",
                         json={"email": email, "password": "Test1234!",
                               "name": "TEST_StreakUser", "dob": "1995-01-01"})
    assert r.status_code == 200, r.text
    return r.json()


# ---------------- Wallet ----------------
class TestWallet:
    def test_wallet_shape(self, http, test_user):
        r = http.get(f"{API}/wallet", headers=_hdr(test_user["token"]))
        assert r.status_code == 200, r.text
        d = r.json()
        assert isinstance(d["balance"], (int, float))
        assert d["fee_pct"] == 10
        assert d["min_payout"] == 5.0
        assert "ledger" in d and isinstance(d["ledger"], list)
        assert "payout_method" in d

    def test_set_payout_method_bank_masks_details(self, http, test_user):
        r = http.put(f"{API}/wallet/payout-method",
                     json={"method": "bank", "account_name": "Test User",
                           "details": "12-34-56 12345678"},
                     headers=_hdr(test_user["token"]))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["method"] == "bank"
        assert body["account_name"] == "Test User"
        masked = body["details_masked"]
        assert masked.endswith("5678")
        assert "•" in masked
        # GET /wallet reflects it
        g = http.get(f"{API}/wallet", headers=_hdr(test_user["token"])).json()
        assert g["payout_method"] is not None
        assert g["payout_method"]["method"] == "bank"
        assert g["payout_method"]["details_masked"].endswith("5678")

    def test_payout_short_details_422(self, http, test_user):
        r = http.put(f"{API}/wallet/payout-method",
                     json={"method": "bank", "account_name": "Test User", "details": "12"},
                     headers=_hdr(test_user["token"]))
        assert r.status_code == 422, r.text

    def test_payout_below_min_400(self, http, test_user):
        # Ensure payout method is set (previous test does this). Balance for test@ is 0.
        bal = http.get(f"{API}/wallet", headers=_hdr(test_user["token"])).json()["balance"]
        if bal >= 5.0:
            pytest.skip(f"balance >= 5 ({bal}), can't assert min error")
        r = http.post(f"{API}/wallet/payout", headers=_hdr(test_user["token"]))
        assert r.status_code == 400, r.text
        assert "Minimum" in r.text


# ---------------- Chip-in checkout ----------------
class TestChipinCheckout:
    def test_checkout_for_attended_party(self, http, test_user):
        # find an attended party with chip_in > 0
        r = http.get(f"{API}/parties/mine?attending=true", headers=_hdr(test_user["token"]))
        assert r.status_code == 200, r.text
        parties = r.json()
        candidate = next((p for p in parties if p.get("chip_in", 0) > 0 and not p.get("is_host")
                          and not p.get("my_paid")), None)
        if not candidate:
            pytest.skip("test@ has no attended party with chip_in>0 and unpaid")
        r = http.post(f"{API}/payments/checkout",
                      json={"party_id": candidate["party_id"], "origin_url": BASE},
                      headers=_hdr(test_user["token"]))
        assert r.status_code == 200, r.text
        d = r.json()
        assert "checkout.stripe.com" in d["url"]
        assert d["session_id"]

    def test_checkout_non_attended_403(self, http, test_user):
        # Find a party test@ does NOT attend and not host
        r = http.get(f"{API}/parties?city=London", headers=_hdr(test_user["token"]))
        parties = r.json()
        candidate = next((p for p in parties if not p.get("attending") and not p.get("is_host")
                          and p.get("chip_in", 0) > 0), None)
        if not candidate:
            pytest.skip("no non-attended party with chip_in>0 available")
        r = http.post(f"{API}/payments/checkout",
                      json={"party_id": candidate["party_id"], "origin_url": BASE},
                      headers=_hdr(test_user["token"]))
        assert r.status_code == 403, r.text

    def test_checkout_unknown_party_404(self, http, test_user):
        r = http.post(f"{API}/payments/checkout",
                      json={"party_id": "party_nope", "origin_url": BASE},
                      headers=_hdr(test_user["token"]))
        assert r.status_code == 404, r.text


# ---------------- party_view fields: my_paid, paid_count, collected ----------------
class TestPartyViewPaymentFields:
    def test_non_host_sees_my_paid_and_paid_count(self, http, test_user):
        r = http.get(f"{API}/parties?city=London", headers=_hdr(test_user["token"]))
        for p in r.json():
            if not p.get("is_host") and p.get("attending"):
                d = http.get(f"{API}/parties/{p['party_id']}", headers=_hdr(test_user["token"])).json()
                assert "my_paid" in d
                assert isinstance(d["my_paid"], bool)
                assert "paid_count" in d
                assert isinstance(d["paid_count"], int)
                assert d["collected"] is None, f"non-host must not see collected, got {d['collected']}"
                return
        pytest.skip("test@ has no non-host attended party")

    def test_host_sees_collected(self, http, kofi):
        r = http.get(f"{API}/parties/mine", headers=_hdr(kofi["token"]))
        hosted = [p for p in r.json() if p.get("is_host")]
        assert hosted, "kofi should host at least one party"
        d = http.get(f"{API}/parties/{hosted[0]['party_id']}", headers=_hdr(kofi["token"])).json()
        assert d["is_host"] is True
        assert isinstance(d["collected"], (int, float))
        assert isinstance(d["paid_count"], int)
        assert d["my_paid"] is False  # host is not a chip-in payer


# ---------------- Smart reminders ----------------
class TestReminders:
    def test_upcoming_30min_included_5h_excluded(self, http, kofi):
        # Party in +30 min (within 90m window)
        starts_soon = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()
        payload = {"title": f"TEST_Reminder_{uuid.uuid4().hex[:6]}", "description": "soon",
                   "city": "London", "area": "Test", "address": "1 Soon Rd", "vibe": "House",
                   "starts_at": starts_soon, "house_provided": True,
                   "drinks_needed": 1, "chip_in": 0, "capacity": 10}
        r = http.post(f"{API}/parties", json=payload, headers=_hdr(kofi["token"]))
        assert r.status_code == 200, r.text
        pid_soon = r.json()["party_id"]

        # Party in +5h (outside 90m window)
        starts_far = (datetime.now(timezone.utc) + timedelta(hours=5)).isoformat()
        payload_far = dict(payload, starts_at=starts_far, title=f"TEST_Far_{uuid.uuid4().hex[:6]}")
        r2 = http.post(f"{API}/parties", json=payload_far, headers=_hdr(kofi["token"]))
        assert r2.status_code == 200
        pid_far = r2.json()["party_id"]

        up = http.get(f"{API}/reminders/upcoming", headers=_hdr(kofi["token"]))
        assert up.status_code == 200, up.text
        items = up.json()
        ids = [p["party_id"] for p in items]
        assert pid_soon in ids, f"soon party missing: {ids}"
        assert pid_far not in ids, f"far party should NOT be in upcoming: {ids}"
        soon = next(p for p in items if p["party_id"] == pid_soon)
        assert "minutes_until" in soon
        assert 20 <= soon["minutes_until"] <= 40, f"unexpected minutes_until={soon['minutes_until']}"


# ---------------- Streak ----------------
def _last_saturday_23utc() -> str:
    """ISO timestamp of the most recent Saturday at 23:00 UTC (strictly in the past)."""
    n = datetime.now(timezone.utc)
    # weekday: Mon=0..Sat=5..Sun=6
    delta = (n.weekday() - 5) % 7
    sat = (n - timedelta(days=delta)).replace(hour=23, minute=0, second=0, microsecond=0)
    if sat >= n:
        sat = sat - timedelta(days=7)
    return sat.isoformat()


def _last_wednesday_22utc() -> str:
    n = datetime.now(timezone.utc)
    delta = (n.weekday() - 2) % 7
    wed = (n - timedelta(days=delta)).replace(hour=22, minute=0, second=0, microsecond=0)
    if wed >= n:
        wed = wed - timedelta(days=7)
    return wed.isoformat()


class TestStreak:
    def test_fresh_user_initial_streak(self, http, fresh_user):
        r = http.get(f"{API}/me/streak", headers=_hdr(fresh_user["token"]))
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["current"] == 0
        assert d["best"] == 0
        assert d["nights"] == 0
        assert d["next_reward"] == 1
        badges = d["badges"]
        assert len(badges) == 4
        for b in badges:
            assert b["unlocked"] is False
            assert b["at"] in (1, 3, 6, 10)

    def test_checkin_on_weekend_awards_night_and_badge(self, http, kofi, fresh_user):
        # Kofi hosts a party on last Saturday 23:00 UTC
        starts_at = _last_saturday_23utc()
        payload = {"title": f"TEST_Streak_{uuid.uuid4().hex[:6]}", "description": "weekend",
                   "city": "London", "area": "Test", "address": "9 Streak Rd", "vibe": "House",
                   "starts_at": starts_at, "house_provided": True,
                   "drinks_needed": 1, "chip_in": 0, "capacity": 10}
        r = http.post(f"{API}/parties", json=payload, headers=_hdr(kofi["token"]))
        assert r.status_code == 200, r.text
        pid = r.json()["party_id"]

        # fresh_user joins (chipin). Fresh users have unused 3-join limit.
        jr = http.post(f"{API}/parties/{pid}/join", json={"role": "chipin"},
                       headers=_hdr(fresh_user["token"]))
        assert jr.status_code == 200, jr.text

        # fresh gets ticket
        tk = http.get(f"{API}/parties/{pid}/ticket", headers=_hdr(fresh_user["token"]))
        assert tk.status_code == 200, tk.text
        qr = tk.json()["qr"]

        # kofi checks in using QR
        ci = http.post(f"{API}/parties/{pid}/checkin", json={"code": qr},
                       headers=_hdr(kofi["token"]))
        assert ci.status_code == 200, ci.text
        assert ci.json()["ok"] is True

        # fresh_user streak now 1
        s = http.get(f"{API}/me/streak", headers=_hdr(fresh_user["token"])).json()
        assert s["current"] == 1, s
        assert s["nights"] == 1
        assert s["best"] == 1
        badge1 = next(b for b in s["badges"] if b["at"] == 1)
        assert badge1["unlocked"] is True

        # Credits ledger has 'streak' reason, balance 1
        cr = http.get(f"{API}/credits", headers=_hdr(fresh_user["token"])).json()
        assert cr["balance"] == 1, cr
        reasons = [e.get("reason") for e in cr["ledger"]]
        assert "streak" in reasons, reasons

        # Idempotent check-in → night not added
        ci2 = http.post(f"{API}/parties/{pid}/checkin", json={"code": qr},
                        headers=_hdr(kofi["token"]))
        assert ci2.status_code == 200
        assert ci2.json()["already"] is True
        s2 = http.get(f"{API}/me/streak", headers=_hdr(fresh_user["token"])).json()
        assert s2["nights"] == 1, "idempotent check-in must not add another night"

        # Rating the same party must not add a second night either
        rr = http.post(f"{API}/parties/{pid}/rate", json={"stars": 5},
                       headers=_hdr(fresh_user["token"]))
        assert rr.status_code == 200, rr.text
        s3 = http.get(f"{API}/me/streak", headers=_hdr(fresh_user["token"])).json()
        assert s3["nights"] == 1, "rating same weekend party must not add another night"

    def test_wednesday_checkin_no_streak(self, http, kofi):
        """A party starting on a Wednesday is not a weekend night → no night recorded."""
        # fresh user just for this test to isolate night count
        email = f"test_wed_{uuid.uuid4().hex[:8]}@afterparty.app"
        r = _post_with_retry(http, f"{API}/auth/register",
                             json={"email": email, "password": "Test1234!",
                                   "name": "TEST_Wed", "dob": "1995-01-01"})
        assert r.status_code == 200, r.text
        wed_user = r.json()

        starts_at = _last_wednesday_22utc()
        payload = {"title": f"TEST_Wed_{uuid.uuid4().hex[:6]}", "description": "weekday",
                   "city": "London", "area": "Test", "address": "9 Wed Rd", "vibe": "House",
                   "starts_at": starts_at, "house_provided": True,
                   "drinks_needed": 1, "chip_in": 0, "capacity": 10}
        cr = http.post(f"{API}/parties", json=payload, headers=_hdr(kofi["token"]))
        assert cr.status_code == 200, cr.text
        pid = cr.json()["party_id"]

        jr = http.post(f"{API}/parties/{pid}/join", json={"role": "chipin"},
                       headers=_hdr(wed_user["token"]))
        assert jr.status_code == 200, jr.text

        tk = http.get(f"{API}/parties/{pid}/ticket", headers=_hdr(wed_user["token"])).json()
        ci = http.post(f"{API}/parties/{pid}/checkin", json={"code": tk["qr"]},
                       headers=_hdr(kofi["token"]))
        assert ci.status_code == 200, ci.text

        s = http.get(f"{API}/me/streak", headers=_hdr(wed_user["token"])).json()
        assert s["nights"] == 0, f"weekday check-in must not add a night: {s}"
        assert s["current"] == 0
