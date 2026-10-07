from fastapi import FastAPI, APIRouter, HTTPException, Request, Depends, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from dotenv import load_dotenv
import math
import secrets
import requests
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import uuid
import random
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional, Literal
from datetime import datetime, timezone, timedelta
import bcrypt
import jwt
import httpx
from emergentintegrations.payments.stripe.checkout import StripeCheckout, CheckoutSessionRequest
from emergentintegrations.llm.chat import LlmChat, UserMessage, TextDelta, StreamDone
import json

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

client = AsyncIOMotorClient(os.environ['MONGO_URL'])
db = client[os.environ['DB_NAME']]
JWT_SECRET = os.environ['JWT_SECRET']
STRIPE_API_KEY = os.environ['STRIPE_API_KEY']

app = FastAPI()
api = APIRouter(prefix="/api")
logger = logging.getLogger("afterparty")
logging.basicConfig(level=logging.INFO)

PLANS = {"premium": 3.99, "super": 7.99}
FREE_JOINS_PER_DAY = 3
FREE_LIKES_PER_DAY = 25
COVERS = [
    "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=900",
    "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=900",
    "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=900",
    "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=900",
    "https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=900",
]


CITY_COORDS = {
    "London": (51.5074, -0.1278), "Manchester": (53.4808, -2.2426), "Ibiza": (38.9067, 1.4206), "Berlin": (52.52, 13.405),
    "Paris": (48.8566, 2.3522), "Amsterdam": (52.3676, 4.9041), "New York": (40.7128, -74.006), "Dubai": (25.2048, 55.2708), "Lagos": (6.5244, 3.3792),
}
AREA_COORDS = {
    "Hackney Wick": (51.5436, -0.0229), "Farringdon": (51.5203, -0.1053), "Brixton": (51.4613, -0.1156),
    "Northern Quarter": (53.4839, -2.2360), "San Antonio": (38.9807, 1.3030), "Kreuzberg": (52.4987, 13.4034),
}


def coords_for(city: str, area: str, lat: Optional[float] = None, lng: Optional[float] = None):
    if lat is not None and lng is not None:
        return lat, lng
    if area in AREA_COORDS:
        return AREA_COORDS[area]
    base = CITY_COORDS.get(city, CITY_COORDS["London"])
    # Rough area position: scatter within ~3km of the city centre so the map isn't one stacked pin
    return round(base[0] + random.uniform(-0.03, 0.03), 5), round(base[1] + random.uniform(-0.04, 0.04), 5)


def haversine_km(a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = math.radians(b_lat - a_lat), math.radians(b_lng - a_lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


# ---------------- Object storage (Emergent managed) ----------------
STORAGE_BASE = (os.environ.get("INTEGRATION_PROXY_URL") or "").strip() or "https://integrations.emergentagent.com"
STORAGE_URL = STORAGE_BASE.rstrip("/") + "/objstore/api/v1/storage"
STORAGE_APP = "after-party"
MAX_PHOTO_BYTES = 6 * 1024 * 1024
_storage_key: Optional[str] = None


def init_storage() -> str:
    global _storage_key
    if _storage_key:
        return _storage_key
    resp = requests.post(f"{STORAGE_URL}/init", json={"emergent_key": os.environ.get("EMERGENT_LLM_KEY")}, timeout=30)
    resp.raise_for_status()
    _storage_key = resp.json()["storage_key"]
    return _storage_key


def put_object(path: str, data: bytes, content_type: str) -> dict:
    global _storage_key
    resp = requests.put(f"{STORAGE_URL}/objects/{path}", headers={"X-Storage-Key": init_storage(), "Content-Type": content_type}, data=data, timeout=120)
    if resp.status_code == 503:
        _storage_key = None
        resp = requests.put(f"{STORAGE_URL}/objects/{path}", headers={"X-Storage-Key": init_storage(), "Content-Type": content_type}, data=data, timeout=120)
    return resp


def get_object(path: str):
    global _storage_key
    resp = requests.get(f"{STORAGE_URL}/objects/{path}", headers={"X-Storage-Key": init_storage()}, timeout=60)
    if resp.status_code == 503:
        _storage_key = None
        resp = requests.get(f"{STORAGE_URL}/objects/{path}", headers={"X-Storage-Key": init_storage()}, timeout=60)
    return resp


def now() -> datetime:
    return datetime.now(timezone.utc)


def iso(d: datetime) -> str:
    return d.isoformat()


def parse_dt(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    d = datetime.fromisoformat(s)
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


RANK = {"free": 0, "premium": 1, "super": 2}


def effective_tier(u: dict) -> str:
    exp = parse_dt(u.get("tier_expires"))
    tier = u["tier"] if u.get("tier") in PLANS and exp and exp > now() else "free"
    store = u.get("_store_tier", "free")
    return store if RANK[store] > RANK[tier] else tier


def public_user(u: dict, me: bool = False) -> dict:
    tier = effective_tier(u)
    out = {
        "user_id": u["user_id"], "name": u.get("name", ""), "picture": u.get("picture"),
        "city": u.get("city", "London"), "bio": u.get("bio", ""), "age": u.get("age"),
        "vibes": u.get("vibes", []), "tier": tier, "verified": tier == "super",
        "boosted": bool(parse_dt(u.get("boosted_until")) and parse_dt(u.get("boosted_until")) > now()),
        "rating_avg": round(u["rating_sum"] / u["rating_count"], 1) if u.get("rating_count") else None,
        "rating_count": u.get("rating_count", 0),
    }
    if me:
        out["email"] = u.get("email")
        out["tier_expires"] = u.get("tier_expires") if tier != "free" else None
        out["age_verified"] = bool(u.get("age_verified"))
    return out


# ---------------- Push (Emergent managed) ----------------
PUSH_BASE_URL = "https://integrations.emergentagent.com"
_push_client = httpx.AsyncClient(base_url=PUSH_BASE_URL, headers={"X-Push-Key": os.environ.get("EMERGENT_PUSH_KEY", "placeholder")}, timeout=10.0)


class RegisterPushBody(BaseModel):
    user_id: str
    platform: str
    device_token: str


async def _push_user(request: Request) -> dict:
    return await current_user(request)  # resolved lazily (defined below)


@api.post("/register-push", status_code=201)
async def register_push(body: RegisterPushBody, u=Depends(_push_user)):
    if body.user_id != u["user_id"]:
        raise HTTPException(403, "Wrong user")
    resp = await _push_client.post("/api/v1/push/users/register", json=body.model_dump())
    if resp.status_code == 401:
        raise HTTPException(500, "EMERGENT_PUSH_KEY missing or invalid")
    if resp.status_code >= 500:
        raise HTTPException(502, "Push provider unavailable")
    resp.raise_for_status()
    return {"status": "registered"}


async def send_push(recipients: List[str], data: dict) -> None:
    recipients = [r for r in recipients if r]
    for i in range(0, len(recipients), 100):
        resp = await _push_client.post("/api/v1/push/trigger", json={"recipients": recipients[i:i + 100], "data": data})
        resp.raise_for_status()


async def notify(recipients: List[str], data: dict):
    try:
        await send_push(recipients, data)
    except Exception as e:
        logger.warning("Push failed (non-blocking): %s", e)


# ---------------- Auth ----------------
def make_token(user_id: str) -> str:
    return jwt.encode({"sub": user_id, "exp": now() + timedelta(days=30), "iat": now()}, JWT_SECRET, algorithm="HS256")


async def current_user(request: Request) -> dict:
    h = request.headers.get("Authorization", "")
    if not h.startswith("Bearer "):
        raise HTTPException(401, "Not authenticated")
    try:
        payload = jwt.decode(h[7:], JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(401, "Invalid or expired token")
    u = await db.users.find_one({"user_id": payload["sub"]}, {"_id": 0})
    if not u:
        raise HTTPException(401, "User not found")
    # In-app (RevenueCat) entitlement reported by the client SDK
    st = request.headers.get("X-Store-Tier")
    if st in PLANS:
        u["_store_tier"] = st
    return u


class RegisterIn(BaseModel):
    email: str
    password: str = Field(min_length=6)
    name: str = Field(min_length=1, max_length=40)
    dob: str  # YYYY-MM-DD, must be 18+


def age_from_dob(dob: str) -> int:
    try:
        d = datetime.strptime(dob, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(400, "Enter your birthday as YYYY-MM-DD")
    t = now().date()
    age = t.year - d.year - ((t.month, t.day) < (d.month, d.day))
    if age < 18:
        raise HTTPException(403, "After Party is 18+ only")
    if age > 100:
        raise HTTPException(400, "Check your birthday")
    return age


class LoginIn(BaseModel):
    email: str
    password: str


class SessionIn(BaseModel):
    session_id: str


@api.post("/auth/register")
async def register(body: RegisterIn):
    email = body.email.strip().lower()
    if "@" not in email:
        raise HTTPException(400, "Invalid email")
    if await db.users.find_one({"email": email}):
        raise HTTPException(409, "Account already exists")
    age = age_from_dob(body.dob)
    u = {"user_id": new_id("user"), "email": email, "name": body.name.strip(), "dob": body.dob, "age": age, "age_verified": True,
         "password_hash": bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode(),
         "city": "London", "bio": "", "vibes": [], "tier": "free", "created_at": iso(now())}
    await db.users.insert_one(u)
    return {"token": make_token(u["user_id"]), "user": public_user(u, True)}


@api.post("/auth/login")
async def login(body: LoginIn):
    u = await db.users.find_one({"email": body.email.strip().lower()}, {"_id": 0})
    if not u or not u.get("password_hash") or not bcrypt.checkpw(body.password.encode(), u["password_hash"].encode()):
        raise HTTPException(401, "Invalid email or password")
    return {"token": make_token(u["user_id"]), "user": public_user(u, True)}


@api.post("/auth/session")
async def google_session(body: SessionIn):
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get("https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data",
                        headers={"X-Session-ID": body.session_id})
    if r.status_code != 200:
        raise HTTPException(401, "Invalid session")
    data = r.json()
    email = data["email"].lower()
    u = await db.users.find_one({"email": email}, {"_id": 0})
    if not u:
        u = {"user_id": new_id("user"), "email": email, "name": data.get("name", "Raver"),
             "picture": data.get("picture"), "city": "London", "bio": "", "vibes": [],
             "tier": "free", "created_at": iso(now())}
        await db.users.insert_one(dict(u))
    elif not u.get("picture") and data.get("picture"):
        await db.users.update_one({"user_id": u["user_id"]}, {"$set": {"picture": data["picture"]}})
        u["picture"] = data["picture"]
    return {"token": make_token(u["user_id"]), "session_token": make_token(u["user_id"]), "user": public_user(u, True)}


class AppleIn(BaseModel):
    identity_token: str
    name: Optional[str] = None
    email: Optional[str] = None


_apple_jwks = jwt.PyJWKClient("https://appleid.apple.com/auth/keys")


@api.post("/auth/apple")
async def apple_login(body: AppleIn):
    audiences = [a.strip() for a in os.environ["APPLE_AUDIENCES"].split(",") if a.strip()]
    try:
        key = _apple_jwks.get_signing_key_from_jwt(body.identity_token).key
        claims = jwt.decode(body.identity_token, key, algorithms=["RS256"], audience=audiences,
                            issuer="https://appleid.apple.com")
    except Exception as e:
        logger.warning("apple verify failed: %s", e)
        raise HTTPException(401, "Invalid Apple token")
    sub = claims["sub"]
    email = (claims.get("email") or body.email or "").lower() or None
    u = await db.users.find_one({"apple_sub": sub}, {"_id": 0})
    if not u and email:
        u = await db.users.find_one({"email": email}, {"_id": 0})
        if u:
            await db.users.update_one({"user_id": u["user_id"]}, {"$set": {"apple_sub": sub}})
    if not u:
        u = {"user_id": new_id("user"), "apple_sub": sub, "email": email or f"{sub}@apple.afterparty.app",
             "name": (body.name or "Raver").strip(), "city": "London", "bio": "", "vibes": [],
             "tier": "free", "created_at": iso(now())}
        await db.users.insert_one(dict(u))
    return {"token": make_token(u["user_id"]), "session_token": make_token(u["user_id"]), "user": public_user(u, True)}


# ---------------- AI (Gemini) ----------------
class HypeIn(BaseModel):
    vibe: str = "House"
    city: str = "London"
    area: str = ""
    house_provided: bool = True


async def gemini(system: str, prompt: str, session: str) -> str:
    chat = LlmChat(api_key=os.environ["EMERGENT_LLM_KEY"], session_id=session, system_message=system).with_model("gemini", "gemini-3-flash-preview")
    out = ""
    async for ev in chat.stream_message(UserMessage(text=prompt)):
        if isinstance(ev, TextDelta):
            out += ev.content
        elif isinstance(ev, StreamDone):
            break
    return out.strip()


@api.post("/ai/party-hype")
async def party_hype(body: HypeIn, u=Depends(current_user)):
    sys = ("You write viral, catchy after-party listings for a nightlife app. UK slang welcome, fun, inclusive, no emojis overload "
           "(max 2), never mention drugs. Reply ONLY with JSON: {\"title\": <max 40 chars>, \"description\": <max 220 chars>}.")
    prompt = f"Vibe: {body.vibe}. City: {body.city}. Area: {body.area or 'secret'}. House {'is sorted' if body.house_provided else 'still needed'}. Guests bring drinks and chip in."
    try:
        raw = await gemini(sys, prompt, f"hype_{u['user_id']}_{uuid.uuid4().hex[:6]}")
        data = json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
        return {"title": str(data.get("title", ""))[:60], "description": str(data.get("description", ""))[:400]}
    except Exception as e:
        logger.warning("party hype failed: %s", e)
        raise HTTPException(502, "AI is busy, try again")


@api.post("/ai/icebreaker/{match_id}")
async def icebreaker(match_id: str, u=Depends(current_user)):
    m = await db.matches.find_one({"match_id": match_id, "users": u["user_id"]}, {"_id": 0})
    if not m:
        raise HTTPException(404, "Match not found")
    other = await db.users.find_one({"user_id": next(x for x in m["users"] if x != u["user_id"])}, {"_id": 0})
    sys = "You are a cheeky but respectful wingman for an after-party app. Write ONE short opening message (max 140 chars), plain text, no quotes."
    prompt = (f"Me: {u.get('name')}, vibes {u.get('vibes')}, bio '{u.get('bio', '')}'. "
              f"Them: {other.get('name')}, in {other.get('city')}, vibes {other.get('vibes')}, bio '{other.get('bio', '')}'.")
    try:
        text = await gemini(sys, prompt, f"ice_{match_id}_{uuid.uuid4().hex[:6]}")
        return {"text": text.strip('"')[:200]}
    except Exception as e:
        logger.warning("icebreaker failed: %s", e)
        raise HTTPException(502, "AI is busy, try again")


@api.post("/ai/vibe-match")
async def vibe_match(u=Depends(current_user)):
    city = u.get("city", "London")
    parties = await db.parties.find({"city": city, "starts_at": {"$gte": iso(now() - timedelta(hours=8))},
                                     "host_id": {"$ne": u["user_id"]}, "attendees.user_id": {"$ne": u["user_id"]}}, {"_id": 0}).to_list(30)
    if not parties:
        raise HTTPException(404, f"No open parties in {city} right now")
    listing = "\n".join(f"- id={p['party_id']} | {p['title']} | vibe {p['vibe']} | {p['area']} | {len(p['attendees']) + 1}/{p['capacity']} going | £{p['chip_in']} chip-in | {p['description'][:120]}" for p in parties)
    sys = ("You are the vibe matcher for an after-party app. Pick the ONE best party for the user. "
           "Reply ONLY with JSON: {\"party_id\": <id from list>, \"reason\": <max 120 chars, hype, second person>}.")
    prompt = f"User: {u.get('name')}, vibes {u.get('vibes') or 'open to anything'}, bio '{u.get('bio', '')}'.\nParties:\n{listing}"
    try:
        raw = await gemini(sys, prompt, f"vibe_{u['user_id']}_{uuid.uuid4().hex[:6]}")
        data = json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
        pick = next((p for p in parties if p["party_id"] == data.get("party_id")), parties[0])
        return {"party_id": pick["party_id"], "title": pick["title"], "cover": pick["cover"], "vibe": pick["vibe"],
                "area": pick["area"], "reason": str(data.get("reason", ""))[:200]}
    except Exception as e:
        logger.warning("vibe match failed: %s", e)
        raise HTTPException(502, "AI is busy, try again")


@api.get("/auth/me")
async def me(u=Depends(current_user)):
    return public_user(u, True)


class ProfileIn(BaseModel):
    name: Optional[str] = None
    bio: Optional[str] = Field(None, max_length=200)
    city: Optional[str] = None
    age: Optional[int] = Field(None, ge=18, le=99)
    vibes: Optional[List[str]] = None
    picture: Optional[str] = None


@api.put("/me")
async def update_me(body: ProfileIn, u=Depends(current_user)):
    upd = {k: v for k, v in body.model_dump().items() if v is not None}
    if upd:
        await db.users.update_one({"user_id": u["user_id"]}, {"$set": upd})
    u.update(upd)
    return public_user(u, True)


class AgeIn(BaseModel):
    dob: str


@api.post("/me/verify-age")
async def verify_age(body: AgeIn, u=Depends(current_user)):
    age = age_from_dob(body.dob)
    upd = {"dob": body.dob, "age": age, "age_verified": True}
    await db.users.update_one({"user_id": u["user_id"]}, {"$set": upd})
    u.update(upd)
    return public_user(u, True)


# ---------------- Ratings ----------------
class RateIn(BaseModel):
    stars: int = Field(ge=1, le=5)
    comment: str = Field("", max_length=300)


@api.post("/parties/{party_id}/rate")
async def rate_party(party_id: str, body: RateIn, u=Depends(current_user)):
    p = await db.parties.find_one({"party_id": party_id}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Party not found")
    if not any(a["user_id"] == u["user_id"] for a in p["attendees"]):
        raise HTTPException(403, "Only guests can rate this party")
    if parse_dt(p["starts_at"]) > now():
        raise HTTPException(400, "You can rate once the party has started")
    prev = await db.ratings.find_one({"party_id": party_id, "user_id": u["user_id"]}, {"_id": 0})
    await db.ratings.update_one({"party_id": party_id, "user_id": u["user_id"]},
                                {"$set": {"stars": body.stars, "comment": body.comment.strip(), "host_id": p["host_id"], "created_at": iso(now())}}, upsert=True)
    delta_sum, delta_n = (body.stars - prev["stars"], 0) if prev else (body.stars, 1)
    await db.users.update_one({"user_id": p["host_id"]}, {"$inc": {"rating_sum": delta_sum, "rating_count": delta_n}})
    if not prev:
        await notify([p["host_id"]], {"title": f"{'⭐' * body.stars} for {p['title']}", "message": f"{u.get('name')} rated your afters {body.stars}/5", "action_url": f"/party/{party_id}"})
    return {"stars": body.stars, "comment": body.comment.strip()}


@api.get("/ratings/pending")
async def pending_ratings(u=Depends(current_user)):
    since = iso(now() - timedelta(days=3))
    ps = await db.parties.find({"attendees.user_id": u["user_id"], "starts_at": {"$lte": iso(now()), "$gte": since}}, {"_id": 0}).sort("starts_at", -1).to_list(20)
    rated = set(await db.ratings.distinct("party_id", {"user_id": u["user_id"]}))
    out = [p for p in ps if p["party_id"] not in rated]
    hosts, users = await load_people(out)
    return [party_view(p, u, hosts, users) for p in out]


# ---------------- Check-in QR ----------------
class CheckinIn(BaseModel):
    code: str


@api.get("/parties/{party_id}/ticket")
async def my_ticket(party_id: str, u=Depends(current_user)):
    p = await db.parties.find_one({"party_id": party_id}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Party not found")
    att = next((a for a in p["attendees"] if a["user_id"] == u["user_id"]), None)
    if not att:
        raise HTTPException(403, "Join the party to get a door pass")
    code = att.get("ticket")
    if not code:
        code = secrets.token_hex(3).upper()
        await db.parties.update_one({"party_id": party_id, "attendees.user_id": u["user_id"]}, {"$set": {"attendees.$.ticket": code}})
    return {"code": code, "qr": f"afterparty:{party_id}:{code}", "checked_in": bool(att.get("checked_in_at")), "party_title": p["title"]}


@api.post("/parties/{party_id}/checkin")
async def checkin(party_id: str, body: CheckinIn, u=Depends(current_user)):
    p = await db.parties.find_one({"party_id": party_id}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Party not found")
    if p["host_id"] != u["user_id"]:
        raise HTTPException(403, "Only the host can check people in")
    raw = body.code.strip()
    code = raw.split(":")[-1].upper() if raw.lower().startswith("afterparty:") else raw.upper()
    if raw.lower().startswith("afterparty:") and raw.split(":")[1] != party_id:
        raise HTTPException(400, "That pass is for a different party")
    att = next((a for a in p["attendees"] if a.get("ticket") == code), None)
    if not att:
        raise HTTPException(404, "Pass not recognised — they haven't joined this party")
    guest = await db.users.find_one({"user_id": att["user_id"]}, {"_id": 0})
    if att.get("checked_in_at"):
        return {"ok": True, "already": True, "guest": public_user(guest), "checked_in_at": att["checked_in_at"]}
    ts = iso(now())
    await db.parties.update_one({"party_id": party_id, "attendees.user_id": att["user_id"]}, {"$set": {"attendees.$.checked_in_at": ts}})
    return {"ok": True, "already": False, "guest": public_user(guest), "checked_in_at": ts}


@api.post("/me/photo")
async def upload_photo(file: UploadFile = File(...), u=Depends(current_user)):
    ctype = (file.content_type or "").lower()
    if ctype not in ("image/jpeg", "image/png", "image/webp", "image/heic"):
        raise HTTPException(400, "Please upload a JPG, PNG or WebP photo")
    data = await file.read()
    if len(data) > MAX_PHOTO_BYTES:
        raise HTTPException(413, "Photo too large (max 6MB)")
    ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic"}[ctype]
    file_id = uuid.uuid4().hex
    path = f"{STORAGE_APP}/uploads/{u['user_id']}/{file_id}.{ext}"
    try:
        resp = await run_in_threadpool(put_object, path, data, ctype)
    except Exception as e:
        logger.warning("storage upload failed: %s", e)
        raise HTTPException(502, "Photo storage unavailable, try again")
    if resp.status_code == 402:
        raise HTTPException(402, "Photo storage credits exhausted")
    if resp.status_code >= 400:
        logger.warning("storage upload %s: %s", resp.status_code, resp.text[:200])
        raise HTTPException(502, "Photo upload failed, try again")
    await db.files.insert_one({"file_id": file_id, "owner_id": u["user_id"], "storage_path": path, "content_type": ctype,
                               "size": len(data), "public": True, "created_at": iso(now())})
    picture = f"/api/files/{file_id}"
    await db.users.update_one({"user_id": u["user_id"]}, {"$set": {"picture": picture}})
    u["picture"] = picture
    return public_user(u, True)


@api.get("/files/{file_id}")
async def get_file(file_id: str):
    f = await db.files.find_one({"file_id": file_id, "public": True}, {"_id": 0})
    if not f:
        raise HTTPException(404, "File not found")
    try:
        resp = await run_in_threadpool(get_object, f["storage_path"])
    except Exception as e:
        logger.warning("storage read failed: %s", e)
        raise HTTPException(502, "Storage unavailable")
    if resp.status_code >= 400:
        raise HTTPException(404, "File not found")
    return Response(content=resp.content, media_type=f["content_type"], headers={"Cache-Control": "public, max-age=86400, immutable"})


# ---------------- Safety: block / report ----------------
class ReportIn(BaseModel):
    target_id: str
    reason: Literal["harassment", "fake", "unsafe", "spam", "other"]
    details: str = Field("", max_length=500)
    context: Optional[str] = None  # chat_id or party_id


async def blocked_ids(uid: str) -> set:
    docs = await db.blocks.find({"$or": [{"user_id": uid}, {"blocked_id": uid}]}, {"_id": 0}).to_list(2000)
    return {d["blocked_id"] if d["user_id"] == uid else d["user_id"] for d in docs}


@api.post("/users/{target_id}/block", status_code=201)
async def block_user(target_id: str, u=Depends(current_user)):
    if target_id == u["user_id"]:
        raise HTTPException(400, "You can't block yourself")
    if not await db.users.find_one({"user_id": target_id}):
        raise HTTPException(404, "User not found")
    await db.blocks.update_one({"user_id": u["user_id"], "blocked_id": target_id}, {"$set": {"created_at": iso(now())}}, upsert=True)
    return {"blocked": True}


@api.delete("/users/{target_id}/block")
async def unblock_user(target_id: str, u=Depends(current_user)):
    await db.blocks.delete_one({"user_id": u["user_id"], "blocked_id": target_id})
    return {"blocked": False}


@api.get("/me/blocks")
async def my_blocks(u=Depends(current_user)):
    docs = await db.blocks.find({"user_id": u["user_id"]}, {"_id": 0}).to_list(500)
    ids = [d["blocked_id"] for d in docs]
    users = await db.users.find({"user_id": {"$in": ids}}, {"_id": 0}).to_list(500)
    return [public_user(x) for x in users]


@api.post("/reports", status_code=201)
async def report_user(body: ReportIn, u=Depends(current_user)):
    if body.target_id == u["user_id"]:
        raise HTTPException(400, "You can't report yourself")
    if not await db.users.find_one({"user_id": body.target_id}):
        raise HTTPException(404, "User not found")
    await db.reports.insert_one({"report_id": new_id("report"), "reporter_id": u["user_id"], **body.model_dump(),
                                 "status": "open", "created_at": iso(now())})
    return {"reported": True}


@api.post("/me/boost")
async def boost(u=Depends(current_user)):
    if effective_tier(u) == "free":
        raise HTTPException(402, "Boost is a Premium perk")
    until = now() + timedelta(minutes=60)
    await db.users.update_one({"user_id": u["user_id"]}, {"$set": {"boosted_until": iso(until)}})
    return {"boosted_until": iso(until)}


# ---------------- Parties ----------------
class PartyIn(BaseModel):
    title: str = Field(min_length=3, max_length=60)
    description: str = Field("", max_length=400)
    city: str
    area: str = Field(min_length=1, max_length=60)
    address: str = Field("", max_length=120)
    starts_at: str
    vibe: str = "House"
    house_provided: bool = True
    drinks_needed: int = Field(3, ge=0, le=50)
    chip_in: float = Field(5, ge=0, le=100)
    capacity: int = Field(15, ge=2, le=200)
    lat: Optional[float] = Field(None, ge=-90, le=90)
    lng: Optional[float] = Field(None, ge=-180, le=180)


class JoinIn(BaseModel):
    role: Literal["house", "drinks", "chipin"]


def party_view(p: dict, viewer: dict, hosts: dict, users: dict, me_pos: Optional[tuple] = None) -> dict:
    uid = viewer["user_id"]
    is_host = p["host_id"] == uid
    attending = any(a["user_id"] == uid for a in p.get("attendees", []))
    can_see = is_host or effective_tier(viewer) == "super"
    host = hosts.get(p["host_id"])
    atts = p.get("attendees", [])
    out = {k: p[k] for k in ["party_id", "title", "description", "city", "area", "starts_at", "vibe",
                             "house_provided", "drinks_needed", "chip_in", "capacity", "cover", "host_id"]}
    lat, lng = p.get("lat"), p.get("lng")
    out.update({
        "lat": lat, "lng": lng,
        "distance_km": round(haversine_km(me_pos[0], me_pos[1], lat, lng), 1) if (me_pos and lat is not None and lng is not None) else None,
        "invite_code": p.get("invite_code") if is_host else None,
        "host": public_user(host) if host else None,
        "going_count": len(atts) + 1,
        "drinks_count": sum(1 for a in atts if a["role"] == "drinks"),
        "chipin_count": sum(1 for a in atts if a["role"] == "chipin"),
        "is_host": is_host, "attending": attending,
        "my_role": next((a["role"] for a in atts if a["user_id"] == uid), None),
        "address": p.get("address") if (is_host or attending) else None,
        "can_see_attendees": can_see,
        "attendees": [dict(public_user(users[a["user_id"]]), role=a["role"], checked_in=bool(a.get("checked_in_at"))) for a in atts if a["user_id"] in users] if can_see else [],
        "checked_in_count": sum(1 for a in atts if a.get("checked_in_at")),
        "started": parse_dt(p["starts_at"]) <= now(),
        "attendee_pics": [users[a["user_id"]].get("picture") for a in atts[:4] if a["user_id"] in users],
    })
    return out


async def load_people(parties: List[dict]):
    ids = set()
    for p in parties:
        ids.add(p["host_id"])
        ids.update(a["user_id"] for a in p.get("attendees", []))
    docs = await db.users.find({"user_id": {"$in": list(ids)}}, {"_id": 0}).to_list(2000)
    m = {d["user_id"]: d for d in docs}
    return m, m


@api.get("/parties")
async def list_parties(city: Optional[str] = None, lat: Optional[float] = None, lng: Optional[float] = None, u=Depends(current_user)):
    q = {"starts_at": {"$gte": iso(now() - timedelta(hours=8))}}
    if city and city != "All":
        q["city"] = city
    blocked = await blocked_ids(u["user_id"])
    if blocked:
        q["host_id"] = {"$nin": list(blocked)}
    parties = await db.parties.find(q, {"_id": 0}).sort("starts_at", 1).to_list(200)
    hosts, users = await load_people(parties)
    me_pos = (lat, lng) if (lat is not None and lng is not None) else None
    views = [party_view(p, u, hosts, users, me_pos) for p in parties]
    # Host priority: Super Premium hosts float to the top
    views.sort(key=lambda v: 0 if (v["host"] and v["host"]["tier"] == "super") else 1)
    return views


@api.get("/parties/mine")
async def my_parties(u=Depends(current_user)):
    parties = await db.parties.find({"$or": [{"host_id": u["user_id"]}, {"attendees.user_id": u["user_id"]}]}, {"_id": 0}).sort("starts_at", 1).to_list(200)
    hosts, users = await load_people(parties)
    return [party_view(p, u, hosts, users) for p in parties]


@api.post("/parties")
async def create_party(body: PartyIn, u=Depends(current_user)):
    if not parse_dt(body.starts_at):
        raise HTTPException(400, "Invalid start time")
    p = body.model_dump()
    lat, lng = coords_for(body.city, body.area, body.lat, body.lng)
    p.update({"party_id": new_id("party"), "host_id": u["user_id"], "attendees": [], "lat": lat, "lng": lng,
              "invite_code": secrets.token_urlsafe(6), "cover": random.choice(COVERS), "created_at": iso(now())})
    await db.parties.insert_one(dict(p))
    hosts, users = await load_people([p])
    return party_view(p, u, hosts, users)


@api.get("/parties/{party_id}")
async def get_party(party_id: str, u=Depends(current_user)):
    p = await db.parties.find_one({"party_id": party_id}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Party not found")
    hosts, users = await load_people([p])
    return party_view(p, u, hosts, users)


async def do_join(p: dict, u: dict, role: str, invited: bool = False):
    party_id = p["party_id"]
    if p["host_id"] == u["user_id"]:
        raise HTTPException(400, "You're the host")
    if any(a["user_id"] == u["user_id"] for a in p["attendees"]):
        raise HTTPException(400, "Already going")
    if len(p["attendees"]) + 1 >= p["capacity"]:
        raise HTTPException(400, "Party is full")
    if p["host_id"] in await blocked_ids(u["user_id"]):
        raise HTTPException(403, "You can't join this party")
    if not invited and effective_tier(u) == "free":
        since = iso(now() - timedelta(hours=24))
        n = await db.parties.count_documents({"attendees": {"$elemMatch": {"user_id": u["user_id"], "joined_at": {"$gte": since}}}})
        if n >= FREE_JOINS_PER_DAY:
            raise HTTPException(402, f"Free plan: {FREE_JOINS_PER_DAY} joins per day. Go Premium for unlimited.")
    await db.parties.update_one({"party_id": party_id}, {"$push": {"attendees": {"user_id": u["user_id"], "role": role, "joined_at": iso(now()), "invited": invited}}})
    role_txt = {"drinks": "is bringing drinks", "chipin": "is chipping in", "house": "can offer a house"}[role]
    await notify([p["host_id"]], {"title": f"{u.get('name')} is down for {p['title']}", "message": f"{u.get('name')} {role_txt}{' (via your invite link)' if invited else ''}. Party's growing!", "action_url": f"/party/{party_id}"})
    return await get_party(party_id, u)


@api.post("/parties/{party_id}/join")
async def join_party(party_id: str, body: JoinIn, u=Depends(current_user)):
    p = await db.parties.find_one({"party_id": party_id}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Party not found")
    return await do_join(p, u, body.role)


@api.get("/parties/{party_id}/invite")
async def party_invite(party_id: str, u=Depends(current_user)):
    p = await db.parties.find_one({"party_id": party_id}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Party not found")
    if p["host_id"] != u["user_id"]:
        raise HTTPException(403, "Only the host can share the invite link")
    code = p.get("invite_code")
    if not code:
        code = secrets.token_urlsafe(6)
        await db.parties.update_one({"party_id": party_id}, {"$set": {"invite_code": code}})
    return {"invite_code": code, "party_id": party_id}


class InviteAcceptIn(BaseModel):
    role: Literal["house", "drinks", "chipin"] = "chipin"


@api.get("/invites/{code}")
async def invite_preview(code: str, u=Depends(current_user)):
    p = await db.parties.find_one({"invite_code": code}, {"_id": 0})
    if not p:
        raise HTTPException(404, "This invite link has expired")
    hosts, users = await load_people([p])
    return party_view(p, u, hosts, users)


@api.post("/invites/{code}/accept")
async def invite_accept(code: str, body: InviteAcceptIn, u=Depends(current_user)):
    p = await db.parties.find_one({"invite_code": code}, {"_id": 0})
    if not p:
        raise HTTPException(404, "This invite link has expired")
    if p["host_id"] == u["user_id"] or any(a["user_id"] == u["user_id"] for a in p["attendees"]):
        return await get_party(p["party_id"], u)
    return await do_join(p, u, body.role, invited=True)


@api.post("/parties/{party_id}/leave")
async def leave_party(party_id: str, u=Depends(current_user)):
    await db.parties.update_one({"party_id": party_id}, {"$pull": {"attendees": {"user_id": u["user_id"]}}})
    return await get_party(party_id, u)


# ---------------- Swipe / Matches ----------------
class SwipeIn(BaseModel):
    target_id: str
    like: bool


@api.get("/discover")
async def discover(u=Depends(current_user)):
    swiped = await db.swipes.distinct("target_id", {"user_id": u["user_id"]})
    excluded = set(swiped) | {u["user_id"]} | await blocked_ids(u["user_id"])
    docs = await db.users.find({"user_id": {"$nin": list(excluded)}}, {"_id": 0}).to_list(100)
    city = u.get("city", "London")
    people = [public_user(d) for d in docs]
    people.sort(key=lambda p: (0 if p["boosted"] else 1, 0 if p["city"] == city else 1, 0 if p["verified"] else 1))
    return people[:30]


@api.post("/swipe")
async def swipe(body: SwipeIn, u=Depends(current_user)):
    target = await db.users.find_one({"user_id": body.target_id}, {"_id": 0})
    if not target:
        raise HTTPException(404, "User not found")
    if body.target_id in await blocked_ids(u["user_id"]):
        raise HTTPException(403, "This user is blocked")
    if body.like and effective_tier(u) == "free":
        since = iso(now() - timedelta(hours=24))
        n = await db.swipes.count_documents({"user_id": u["user_id"], "like": True, "created_at": {"$gte": since}})
        if n >= FREE_LIKES_PER_DAY:
            raise HTTPException(402, "Out of likes today. Go Premium for unlimited.")
    await db.swipes.update_one({"user_id": u["user_id"], "target_id": body.target_id},
                               {"$set": {"like": body.like, "created_at": iso(now())}}, upsert=True)
    if not body.like:
        return {"match": None}
    mutual = target.get("is_demo") or await db.swipes.find_one({"user_id": body.target_id, "target_id": u["user_id"], "like": True})
    if not mutual:
        return {"match": None}
    pair = sorted([u["user_id"], body.target_id])
    m = await db.matches.find_one({"users": pair}, {"_id": 0})
    if not m:
        m = {"match_id": new_id("match"), "users": pair, "created_at": iso(now())}
        await db.matches.insert_one(dict(m))
        await notify([body.target_id], {"title": "It's an after party!", "message": f"You matched with {u.get('name')}. Say hi!", "action_url": f"/chat/{m['match_id']}"})
    return {"match": {"match_id": m["match_id"], "user": public_user(target)}}


@api.get("/matches")
async def matches(u=Depends(current_user)):
    blocked = await blocked_ids(u["user_id"])
    ms = await db.matches.find({"users": u["user_id"]}, {"_id": 0}).sort("created_at", -1).to_list(200)
    ms = [m for m in ms if not (set(m["users"]) & blocked)]
    others = [x for m in ms for x in m["users"] if x != u["user_id"]]
    docs = {d["user_id"]: d for d in await db.users.find({"user_id": {"$in": others}}, {"_id": 0}).to_list(500)}
    return [{"match_id": m["match_id"], "user": public_user(docs[o])} for m in ms for o in m["users"] if o != u["user_id"] and o in docs]


# ---------------- Chat ----------------
class MessageIn(BaseModel):
    text: str = Field(min_length=1, max_length=1000)


class ChatHub:
    """In-memory websocket fan-out per chat (single backend process)."""
    def __init__(self):
        self.rooms: dict = {}

    def join(self, chat_id: str, ws: WebSocket):
        self.rooms.setdefault(chat_id, set()).add(ws)

    def leave(self, chat_id: str, ws: WebSocket):
        self.rooms.get(chat_id, set()).discard(ws)

    async def broadcast(self, chat_id: str, data: dict, exclude: Optional[WebSocket] = None):
        for ws in list(self.rooms.get(chat_id, set())):
            if ws is exclude:
                continue
            try:
                await ws.send_json(data)
            except Exception:
                self.leave(chat_id, ws)


hub = ChatHub()


@api.websocket("/ws/chats/{chat_id}")
async def chat_ws(ws: WebSocket, chat_id: str, token: str = ""):
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        u = await db.users.find_one({"user_id": payload["sub"]}, {"_id": 0})
        if not u:
            raise ValueError
        await chat_access(chat_id, u)
    except Exception:
        await ws.close(code=4401)
        return
    await ws.accept()
    hub.join(chat_id, ws)
    try:
        while True:
            data = await ws.receive_json()
            if data.get("type") == "typing":
                await hub.broadcast(chat_id, {"type": "typing", "user_id": u["user_id"], "name": u.get("name", ""), "on": bool(data.get("on", True))}, exclude=ws)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        hub.leave(chat_id, ws)


async def chat_access(chat_id: str, u: dict) -> dict:
    if chat_id.startswith("party_"):
        p = await db.parties.find_one({"party_id": chat_id}, {"_id": 0})
        if p and (p["host_id"] == u["user_id"] or any(a["user_id"] == u["user_id"] for a in p["attendees"])):
            return {"title": p["title"], "kind": "party", "picture": p.get("cover")}
    elif chat_id.startswith("match_"):
        m = await db.matches.find_one({"match_id": chat_id, "users": u["user_id"]}, {"_id": 0})
        if m:
            other = next(x for x in m["users"] if x != u["user_id"])
            if other in await blocked_ids(u["user_id"]):
                raise HTTPException(403, "This chat is unavailable")
            o = await db.users.find_one({"user_id": other}, {"_id": 0})
            return {"title": o.get("name") if o else "Match", "kind": "match", "picture": o.get("picture") if o else None, "other_user_id": other}
    raise HTTPException(403, "No access to this chat")


@api.get("/chats")
async def chats(u=Depends(current_user)):
    items = []
    blocked = await blocked_ids(u["user_id"])
    for p in await my_parties(u):
        if p["host_id"] in blocked:
            continue
        items.append({"chat_id": p["party_id"], "title": p["title"], "kind": "party", "picture": p["cover"], "subtitle": f"{p['going_count']} going · {p['area']}"})
    for m in await matches(u):
        items.append({"chat_id": m["match_id"], "title": m["user"]["name"], "kind": "match", "picture": m["user"]["picture"], "subtitle": "New match — say hi"})
    for it in items:
        last = await db.messages.find_one({"chat_id": it["chat_id"]}, {"_id": 0}, sort=[("created_at", -1)])
        if last:
            it["subtitle"] = f"{last['sender_name']}: {last['text']}"
            it["last_at"] = last["created_at"]
    items.sort(key=lambda x: x.get("last_at", ""), reverse=True)
    return items


@api.get("/chats/{chat_id}")
async def chat_messages(chat_id: str, u=Depends(current_user)):
    info = await chat_access(chat_id, u)
    blocked = await blocked_ids(u["user_id"])
    msgs = await db.messages.find({"chat_id": chat_id, "sender_id": {"$nin": list(blocked)}}, {"_id": 0}).sort("created_at", 1).to_list(500)
    return {**info, "chat_id": chat_id, "messages": msgs}


@api.post("/chats/{chat_id}")
async def send_message(chat_id: str, body: MessageIn, u=Depends(current_user)):
    await chat_access(chat_id, u)
    m = {"message_id": new_id("msg"), "chat_id": chat_id, "sender_id": u["user_id"], "sender_name": u.get("name", ""),
         "sender_picture": u.get("picture"), "text": body.text.strip(), "created_at": iso(now())}
    await db.messages.insert_one(dict(m))
    await hub.broadcast(chat_id, {"type": "message", "message": m})
    if chat_id.startswith("party_"):
        p = await db.parties.find_one({"party_id": chat_id}, {"_id": 0})
        rec = [p["host_id"]] + [a["user_id"] for a in p["attendees"]]
        title = f"{u.get('name')} in {p['title']}"
    else:
        mt = await db.matches.find_one({"match_id": chat_id}, {"_id": 0})
        rec = mt["users"]
        title = u.get("name", "New message")
    await notify([r for r in rec if r != u["user_id"]], {"title": title, "message": m["text"][:120], "action_url": f"/chat/{chat_id}"})
    return m


# ---------------- Payments (Stripe) ----------------
class CheckoutIn(BaseModel):
    plan: Literal["premium", "super"]
    origin_url: str


def stripe_client(request: Request) -> StripeCheckout:
    host = str(request.base_url).rstrip("/")
    return StripeCheckout(api_key=STRIPE_API_KEY, webhook_url=f"{host}/api/webhook/stripe")


@api.post("/payments/checkout")
async def checkout(body: CheckoutIn, request: Request, u=Depends(current_user)):
    origin = body.origin_url.rstrip("/")
    sc = stripe_client(request)
    req = CheckoutSessionRequest(
        amount=PLANS[body.plan], currency="gbp",
        success_url=f"{origin}/premium?stripe_session={{CHECKOUT_SESSION_ID}}",
        cancel_url=f"{origin}/premium",
        metadata={"user_id": u["user_id"], "plan": body.plan})
    s = await sc.create_checkout_session(req)
    await db.payment_transactions.insert_one({
        "session_id": s.session_id, "user_id": u["user_id"], "plan": body.plan, "amount": PLANS[body.plan],
        "currency": "gbp", "payment_status": "initiated", "processed": False, "created_at": iso(now())})
    return {"url": s.url, "session_id": s.session_id}


async def grant_if_paid(session_id: str, payment_status: str):
    tx = await db.payment_transactions.find_one({"session_id": session_id}, {"_id": 0})
    if not tx:
        return None
    await db.payment_transactions.update_one({"session_id": session_id}, {"$set": {"payment_status": payment_status}})
    if payment_status == "paid":
        res = await db.payment_transactions.update_one({"session_id": session_id, "processed": False}, {"$set": {"processed": True}})
        if res.modified_count:
            await db.users.update_one({"user_id": tx["user_id"]}, {"$set": {"tier": tx["plan"], "tier_expires": iso(now() + timedelta(days=30))}})
    return tx


@api.get("/payments/status/{session_id}")
async def payment_status(session_id: str, request: Request, u=Depends(current_user)):
    tx = await db.payment_transactions.find_one({"session_id": session_id, "user_id": u["user_id"]}, {"_id": 0})
    if not tx:
        raise HTTPException(404, "Transaction not found")
    st = await stripe_client(request).get_checkout_status(session_id)
    await grant_if_paid(session_id, st.payment_status)
    fresh = await db.users.find_one({"user_id": u["user_id"]}, {"_id": 0})
    return {"status": st.status, "payment_status": st.payment_status, "plan": tx["plan"], "user": public_user(fresh, True)}


@api.post("/webhook/stripe")
async def stripe_webhook(request: Request):
    body = await request.body()
    try:
        ev = await stripe_client(request).handle_webhook(body, request.headers.get("Stripe-Signature"))
    except Exception as e:
        logger.warning("webhook error %s", e)
        raise HTTPException(400, "Invalid webhook")
    if ev.session_id and ev.payment_status:
        await grant_if_paid(ev.session_id, ev.payment_status)
    return {"received": True}


@api.get("/")
async def root():
    return {"app": "After Party"}


# ---------------- Seed ----------------
DEMO = [
    ("Maya", 24, "London", "women/44", ["House", "Techno"], "Fabric till 6 then yours?", "super"),
    ("Jay", 27, "London", "men/32", ["Afrobeats", "Amapiano"], "Bringing the speaker + Henny", "premium"),
    ("Zara", 25, "London", "women/68", ["R&B", "Garage"], "Shoreditch local. Kitchen DJ.", "free"),
    ("Leo", 29, "London", "men/75", ["Techno"], "Berghain energy, Peckham postcode", "free"),
    ("Chloe", 23, "Manchester", "women/12", ["House", "Disco"], "Warehouse Project survivor", "premium"),
    ("Mateo", 28, "Ibiza", "men/45", ["House"], "Villa after-parties every Sunday", "super"),
    ("Ana", 26, "Berlin", "women/90", ["Techno"], "Sunday morning is still Saturday night", "free"),
    ("Kofi", 30, "London", "men/11", ["Afrobeats", "Hip-Hop"], "Host with the most. Hackney.", "super"),
]
DEMO_PARTIES = [
    ("Kofi", "Hackney Loft Afters", "London", "Hackney Wick", "Afrobeats", True, 4, 5, 20, 3),
    ("Maya", "Post-Fabric Rooftop", "London", "Farringdon", "Techno", True, 3, 8, 15, 5),
    ("Jay", "Amapiano Sunrise Sesh", "London", "Brixton", "Amapiano", False, 5, 6, 25, 7),
    ("Chloe", "Northern Quarter Kitchen Party", "Manchester", "Northern Quarter", "House", True, 3, 4, 12, 4),
    ("Mateo", "Sunset Villa Afters", "Ibiza", "San Antonio", "House", True, 6, 15, 40, 9),
    ("Ana", "Kreuzberg Wohnung Rave", "Berlin", "Kreuzberg", "Techno", True, 2, 5, 18, 6),
]


@app.on_event("startup")
async def startup():
    await db.users.create_index("email", unique=True)
    await db.users.create_index("user_id", unique=True)
    await db.parties.create_index("party_id", unique=True)
    await db.messages.create_index([("chat_id", 1), ("created_at", 1)])
    await db.payment_transactions.create_index("session_id", unique=True)
    await db.blocks.create_index([("user_id", 1), ("blocked_id", 1)], unique=True)
    await db.files.create_index("file_id", unique=True)
    await db.parties.create_index("invite_code")
    try:
        await run_in_threadpool(init_storage)
    except Exception as e:
        logger.warning("object storage init failed: %s", e)
    pw = bcrypt.hashpw(b"demo1234", bcrypt.gensalt()).decode()
    ids = {}
    for name, age, city, pic, vibes, bio, tier in DEMO:
        email = f"{name.lower()}@demo.afterparty.app"
        existing = await db.users.find_one({"email": email}, {"_id": 0})
        if existing:
            ids[name] = existing["user_id"]
            continue
        uid = new_id("user")
        ids[name] = uid
        await db.users.insert_one({"user_id": uid, "email": email, "name": name, "age": age, "city": city,
                                   "picture": f"https://randomuser.me/api/portraits/{pic}.jpg", "vibes": vibes, "bio": bio,
                                   "tier": tier, "tier_expires": iso(now() + timedelta(days=3650)) if tier != "free" else None,
                                   "password_hash": pw, "is_demo": True, "created_at": iso(now())})
    test = await db.users.find_one({"email": "test@afterparty.app"})
    if not test:
        await db.users.insert_one({"user_id": new_id("user"), "email": "test@afterparty.app", "name": "Tester", "age": 25,
                                   "city": "London", "vibes": ["House"], "bio": "Here for the afters",
                                   "password_hash": bcrypt.hashpw(b"Test1234!", bcrypt.gensalt()).decode(),
                                   "tier": "free", "created_at": iso(now())})
    # keep demo parties fresh (always upcoming tonight)
    for i, (host, title, city, area, vibe, house, drinks, chip, cap, hrs) in enumerate(DEMO_PARTIES):
        existing = await db.parties.find_one({"title": title, "host_id": ids[host]})
        start = iso(now() + timedelta(hours=hrs))
        if existing:
            if parse_dt(existing["starts_at"]) < now():
                await db.parties.update_one({"title": title}, {"$set": {"starts_at": start}})
            continue
        others = [ids[n] for n in ids if n != host][: (i % 3) + 2]
        lat, lng = coords_for(city, area)
        await db.parties.insert_one({
            "party_id": new_id("party"), "host_id": ids[host], "title": title, "city": city, "area": area, "lat": lat, "lng": lng,
            "invite_code": secrets.token_urlsafe(6),
            "address": f"{random.randint(2, 99)} Secret Lane, {area}", "starts_at": start, "vibe": vibe,
            "description": f"{vibe} all night. Bring good energy, {'house is sorted' if house else 'need a house!'}. Chip in and let's keep it going.",
            "house_provided": house, "drinks_needed": drinks, "chip_in": chip, "capacity": cap, "cover": COVERS[i % len(COVERS)],
            "attendees": [{"user_id": o, "role": random.choice(["drinks", "chipin"]), "joined_at": iso(now() - timedelta(days=2))} for o in others],
            "created_at": iso(now())})
    # Backfill map pins + invite codes for parties created before those fields existed
    async for p in db.parties.find({"$or": [{"lat": {"$exists": False}}, {"invite_code": {"$exists": False}}]}, {"_id": 0}):
        upd = {}
        if p.get("lat") is None:
            upd["lat"], upd["lng"] = coords_for(p["city"], p["area"])
        if not p.get("invite_code"):
            upd["invite_code"] = secrets.token_urlsafe(6)
        await db.parties.update_one({"party_id": p["party_id"]}, {"$set": upd})
    # Existing accounts created before age verification: trust the stored age
    await db.users.update_many({"age_verified": {"$exists": False}, "age": {"$gte": 18}}, {"$set": {"age_verified": True}})
    await db.ratings.create_index([("party_id", 1), ("user_id", 1)], unique=True)


app.include_router(api)
app.add_middleware(CORSMiddleware, allow_credentials=True, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
