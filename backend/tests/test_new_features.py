"""Tests for new features: Party Map (lat/lng/distance_km), Profile Photos,
Invite Links, and Safety (block/unblock/report).
Uses public preview URL from EXPO_PUBLIC_BACKEND_URL.
"""
import io
import os
import uuid
import struct
import zlib
import pytest
import requests
from pathlib import Path


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


def _tiny_png_bytes() -> bytes:
    # 1x1 red PNG, hand-constructed
    def _chunk(ctype, data):
        return (struct.pack(">I", len(data)) + ctype + data +
                struct.pack(">I", zlib.crc32(ctype + data) & 0xffffffff))

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = _chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
    raw = b"\x00\xff\x00\x00"  # filter + 1 pixel RGB red
    idat = _chunk(b"IDAT", zlib.compress(raw))
    iend = _chunk(b"IEND", b"")
    return sig + ihdr + idat + iend


# ---------------- shared session/user fixtures ----------------
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
    r = http.post(f"{API}/auth/login", json={"email": "kofi@demo.afterparty.app", "password": "demo1234"})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def zara(http):
    r = http.post(f"{API}/auth/login", json={"email": "zara@demo.afterparty.app", "password": "demo1234"})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def fresh_user(http):
    email = f"test_{uuid.uuid4().hex[:10]}@afterparty.app"
    r = http.post(f"{API}/auth/register",
                  json={"email": email, "password": "Test1234!", "name": "TEST_InviteGuest", "dob": "1998-01-01"})
    assert r.status_code == 200, r.text
    return r.json()


# ---------------- Party Map: lat/lng + distance_km ----------------
class TestPartyMap:
    def test_parties_have_lat_lng(self, http, test_user):
        r = http.get(f"{API}/parties?city=London", headers=_hdr(test_user["token"]))
        assert r.status_code == 200, r.text
        parties = r.json()
        assert len(parties) >= 1
        for p in parties:
            assert "lat" in p and "lng" in p
            assert isinstance(p["lat"], (int, float)), f"lat not number: {p['lat']!r}"
            assert isinstance(p["lng"], (int, float)), f"lng not number: {p['lng']!r}"

    def test_distance_km_null_without_coords(self, http, test_user):
        r = http.get(f"{API}/parties?city=London", headers=_hdr(test_user["token"]))
        for p in r.json():
            assert p["distance_km"] is None, f"expected null distance, got {p['distance_km']}"

    def test_distance_km_present_with_coords(self, http, test_user):
        r = http.get(f"{API}/parties?city=London&lat=51.5074&lng=-0.1278",
                     headers=_hdr(test_user["token"]))
        assert r.status_code == 200
        parties = r.json()
        assert len(parties) >= 1
        for p in parties:
            assert isinstance(p["distance_km"], (int, float)), \
                f"distance_km not numeric: {p['distance_km']!r}"
            assert p["distance_km"] >= 0


# ---------------- Profile Photos ----------------
class TestPhotoUpload:
    def test_upload_png_sets_picture_and_served(self, test_user):
        png = _tiny_png_bytes()
        files = {"file": ("tiny.png", png, "image/png")}
        # requests multipart without manual Content-Type JSON header
        r = requests.post(f"{API}/me/photo", files=files, headers=_hdr(test_user["token"]))
        assert r.status_code == 200, r.text
        body = r.json()
        assert "picture" in body
        pic = body["picture"]
        assert pic.startswith("/api/files/"), f"picture must start with /api/files/: {pic}"
        # fetch it back
        file_url = f"{BASE}{pic}"
        g = requests.get(file_url)
        assert g.status_code == 200, g.text
        assert g.headers.get("content-type", "").startswith("image/png"), \
            f"unexpected content-type: {g.headers.get('content-type')}"
        assert len(g.content) == len(png)

    def test_upload_wrong_content_type_400(self, test_user):
        files = {"file": ("not.txt", b"hello", "text/plain")}
        r = requests.post(f"{API}/me/photo", files=files, headers=_hdr(test_user["token"]))
        assert r.status_code == 400, r.text


# ---------------- Invite Links ----------------
class TestInvite:
    def test_host_invite_and_guest_accept(self, http, kofi, fresh_user):
        # host's parties
        r = http.get(f"{API}/parties/mine", headers=_hdr(kofi["token"]))
        assert r.status_code == 200
        mine = r.json()
        host_parties = [p for p in mine if p.get("is_host")]
        assert host_parties, "kofi should host at least one party"
        party = host_parties[0]
        pid = party["party_id"]

        # host gets invite code
        inv = http.get(f"{API}/parties/{pid}/invite", headers=_hdr(kofi["token"]))
        assert inv.status_code == 200, inv.text
        code = inv.json()["invite_code"]
        assert code and isinstance(code, str)

        # non-host 403
        other = http.get(f"{API}/parties/{pid}/invite", headers=_hdr(fresh_user["token"]))
        assert other.status_code == 403

        # preview
        pr = http.get(f"{API}/invites/{code}", headers=_hdr(fresh_user["token"]))
        assert pr.status_code == 200, pr.text
        assert pr.json()["party_id"] == pid

        # accept
        ac = http.post(f"{API}/invites/{code}/accept",
                       json={"role": "drinks"}, headers=_hdr(fresh_user["token"]))
        assert ac.status_code == 200, ac.text
        body = ac.json()
        assert body["attending"] is True
        assert body["address"] is not None, "address should be revealed after invite accept"

    def test_bad_invite_code_404(self, http, fresh_user):
        r = http.get(f"{API}/invites/doesnotexist123", headers=_hdr(fresh_user["token"]))
        assert r.status_code == 404


# ---------------- Safety: block/unblock/report ----------------
class TestSafety:
    def test_block_hides_from_discover_and_report_flow(self, http, test_user, zara):
        zara_id = zara["user"]["user_id"]

        # ensure clean state: unblock first (idempotent)
        http.delete(f"{API}/users/{zara_id}/block", headers=_hdr(test_user["token"]))

        # block
        b = http.post(f"{API}/users/{zara_id}/block", headers=_hdr(test_user["token"]))
        assert b.status_code == 201, b.text
        assert b.json()["blocked"] is True

        # /me/blocks includes zara
        g = http.get(f"{API}/me/blocks", headers=_hdr(test_user["token"]))
        assert g.status_code == 200
        ids = [u["user_id"] for u in g.json()]
        assert zara_id in ids

        # discover excludes zara
        d = http.get(f"{API}/discover", headers=_hdr(test_user["token"]))
        assert d.status_code == 200
        discover_ids = [u["user_id"] for u in d.json()]
        assert zara_id not in discover_ids

        # valid report
        rep = http.post(f"{API}/reports",
                        json={"target_id": zara_id, "reason": "spam", "details": "TEST_report"},
                        headers=_hdr(test_user["token"]))
        assert rep.status_code == 201, rep.text
        assert rep.json()["reported"] is True

        # invalid reason -> 422
        bad = http.post(f"{API}/reports",
                        json={"target_id": zara_id, "reason": "not_a_reason"},
                        headers=_hdr(test_user["token"]))
        assert bad.status_code == 422

        # unblock
        u = http.delete(f"{API}/users/{zara_id}/block", headers=_hdr(test_user["token"]))
        assert u.status_code == 200
        assert u.json()["blocked"] is False

        g2 = http.get(f"{API}/me/blocks", headers=_hdr(test_user["token"]))
        assert g2.status_code == 200
        ids2 = [x["user_id"] for x in g2.json()]
        assert zara_id not in ids2
