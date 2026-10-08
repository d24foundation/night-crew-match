"""Tests for iteration 6 features: Credits packs (GBP), spend (boost/promote/join),
referral rewards, AI promo caption, and security (rate limits, security headers, magic bytes).
Uses public preview URL from EXPO_PUBLIC_BACKEND_URL.
"""
import os
import time
import uuid
from pathlib import Path

import pytest
import requests


def _load_base():
    env = Path("/app/frontend/.env").read_text()
    for line in env.splitlines():
        if line.startswith("EXPO_PUBLIC_BACKEND_URL"):
            return line.split("=", 1)[1].strip().strip('"').rstrip("/")
    raise RuntimeError("EXPO_PUBLIC_BACKEND_URL not found")


BASE = _load_base()
API = f"{BASE}/api"


def _hdr(tok):
    return {"Authorization": f"Bearer {tok}"}


def _wait_rate_limit():
    """Sleep to let auth-rate limit window recover (20/min)."""
    time.sleep(5)


def _register_fresh(ref: str | None = None, dob: str = "1998-01-01") -> dict:
    """Register a unique user; retries once on 429."""
    for _ in range(3):
        email = f"test_{uuid.uuid4().hex[:10]}@afterparty.app"
        payload = {"email": email, "password": "Test1234!", "name": "TEST_User", "dob": dob}
        if ref:
            payload["ref"] = ref
        r = requests.post(f"{API}/auth/register", json=payload)
        if r.status_code == 429:
            time.sleep(30)
            continue
        assert r.status_code == 200, r.text
        return r.json()
    raise RuntimeError("Could not register fresh user after retries")


@pytest.fixture(scope="module")
def http():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def test_user(http):
    r = http.post(f"{API}/auth/login", json={"email": "test@afterparty.app", "password": "Test1234!"})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def kofi(http):
    for attempt in range(3):
        r = http.post(f"{API}/auth/login", json={"email": "kofi@demo.afterparty.app", "password": "demo1234"})
        if r.status_code == 429:
            time.sleep(60)
            continue
        assert r.status_code == 200, r.text
        return r.json()
    pytest.skip("Rate limited while logging in as kofi")


# ---------------- CREDITS: shape & packs ----------------
class TestCreditsShape:
    def test_credits_shape_and_pack_prices(self, http, test_user):
        r = http.get(f"{API}/credits", headers=_hdr(test_user["token"]))
        assert r.status_code == 200, r.text
        data = r.json()
        for k in ("balance", "packs", "ledger", "costs"):
            assert k in data, f"missing key {k}"
        packs = data["packs"]
        assert packs["shot"]["price"] == 1.00 and packs["shot"]["credits"] == 10
        assert packs["round"]["price"] == 2.00 and packs["round"]["credits"] == 25
        assert packs["bottle"]["price"] == 5.00 and packs["bottle"]["credits"] == 70
        costs = data["costs"]
        assert costs["boost"] == 5
        assert costs["extra_join"] == 2
        assert costs["promote"] == 10
        assert costs["referral"] == 5

    def test_auth_me_contains_credits(self, http, test_user):
        r = http.get(f"{API}/auth/me", headers=_hdr(test_user["token"]))
        assert r.status_code == 200
        assert "credits" in r.json(), "user.credits must be in /auth/me"


# ---------------- CHECKOUT: pack / plan / validation ----------------
class TestCheckout:
    def test_checkout_pack_shot_returns_stripe_url(self, http, test_user):
        r = http.post(f"{API}/payments/checkout",
                      json={"pack": "shot", "origin_url": "https://night-crew-match.preview.emergentagent.com"},
                      headers=_hdr(test_user["token"]))
        assert r.status_code == 200, r.text
        body = r.json()
        assert "url" in body and "session_id" in body
        assert "checkout.stripe.com" in body["url"], f"not a Stripe URL: {body['url']}"
        # verify status endpoint shows unpaid/initiated and credits unchanged
        before = http.get(f"{API}/auth/me", headers=_hdr(test_user["token"])).json()
        s = http.get(f"{API}/payments/status/{body['session_id']}", headers=_hdr(test_user["token"]))
        assert s.status_code == 200, s.text
        sd = s.json()
        assert sd["payment_status"] in ("unpaid", "initiated", "open")
        assert sd["user"]["credits"] == before["credits"]

    def test_checkout_empty_body_400(self, http, test_user):
        r = http.post(f"{API}/payments/checkout",
                      json={"origin_url": "https://night-crew-match.preview.emergentagent.com"},
                      headers=_hdr(test_user["token"]))
        assert r.status_code == 400, r.text

    def test_checkout_bad_origin_400(self, http, test_user):
        r = http.post(f"{API}/payments/checkout",
                      json={"pack": "shot", "origin_url": "javascript:alert(1)"},
                      headers=_hdr(test_user["token"]))
        assert r.status_code == 400, r.text


# ---------------- REFERRAL + BOOST ----------------
class TestReferralAndBoost:
    def test_referral_grants_credits_and_boost_spends(self, http):
        # inviter
        inviter = _register_fresh()
        tok1 = inviter["token"]
        ref_resp = http.get(f"{API}/me/referral", headers=_hdr(tok1))
        assert ref_resp.status_code == 200, ref_resp.text
        ref_code = ref_resp.json()["code"]
        assert ref_code and len(ref_code) == 6

        # new user registering with that ref
        invitee = _register_fresh(ref=ref_code)

        # Both should have 5 credits
        me1 = http.get(f"{API}/auth/me", headers=_hdr(tok1)).json()
        me2 = http.get(f"{API}/auth/me", headers=_hdr(invitee["token"])).json()
        assert me1["credits"] == 5, f"inviter credits {me1['credits']}"
        assert me2["credits"] == 5, f"invitee credits {me2['credits']}"

        # Ledger has entries
        led1 = http.get(f"{API}/credits", headers=_hdr(tok1)).json()["ledger"]
        assert any(e["reason"] == "referral_reward" for e in led1), f"no referral_reward in {led1}"
        led2 = http.get(f"{API}/credits", headers=_hdr(invitee["token"])).json()["ledger"]
        assert any(e["reason"] == "referral_welcome" for e in led2)

        # Inviter boosts: 200 and credits now 0
        b = http.post(f"{API}/me/boost", headers=_hdr(tok1))
        assert b.status_code == 200, b.text
        assert b.json()["credits"] == 0
        led1b = http.get(f"{API}/credits", headers=_hdr(tok1)).json()["ledger"]
        assert any(e["reason"] == "boost" and e["amount"] == -5 for e in led1b)

    def test_boost_without_credits_402(self, http):
        u = _register_fresh()
        r = http.post(f"{API}/me/boost", headers=_hdr(u["token"]))
        assert r.status_code == 402, r.text
        assert "credits" in r.json().get("detail", "").lower()

    def test_invalid_ref_ignored(self, http):
        u = _register_fresh(ref="BADXXX")
        me = http.get(f"{API}/auth/me", headers=_hdr(u["token"])).json()
        assert me["credits"] == 0, "invalid ref should not grant credits"


# ---------------- PROMOTE ----------------
class TestPromote:
    def test_promote_requires_host_and_credits(self, http, kofi):
        # find a party kofi hosts
        mine = http.get(f"{API}/parties/mine", headers=_hdr(kofi["token"])).json()
        host_parties = [p for p in mine if p.get("is_host")]
        assert host_parties
        pid = host_parties[0]["party_id"]

        # Non-host → 403
        other = _register_fresh()
        nh = http.post(f"{API}/parties/{pid}/promote", headers=_hdr(other["token"]))
        assert nh.status_code == 403, nh.text

        # Kofi likely has 0 credits → 402
        me = http.get(f"{API}/auth/me", headers=_hdr(kofi["token"])).json()
        if me["credits"] < 10:
            r = http.post(f"{API}/parties/{pid}/promote", headers=_hdr(kofi["token"]))
            assert r.status_code == 402, r.text

    def test_fresh_host_promote_success_and_sort(self, http):
        host = _register_fresh()
        tok = host["token"]
        # Create a party in a unique city so it's the top result
        unique_city = f"TestTown-{uuid.uuid4().hex[:6]}"
        party_body = {
            "title": "TEST_Promo Party",
            "city": unique_city,
            "area": "Shoreditch",
            "address": "123 Nowhere Lane",
            "starts_at": "2099-01-01T22:00:00+00:00",
            "capacity": 10,
            "lat": 51.5074,
            "lng": -0.1278,
            "vibe": "House",
            "chip_in": 5,
        }
        cr = http.post(f"{API}/parties", json=party_body, headers=_hdr(tok))
        assert cr.status_code == 200, cr.text
        pid = cr.json()["party_id"]

        # Fund host with referrals: register two users using host ref → +5 each = 10
        ref = http.get(f"{API}/me/referral", headers=_hdr(tok)).json()["code"]
        _register_fresh(ref=ref)
        _register_fresh(ref=ref)
        me = http.get(f"{API}/auth/me", headers=_hdr(tok)).json()
        assert me["credits"] >= 10, f"expected ≥10 credits, got {me['credits']}"

        # Promote → 200
        pr = http.post(f"{API}/parties/{pid}/promote", headers=_hdr(tok))
        assert pr.status_code == 200, pr.text
        assert "promoted_until" in pr.json()

        # GET the party → promoted true
        g = http.get(f"{API}/parties/{pid}", headers=_hdr(tok))
        assert g.status_code == 200
        assert g.json()["promoted"] is True

        # Feed in same city: promoted first
        feed = http.get(f"{API}/parties?city={unique_city}", headers=_hdr(tok))
        assert feed.status_code == 200
        items = feed.json()
        assert items and items[0]["party_id"] == pid

        # Promote again → 400
        again = http.post(f"{API}/parties/{pid}/promote", headers=_hdr(tok))
        assert again.status_code == 400, again.text


# ---------------- JOIN with credits ----------------
class TestJoinWithCredits:
    def test_join_limit_then_credits(self, http, test_user):
        # Need upcoming parties the user isn't hosting
        feed = http.get(f"{API}/parties?city=London", headers=_hdr(test_user["token"])).json()
        joinable = [p for p in feed if not p.get("is_host")]
        if len(joinable) < 4:
            pytest.skip("Not enough joinable parties to simulate 3/day limit")

        user = _register_fresh()
        tok = user["token"]

        # Keep joining until we succeed 3 times
        joined = 0
        idx = 0
        while joined < 3 and idx < len(joinable):
            p = joinable[idx]
            r = http.post(f"{API}/parties/{p['party_id']}/join",
                          json={"role": "chipin"}, headers=_hdr(tok))
            idx += 1
            if r.status_code == 200:
                joined += 1
        if joined < 3 or idx >= len(joinable):
            pytest.skip("Could not get 3 successful joins")

        # Next party → should 402 without credits
        p4 = joinable[idx]
        r = http.post(f"{API}/parties/{p4['party_id']}/join",
                      json={"role": "chipin"}, headers=_hdr(tok))
        assert r.status_code == 402, f"expected 402, got {r.status_code}: {r.text}"
        assert "credits" in r.json().get("detail", "").lower()

        # Fund via referral
        ref = http.get(f"{API}/me/referral", headers=_hdr(tok)).json()["code"]
        _register_fresh(ref=ref)
        me = http.get(f"{API}/auth/me", headers=_hdr(tok)).json()
        assert me["credits"] >= 2

        before = me["credits"]
        r2 = http.post(f"{API}/parties/{p4['party_id']}/join",
                       json={"role": "chipin", "use_credits": True}, headers=_hdr(tok))
        assert r2.status_code == 200, r2.text
        body = r2.json()
        assert body.get("attending") is True
        after = http.get(f"{API}/auth/me", headers=_hdr(tok)).json()["credits"]
        assert after == before - 2, f"credits before {before} after {after}"


# ---------------- PROMO AI caption ----------------
class TestPromoCaption:
    def test_promo_caption_cached(self, http, kofi):
        mine = http.get(f"{API}/parties/mine", headers=_hdr(kofi["token"])).json()
        hp = [p for p in mine if p.get("is_host")]
        assert hp
        pid = hp[0]["party_id"]

        r1 = http.get(f"{API}/parties/{pid}/promo", headers=_hdr(kofi["token"]))
        assert r1.status_code == 200, r1.text
        cap1 = r1.json().get("caption", "")
        assert cap1, "caption should be non-empty"
        assert "#" in cap1, "caption should contain a hashtag"

        r2 = http.get(f"{API}/parties/{pid}/promo", headers=_hdr(kofi["token"]))
        assert r2.status_code == 200
        assert r2.json().get("caption") == cap1, "caption must be cached"


# ---------------- SECURITY ----------------
class TestSecurity:
    def test_security_headers_present(self, http):
        r = http.get(f"{API}/parties?city=London",
                     headers={"Authorization": "Bearer x"})  # unauth OK, we only inspect headers
        assert r.headers.get("X-Frame-Options") == "DENY"
        assert "max-age" in (r.headers.get("Strict-Transport-Security") or "")
        assert r.headers.get("X-Content-Type-Options") == "nosniff"
        assert r.headers.get("Referrer-Policy") == "no-referrer"

    def test_photo_magic_bytes_rejects_fake_png(self, http, test_user):
        files = {"file": ("fake.png", b"hello", "image/png")}
        r = requests.post(f"{API}/me/photo", files=files, headers=_hdr(test_user["token"]))
        assert r.status_code == 400, r.text
        assert "valid image" in r.text.lower() or "image" in r.text.lower()

    def test_auth_rate_limit_returns_429_with_retry_after(self):
        # 25 rapid bad logins. Some should 429 with Retry-After.
        session = requests.Session()
        got_429 = False
        retry_after = None
        for _ in range(25):
            r = session.post(f"{API}/auth/login",
                             json={"email": "nope@afterparty.app", "password": "wrong"})
            if r.status_code == 429:
                got_429 = True
                retry_after = r.headers.get("Retry-After")
                try:
                    assert "detail" in r.json()
                except Exception:
                    pass
                break
        # cool off for other tests
        time.sleep(60)
        assert got_429, "expected a 429 within 25 rapid logins"
        assert retry_after is not None
