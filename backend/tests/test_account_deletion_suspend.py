"""Store-review fixes: account deletion (DELETE /api/me) + admin suspend/unsuspend flow."""
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import requests


def _load_base():
    for line in Path("/app/frontend/.env").read_text().splitlines():
        if line.startswith("EXPO_PUBLIC_BACKEND_URL") or line.startswith("EXPO_BACKEND_URL"):
            return line.split("=", 1)[1].strip().strip('"').rstrip("/")
    raise RuntimeError("backend url not found")


API = f"{_load_base()}/api"
ADMIN_EMAIL, ADMIN_PW = "test@afterparty.app", "Test1234!"


def H(tok):
    return {"Authorization": f"Bearer {tok}"}


def register(name):
    email = f"test_{name.lower()}_{uuid.uuid4().hex[:8]}@afterparty.app"
    r = requests.post(f"{API}/auth/register", json={"email": email, "password": "Pass1234", "name": f"TEST_{name}", "dob": "1995-01-01"})
    if r.status_code == 429:
        pytest.skip("auth rate limited")
    assert r.status_code == 200, r.text
    d = r.json()
    return {"email": email, "token": d["token"], "user_id": d["user"]["user_id"]}


# ---------- Account deletion ----------
class TestAccountDeletion:
    @pytest.fixture(scope="class")
    def ctx(self):
        A, B = register("DelA"), register("DelB")
        parties = requests.get(f"{API}/parties", params={"city": "London"}, headers=H(A["token"])).json()
        upcoming = [p for p in parties if not p.get("is_host") and p.get("host_id") != A["user_id"]]
        assert upcoming, "no London parties to join"
        joined = None
        for p in upcoming:
            r = requests.post(f"{API}/parties/{p['party_id']}/join", json={"role": "chipin"}, headers=H(A["token"]))
            if r.status_code == 200:
                joined = r.json()
                break
        assert joined, "A could not join any party"
        starts = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
        r = requests.post(f"{API}/parties", headers=H(A["token"]), json={
            "title": "TEST_Del party", "city": "London", "area": "Hackney", "starts_at": starts})
        assert r.status_code in (200, 201), r.text
        a_party = r.json()
        r = requests.post(f"{API}/parties/{a_party['party_id']}/join", json={"role": "chipin"}, headers=H(B["token"]))
        assert r.status_code == 200, r.text
        r = requests.post(f"{API}/chats/{a_party['party_id']}", json={"text": "hello"}, headers=H(A["token"]))
        assert r.status_code in (200, 201), r.text
        # B view of joined party before delete
        before = requests.get(f"{API}/parties/{joined['party_id']}", headers=H(B["token"])).json()
        return {"A": A, "B": B, "joined": joined, "a_party": a_party, "before": before}

    def test_delete_without_token_401(self):
        assert requests.delete(f"{API}/me").status_code == 401

    def test_delete_me(self, ctx):
        r = requests.delete(f"{API}/me", headers=H(ctx["A"]["token"]))
        assert r.status_code == 200, r.text
        assert r.json() == {"deleted": True}
        ctx["deleted"] = True

    def test_token_rejected_after_delete(self, ctx):
        r = requests.get(f"{API}/auth/me", headers=H(ctx["A"]["token"]))
        assert r.status_code == 401
        assert "User not found" in r.text

    def test_login_fails_after_delete(self, ctx):
        r = requests.post(f"{API}/auth/login", json={"email": ctx["A"]["email"], "password": "Pass1234"})
        if r.status_code == 429:
            pytest.skip("rate limited")
        assert r.status_code in (401, 404)

    def test_removed_from_joined_party(self, ctx):
        p = requests.get(f"{API}/parties/{ctx['joined']['party_id']}", headers=H(ctx["B"]["token"])).json()
        ids = [a.get("user_id") for a in p.get("attendees", [])]
        assert ctx["A"]["user_id"] not in ids
        assert p["going_count"] == ctx["before"]["going_count"] - 1, (p["going_count"], ctx["before"]["going_count"])

    def test_hosted_party_deleted(self, ctx):
        r = requests.get(f"{API}/parties/{ctx['a_party']['party_id']}", headers=H(ctx["B"]["token"]))
        assert r.status_code == 404

    def test_b_mine_no_longer_lists(self, ctx):
        mine = requests.get(f"{API}/parties/mine", headers=H(ctx["B"]["token"])).json()
        flat = mine if isinstance(mine, list) else [x for v in mine.values() if isinstance(v, list) for x in v]
        assert ctx["a_party"]["party_id"] not in [x.get("party_id") for x in flat]

    def test_cleanup_b(self, ctx):
        assert requests.delete(f"{API}/me", headers=H(ctx["B"]["token"])).status_code == 200


# ---------- Suspend / unsuspend ----------
class TestSuspend:
    @pytest.fixture(scope="class")
    def ctx(self):
        r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PW})
        if r.status_code == 429:
            pytest.skip("rate limited")
        assert r.status_code == 200, r.text
        admin = r.json()["token"]
        R, T = register("Reporter"), register("Target")
        r = requests.post(f"{API}/reports", json={"target_id": T["user_id"], "reason": "spam"}, headers=H(R["token"]))
        assert r.status_code == 201, r.text
        reps = requests.get(f"{API}/admin/reports", params={"status": "all"}, headers=H(admin)).json()
        rep = next(x for x in reps if x["target_id"] == T["user_id"] and x["status"] == "open")
        return {"admin": admin, "R": R, "T": T, "report_id": rep["report_id"]}

    def test_non_admin_cannot_list_reports(self, ctx):
        assert requests.get(f"{API}/admin/reports", headers=H(ctx["R"]["token"])).status_code in (401, 403)

    def test_resolve_suspend(self, ctx):
        r = requests.post(f"{API}/admin/reports/{ctx['report_id']}/resolve", json={"action": "suspend"}, headers=H(ctx["admin"]))
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "resolved"

    def test_suspended_gets_403(self, ctx):
        r = requests.get(f"{API}/auth/me", headers=H(ctx["T"]["token"]))
        assert r.status_code == 403
        assert "suspended" in r.text.lower()

    def test_unsuspend(self, ctx):
        r = requests.post(f"{API}/admin/users/{ctx['T']['user_id']}/unsuspend", headers=H(ctx["admin"]))
        assert r.status_code == 200 and r.json().get("ok") is True
        assert requests.get(f"{API}/auth/me", headers=H(ctx["T"]["token"])).status_code == 200

    def test_cleanup(self, ctx):
        for u in (ctx["R"], ctx["T"]):
            assert requests.delete(f"{API}/me", headers=H(u["token"])).status_code == 200
