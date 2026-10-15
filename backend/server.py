from fastapi import FastAPI, APIRouter, HTTPException, Request, Depends, UploadFile, File, WebSocket, WebSocketDisconnect, Header
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from dotenv import load_dotenv
import asyncio
import math
import secrets
import requests
import time
from collections import defaultdict, deque
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
# One-off credit packs (GBP): price -> credits. Credits unlock boosts, extra joins and party promotion without a subscription.
CREDIT_PACKS = {"shot": {"price": 1.00, "credits": 10, "label": "Shot"}, "round": {"price": 2.00, "credits": 25, "label": "Round"}, "bottle": {"price": 5.00, "credits": 70, "label": "Bottle"}}
COST_BOOST, COST_EXTRA_JOIN, COST_PROMOTE, REFERRAL_REWARD = 5, 2, 10, 5
PLATFORM_FEE = 0.10          # 10% of chip-ins kept by After Party; the rest lands in the host's wallet
MIN_PAYOUT = 5.00            # GBP
STREAK_BADGES = [(1, "First Night", "moon"), (3, "Regular", "flame"), (6, "Legend", "trophy"), (10, "Nocturnal", "planet")]
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
        "host_verified": (u.get("host_verification") or {}).get("status") == "approved",
    }
    if me:
        out["email"] = u.get("email")
        out["tier_expires"] = u.get("tier_expires") if tier != "free" else None
        out["age_verified"] = bool(u.get("age_verified"))
        out["credits"] = int(u.get("credits", 0))
        out["host_verification_status"] = (u.get("host_verification") or {}).get("status")
        out["is_admin"] = is_admin(u)
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


# ---------------- Weekend streaks ----------------
def weekend_key(dt: datetime) -> Optional[str]:
    """Friday date of the weekend this night belongs to (Fri → Mon 06:00), or None for a weekday night."""
    wd = dt.weekday()
    if wd in (4, 5, 6):
        fri = dt.date() - timedelta(days=wd - 4)
    elif wd == 0 and dt.hour < 6:
        fri = dt.date() - timedelta(days=3)
    else:
        return None
    return fri.isoformat()


def streak_from_keys(keys: List[str]) -> tuple:
    """(current, best) consecutive-weekend streaks. Current survives until the following weekend ends."""
    days = sorted({datetime.fromisoformat(k).date() for k in keys})
    if not days:
        return 0, 0
    best = cur = 1
    for a, b in zip(days, days[1:]):
        cur = cur + 1 if (b - a).days == 7 else 1
        best = max(best, cur)
    this_fri = weekend_key(now()) or (now().date() - timedelta(days=(now().weekday() - 4) % 7)).isoformat()
    gap = (datetime.fromisoformat(this_fri).date() - days[-1]).days
    return (cur if gap <= 7 else 0), best


async def record_night_out(user_id: str, party: dict):
    """Called on check-in or rating: logs the night and pays streak rewards once per weekend."""
    key = weekend_key(parse_dt(party["starts_at"]))
    if not key:
        return
    existing = await db.nights.find_one({"user_id": user_id, "weekend": key})
    await db.nights.update_one({"user_id": user_id, "weekend": key}, {"$setOnInsert": {"party_id": party["party_id"], "created_at": iso(now())}}, upsert=True)
    if existing:
        return
    keys = await db.nights.distinct("weekend", {"user_id": user_id})
    current, _ = streak_from_keys(keys)
    reward = min(current, 5)
    await add_credits(user_id, reward, "streak", key)
    badge = next((name for n, name, _ in STREAK_BADGES if n == current), None)
    msg = f"+{reward} credits for your {current}-weekend streak" + (f" — you unlocked the {badge} badge!" if badge else ". Keep it going next weekend.")
    await notify([user_id], {"title": f"🔥 {current} weekend{'s' if current != 1 else ''} in a row", "message": msg, "action_url": "/profile"})


async def reminder_loop():
    """Every 5 min: push a '1 hour to go' reminder (with directions link) to everyone going."""
    while True:
        try:
            lo, hi = iso(now() + timedelta(minutes=50)), iso(now() + timedelta(minutes=70))
            async for p in db.parties.find({"starts_at": {"$gte": lo, "$lte": hi}, "reminded_1h": {"$ne": True}}, {"_id": 0}):
                await db.parties.update_one({"party_id": p["party_id"]}, {"$set": {"reminded_1h": True}})
                guests = [a["user_id"] for a in p["attendees"]]
                if guests:
                    await notify(guests, {"title": f"{p['title']} starts in 1 hour", "message": f"Address: {p.get('address') or p['area']}. Tap for directions and the group chat.", "action_url": f"/party/{p['party_id']}"})
                await notify([p["host_id"]], {"title": "Your afters starts in 1 hour", "message": f"{len(guests)} going to {p['title']}. Open the door scanner when they arrive.", "action_url": f"/party/{p['party_id']}"})
        except Exception as e:
            logger.warning("reminder loop: %s", e)
        await asyncio.sleep(300)


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
    if u.get("suspended"):
        raise HTTPException(403, "Your account is suspended. Contact support@afterparty.app")
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
    ref: Optional[str] = Field(None, max_length=16)  # referral code


async def add_credits(user_id: str, amount: int, reason: str, ref: Optional[str] = None):
    await db.users.update_one({"user_id": user_id}, {"$inc": {"credits": amount}})
    await db.credit_ledger.insert_one({"entry_id": new_id("cr"), "user_id": user_id, "amount": amount, "reason": reason, "ref": ref, "created_at": iso(now())})


async def spend_credits(u: dict, amount: int, reason: str, ref: Optional[str] = None):
    """Atomic debit: only succeeds if the balance covers it."""
    res = await db.users.update_one({"user_id": u["user_id"], "credits": {"$gte": amount}}, {"$inc": {"credits": -amount}})
    if not res.modified_count:
        raise HTTPException(402, f"Needs {amount} credits — you have {int(u.get('credits', 0))}. Top up from £1.")
    u["credits"] = int(u.get("credits", 0)) - amount
    await db.credit_ledger.insert_one({"entry_id": new_id("cr"), "user_id": u["user_id"], "amount": -amount, "reason": reason, "ref": ref, "created_at": iso(now())})


async def apply_referral(new_user: dict, code: Optional[str]):
    if not code:
        return
    ref = await db.users.find_one({"referral_code": code.strip().upper()}, {"_id": 0})
    if not ref or ref["user_id"] == new_user["user_id"]:
        return
    await db.users.update_one({"user_id": new_user["user_id"]}, {"$set": {"referred_by": ref["user_id"]}})
    await add_credits(new_user["user_id"], REFERRAL_REWARD, "referral_welcome", ref["user_id"])
    await add_credits(ref["user_id"], REFERRAL_REWARD, "referral_reward", new_user["user_id"])
    await notify([ref["user_id"]], {"title": f"{new_user.get('name')} joined with your link", "message": f"+{REFERRAL_REWARD} credits landed in your account. Keep spreading the word!", "action_url": "/credits"})


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
         "city": "London", "bio": "", "vibes": [], "tier": "free", "credits": 0, "referral_code": secrets.token_hex(3).upper(), "created_at": iso(now())}
    await db.users.insert_one(u)
    await apply_referral(u, body.ref)
    u = await db.users.find_one({"user_id": u["user_id"]}, {"_id": 0})
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
        await record_night_out(u["user_id"], p)
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
    await record_night_out(att["user_id"], p)
    return {"ok": True, "already": False, "guest": public_user(guest), "checked_in_at": ts}


@api.post("/me/photo")
async def upload_photo(file: UploadFile = File(...), u=Depends(current_user)):
    ctype = (file.content_type or "").lower()
    if ctype not in ("image/jpeg", "image/png", "image/webp", "image/heic"):
        raise HTTPException(400, "Please upload a JPG, PNG or WebP photo")
    data = await file.read()
    if len(data) > MAX_PHOTO_BYTES:
        raise HTTPException(413, "Photo too large (max 6MB)")
    # Verify the bytes really are an image (don't trust the declared content type)
    magic_ok = data[:3] == b"\xff\xd8\xff" or data[:8] == b"\x89PNG\r\n\x1a\n" or (data[:4] == b"RIFF" and data[8:12] == b"WEBP") or data[4:8] == b"ftyp"
    if not magic_ok:
        raise HTTPException(400, "That file isn't a valid image")
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


# ---------------- Split the bill (party chat) ----------------
class BillIn(BaseModel):
    title: str = Field(min_length=1, max_length=60)
    amount: float = Field(gt=0, le=5000)
    participants: Optional[List[str]] = None  # default: everyone in the party (host + guests)


def bill_view(b: dict, uid: str, users: dict) -> dict:
    paid = b.get("paid", {})
    people = [{"user_id": x, "name": users.get(x, {}).get("name", "Guest"), "picture": users.get(x, {}).get("picture"),
               "share": b["shares"][x], "paid": x in paid or x == b["creator_id"], "method": paid.get(x, {}).get("method")} for x in b["shares"]]
    return {"bill_id": b["bill_id"], "chat_id": b["chat_id"], "title": b["title"], "amount": b["amount"], "creator_id": b["creator_id"],
            "creator_name": users.get(b["creator_id"], {}).get("name", "Someone"), "created_at": b["created_at"], "people": people,
            "my_share": b["shares"].get(uid), "my_paid": uid in paid or uid == b["creator_id"], "is_creator": b["creator_id"] == uid,
            "settled": all(p["paid"] for p in people), "collected": round(sum(p["share"] for p in people if p["paid"] and p["user_id"] != b["creator_id"]), 2)}


async def settle_bill_share(bill_id: str, payer_id: str, method: str):
    b = await db.bills.find_one({"bill_id": bill_id}, {"_id": 0})
    if not b or payer_id not in b["shares"] or payer_id in b.get("paid", {}):
        return
    ts = iso(now())
    await db.bills.update_one({"bill_id": bill_id}, {"$set": {f"paid.{payer_id}": {"at": ts, "method": method}}})
    share = float(b["shares"][payer_id])
    payer = await db.users.find_one({"user_id": payer_id}, {"_id": 0, "name": 1})
    if method == "card":
        # Card settlements land in the bill creator's wallet, no platform fee between friends
        await db.users.update_one({"user_id": b["creator_id"]}, {"$inc": {"wallet_balance": share, "wallet_earned": share}})
        await db.wallet_ledger.insert_one({"entry_id": new_id("w"), "user_id": b["creator_id"], "amount": share, "gross": share, "fee": 0.0, "type": "split",
                                           "party_id": b["chat_id"], "party_title": b["title"], "from_name": payer.get("name") if payer else None, "created_at": ts})
    await notify([b["creator_id"]], {"title": f"{payer.get('name') if payer else 'Someone'} settled £{share:.2f}", "message": f"For “{b['title']}” · {'paid by card into your wallet' if method == 'card' else 'marked as paid'}", "action_url": f"/chat/{b['chat_id']}"})
    await hub.broadcast(b["chat_id"], {"type": "bill"})


@api.get("/chats/{chat_id}/bills")
async def list_bills(chat_id: str, u=Depends(current_user)):
    await chat_access(chat_id, u)
    bills = await db.bills.find({"chat_id": chat_id}, {"_id": 0}).sort("created_at", -1).to_list(50)
    ids = {x for b in bills for x in b["shares"]} | {b["creator_id"] for b in bills}
    users = {x["user_id"]: x for x in await db.users.find({"user_id": {"$in": list(ids)}}, {"_id": 0}).to_list(500)}
    return [bill_view(b, u["user_id"], users) for b in bills]


@api.post("/chats/{chat_id}/bills", status_code=201)
async def create_bill(chat_id: str, body: BillIn, u=Depends(current_user)):
    info = await chat_access(chat_id, u)
    if info["kind"] != "party":
        raise HTTPException(400, "Bills live in party group chats")
    p = await db.parties.find_one({"party_id": chat_id}, {"_id": 0})
    members = {p["host_id"], *[a["user_id"] for a in p["attendees"]]}
    people = set(body.participants or members) & members
    people.add(u["user_id"])
    if len(people) < 2:
        raise HTTPException(400, "Pick at least one other person to split with")
    n = len(people)
    share = round(body.amount / n, 2)
    shares = {x: share for x in people}
    # Put rounding pennies on the creator so the total always adds up
    shares[u["user_id"]] = round(body.amount - share * (n - 1), 2)
    b = {"bill_id": new_id("bill"), "chat_id": chat_id, "creator_id": u["user_id"], "title": body.title.strip(), "amount": round(body.amount, 2),
         "shares": shares, "paid": {}, "created_at": iso(now())}
    await db.bills.insert_one(dict(b))
    m = {"message_id": new_id("msg"), "chat_id": chat_id, "sender_id": u["user_id"], "sender_name": u.get("name"), "sender_picture": u.get("picture"),
         "text": f"💸 Split: {b['title']} — £{b['amount']:.2f} between {n} → £{share:.2f} each. Settle up in Bills.", "created_at": iso(now())}
    await db.messages.insert_one(dict(m))
    await hub.broadcast(chat_id, {"type": "message", "message": m})
    await hub.broadcast(chat_id, {"type": "bill"})
    await notify([x for x in people if x != u["user_id"]], {"title": f"You owe £{share:.2f} for {b['title']}", "message": f"{u.get('name')} split the bill in {p['title']}. Settle up in-app.", "action_url": f"/chat/{chat_id}"})
    users = {x["user_id"]: x for x in await db.users.find({"user_id": {"$in": list(people)}}, {"_id": 0}).to_list(500)}
    return bill_view(b, u["user_id"], users)


class MarkPaidIn(BaseModel):
    user_id: str


@api.post("/bills/{bill_id}/mark-paid")
async def mark_bill_paid(bill_id: str, body: MarkPaidIn, u=Depends(current_user)):
    b = await db.bills.find_one({"bill_id": bill_id}, {"_id": 0})
    if not b:
        raise HTTPException(404, "Bill not found")
    if b["creator_id"] != u["user_id"]:
        raise HTTPException(403, "Only whoever created the bill can mark cash payments")
    if body.user_id not in b["shares"]:
        raise HTTPException(404, "That person isn't on this bill")
    await settle_bill_share(bill_id, body.user_id, "cash")
    return {"ok": True}


@api.delete("/bills/{bill_id}")
async def delete_bill(bill_id: str, u=Depends(current_user)):
    b = await db.bills.find_one({"bill_id": bill_id}, {"_id": 0})
    if not b:
        raise HTTPException(404, "Bill not found")
    if b["creator_id"] != u["user_id"]:
        raise HTTPException(403, "Only the creator can delete a bill")
    if any(v.get("method") == "card" for v in b.get("paid", {}).values()):
        raise HTTPException(400, "Someone already paid by card — this bill can't be deleted")
    await db.bills.delete_one({"bill_id": bill_id})
    await hub.broadcast(b["chat_id"], {"type": "bill"})
    return {"ok": True}


# ---------------- Host ID verification ----------------
ADMIN_SECRET = os.environ.get("ADMIN_SECRET", "")


@api.post("/me/verify-host")
async def submit_host_verification(id_document: UploadFile = File(...), selfie: UploadFile = File(...), u=Depends(current_user)):
    hv = u.get("host_verification") or {}
    if hv.get("status") == "approved":
        raise HTTPException(400, "You're already a verified host")
    if hv.get("status") == "pending":
        raise HTTPException(400, "Your documents are already under review")
    stored = {}
    for label, f in (("id_document", id_document), ("selfie", selfie)):
        ctype = (f.content_type or "").lower()
        data = await f.read()
        magic_ok = data[:3] == b"\xff\xd8\xff" or data[:8] == b"\x89PNG\r\n\x1a\n" or (data[:4] == b"RIFF" and data[8:12] == b"WEBP") or data[4:8] == b"ftyp"
        if ctype not in ("image/jpeg", "image/png", "image/webp", "image/heic") or not magic_ok:
            raise HTTPException(400, f"{label.replace('_', ' ').title()} must be a clear photo (JPG/PNG)")
        if len(data) > MAX_PHOTO_BYTES:
            raise HTTPException(413, "Photos must be under 6MB")
        path = f"{STORAGE_APP}/kyc/{u['user_id']}/{label}-{uuid.uuid4().hex}.jpg"
        try:
            resp = await run_in_threadpool(put_object, path, data, ctype)
        except Exception as e:
            logger.warning("kyc upload failed: %s", e)
            raise HTTPException(502, "Secure upload unavailable, try again")
        if resp.status_code >= 400:
            raise HTTPException(502, "Secure upload failed, try again")
        stored[label] = path  # private: never registered in db.files, never served publicly
    upd = {"host_verification": {"status": "pending", "submitted_at": iso(now()), "docs": stored}}
    await db.users.update_one({"user_id": u["user_id"]}, {"$set": upd})
    u.update(upd)
    return public_user(u, True)


ADMIN_EMAILS = {e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()}


def is_admin(u: dict) -> bool:
    return bool(u.get("is_admin")) or (u.get("email") or "").lower() in ADMIN_EMAILS


async def admin_user(request: Request, authorization: Optional[str] = Header(None)):
    """Admin access: either a logged-in admin account (JWT) or the server-side x-admin-secret header."""
    if ADMIN_SECRET and request.headers.get("x-admin-secret") == ADMIN_SECRET:
        return {"user_id": "secret", "name": "Admin"}
    if authorization and authorization.startswith("Bearer "):
        try:
            payload = jwt.decode(authorization[7:], JWT_SECRET, algorithms=["HS256"])
            u = await db.users.find_one({"user_id": payload["sub"]}, {"_id": 0})
            if u and is_admin(u):
                return u
        except Exception:
            pass
    raise HTTPException(403, "Admins only")


@api.get("/admin/host-verifications")
async def admin_list_verifications(a=Depends(admin_user)):
    docs = await db.users.find({"host_verification.status": "pending"}, {"_id": 0, "user_id": 1, "name": 1, "email": 1, "picture": 1, "city": 1, "age": 1, "host_verification": 1}).sort("host_verification.submitted_at", 1).to_list(200)
    for d in docs:
        d["host_verification"] = {k: v for k, v in d["host_verification"].items() if k != "docs"}
    return docs


@api.get("/admin/host-verifications/{user_id}/{label}")
async def admin_kyc_image(user_id: str, label: Literal["id_document", "selfie"], a=Depends(admin_user)):
    """Streams a private KYC image to an admin — never public, never cached."""
    u = await db.users.find_one({"user_id": user_id}, {"_id": 0, "host_verification": 1})
    path = ((u or {}).get("host_verification") or {}).get("docs", {}).get(label)
    if not path:
        raise HTTPException(404, "Not found")
    resp = await run_in_threadpool(get_object, path)
    if resp.status_code >= 400:
        raise HTTPException(404, "Not found")
    return Response(content=resp.content, media_type=resp.headers.get("content-type", "image/jpeg"), headers={"Cache-Control": "no-store"})


class ReviewIn(BaseModel):
    approve: bool
    note: str = Field("", max_length=200)


@api.post("/admin/host-verifications/{user_id}")
async def admin_review_verification(user_id: str, body: ReviewIn, a=Depends(admin_user)):
    status = "approved" if body.approve else "rejected"
    res = await db.users.update_one({"user_id": user_id, "host_verification.status": "pending"},
                                    {"$set": {"host_verification.status": status, "host_verification.reviewed_at": iso(now()), "host_verification.note": body.note, "host_verification.reviewed_by": a["user_id"]},
                                     "$unset": {"host_verification.docs": ""}})
    if not res.matched_count:
        raise HTTPException(404, "No pending verification for that user")
    await notify([user_id], {"title": "You're a verified host ✅" if body.approve else "Host verification needs another look",
                             "message": "Guests now see the verified badge on your parties." if body.approve else (body.note or "Please resubmit clearer photos of your ID and a selfie."), "action_url": "/profile"})
    return {"status": status}


@api.get("/admin/reports")
async def admin_reports(status: Literal["open", "resolved", "all"] = "open", a=Depends(admin_user)):
    q = {} if status == "all" else {"status": status}
    reps = await db.reports.find(q, {"_id": 0}).sort("created_at", -1).to_list(200)
    ids = {r["reporter_id"] for r in reps} | {r["target_id"] for r in reps}
    users = {x["user_id"]: public_user(x) for x in await db.users.find({"user_id": {"$in": list(ids)}}, {"_id": 0}).to_list(500)}
    for r in reps:
        r["reporter"] = users.get(r["reporter_id"])
        r["target"] = users.get(r["target_id"])
        r["target_report_count"] = await db.reports.count_documents({"target_id": r["target_id"]})
    return reps


class ResolveIn(BaseModel):
    action: Literal["dismiss", "warn", "suspend"]
    note: str = Field("", max_length=200)


@api.post("/admin/reports/{report_id}/resolve")
async def admin_resolve_report(report_id: str, body: ResolveIn, a=Depends(admin_user)):
    r = await db.reports.find_one({"report_id": report_id}, {"_id": 0})
    if not r:
        raise HTTPException(404, "Report not found")
    await db.reports.update_one({"report_id": report_id}, {"$set": {"status": "resolved", "action": body.action, "note": body.note, "resolved_at": iso(now()), "resolved_by": a["user_id"]}})
    if body.action == "suspend":
        await db.users.update_one({"user_id": r["target_id"]}, {"$set": {"suspended": True, "suspended_at": iso(now())}})
    elif body.action == "warn":
        await notify([r["target_id"]], {"title": "A note from After Party", "message": body.note or "We received a report about your behaviour. Please keep it respectful — repeat reports lead to suspension.", "action_url": "/profile"})
    return {"status": "resolved", "action": body.action}


@api.post("/admin/users/{user_id}/unsuspend")
async def admin_unsuspend(user_id: str, a=Depends(admin_user)):
    await db.users.update_one({"user_id": user_id}, {"$unset": {"suspended": "", "suspended_at": ""}})
    return {"ok": True}


@api.get("/admin/stats")
async def admin_stats(a=Depends(admin_user)):
    since7 = iso(now() - timedelta(days=7))
    paid = await db.payment_transactions.find({"payment_status": "paid"}, {"_id": 0, "amount": 1, "kind": 1, "created_at": 1}).to_list(5000)
    return {
        "users": await db.users.count_documents({}), "new_users_7d": await db.users.count_documents({"created_at": {"$gte": since7}}),
        "parties_upcoming": await db.parties.count_documents({"starts_at": {"$gte": iso(now())}}),
        "parties_7d": await db.parties.count_documents({"created_at": {"$gte": since7}}),
        "subscribers": await db.users.count_documents({"tier": {"$in": ["premium", "super"]}, "tier_expires": {"$gte": iso(now())}}),
        "revenue_total": round(sum(p["amount"] for p in paid), 2), "revenue_7d": round(sum(p["amount"] for p in paid if p["created_at"] >= since7), 2),
        "revenue_by_kind": {k: round(sum(p["amount"] for p in paid if p.get("kind", "plan") == k), 2) for k in ("plan", "credits", "chipin", "bill")},
        "pending_verifications": await db.users.count_documents({"host_verification.status": "pending"}),
        "open_reports": await db.reports.count_documents({"status": "open"}),
        "suspended": await db.users.count_documents({"suspended": True}),
    }


@api.post("/me/boost")
async def boost(u=Depends(current_user)):
    if effective_tier(u) == "free":
        # Free members can boost with credits instead of a subscription
        await spend_credits(u, COST_BOOST, "boost")
    until = now() + timedelta(minutes=60)
    await db.users.update_one({"user_id": u["user_id"]}, {"$set": {"boosted_until": iso(until)}})
    return {"boosted_until": iso(until), "credits": int(u.get("credits", 0))}


@api.get("/me/streak")
async def my_streak(u=Depends(current_user)):
    keys = await db.nights.distinct("weekend", {"user_id": u["user_id"]})
    current, best = streak_from_keys(keys)
    this_key = weekend_key(now())
    return {"current": current, "best": best, "nights": len(keys), "this_weekend_done": bool(this_key and this_key in keys),
            "badges": [{"name": name, "icon": icon, "at": n, "unlocked": best >= n} for n, name, icon in STREAK_BADGES],
            "next_reward": min(current + 1, 5)}


# ---------------- Smart reminders ----------------
@api.get("/reminders/upcoming")
async def upcoming_reminders(u=Depends(current_user)):
    """Parties I'm going to (or hosting) that start within 90 minutes or started < 45 minutes ago."""
    lo, hi = iso(now() - timedelta(minutes=45)), iso(now() + timedelta(minutes=90))
    q = {"starts_at": {"$gte": lo, "$lte": hi}, "$or": [{"host_id": u["user_id"]}, {"attendees.user_id": u["user_id"]}]}
    ps = await db.parties.find(q, {"_id": 0}).sort("starts_at", 1).to_list(5)
    hosts, users = await load_people(ps)
    out = []
    for p in ps:
        v = party_view(p, u, hosts, users)
        v["minutes_until"] = int((parse_dt(p["starts_at"]) - now()).total_seconds() // 60)
        out.append(v)
    return out


# ---------------- Credits, referrals & marketing ----------------
@api.get("/credits")
async def credits(u=Depends(current_user)):
    ledger = await db.credit_ledger.find({"user_id": u["user_id"]}, {"_id": 0}).sort("created_at", -1).to_list(30)
    return {"balance": int(u.get("credits", 0)), "packs": CREDIT_PACKS, "ledger": ledger,
            "costs": {"boost": COST_BOOST, "extra_join": COST_EXTRA_JOIN, "promote": COST_PROMOTE, "referral": REFERRAL_REWARD}}


async def ensure_referral_code(u: dict) -> str:
    code = u.get("referral_code")
    if not code:
        code = secrets.token_hex(3).upper()
        await db.users.update_one({"user_id": u["user_id"]}, {"$set": {"referral_code": code}})
    return code


@api.get("/me/referral")
async def my_referral(u=Depends(current_user)):
    code = await ensure_referral_code(u)
    invited = await db.users.count_documents({"referred_by": u["user_id"]})
    earned = sum(e["amount"] for e in await db.credit_ledger.find({"user_id": u["user_id"], "reason": "referral_reward"}, {"_id": 0}).to_list(1000))
    return {"code": code, "invited": invited, "earned": earned, "reward": REFERRAL_REWARD}


@api.get("/parties/{party_id}/promo")
async def party_promo(party_id: str, u=Depends(current_user)):
    """Ready-to-post social caption so hosts can market their afters in one tap."""
    p = await db.parties.find_one({"party_id": party_id}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Party not found")
    if p.get("promo"):
        return p["promo"]
    try:
        text = await gemini(
            "You write short, viral Instagram/TikTok captions for London nightlife. Max 220 characters. Include 1-2 emojis and end with 3 hashtags including #AfterParty. Never include an address.",
            f"Party: {p['title']}. Vibe: {p['vibe']}. Area: {p['area']}, {p['city']}. Starts {p['starts_at']}. Description: {p.get('description', '')}. Guests bring drinks or chip in £{p['chip_in']}.",
            f"promo-{party_id}")
    except Exception as e:
        logger.warning("promo generation failed: %s", e)
        text = f"Afters at {p['area']} tonight 🔥 {p['vibe']} vibes, bring drinks or chip in. Tap in before it fills up. #AfterParty #{p['city'].replace(' ', '')}Nights #Afters"
    promo = {"caption": text.strip(), "generated_at": iso(now())}
    await db.parties.update_one({"party_id": party_id}, {"$set": {"promo": promo}})
    return promo


@api.post("/parties/{party_id}/promote")
async def promote_party(party_id: str, u=Depends(current_user)):
    p = await db.parties.find_one({"party_id": party_id}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Party not found")
    if p["host_id"] != u["user_id"]:
        raise HTTPException(403, "Only the host can promote this party")
    if parse_dt(p.get("promoted_until") or "2000-01-01T00:00:00+00:00") > now():
        raise HTTPException(400, "Already promoted — it's pinned to the top of the feed")
    await spend_credits(u, COST_PROMOTE, "promote", party_id)
    until = iso(now() + timedelta(hours=24))
    await db.parties.update_one({"party_id": party_id}, {"$set": {"promoted_until": until}})
    return {"promoted_until": until, "credits": int(u.get("credits", 0))}


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
    use_credits: bool = False


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
        "attendees": [dict(public_user(users[a["user_id"]]), role=a["role"], checked_in=bool(a.get("checked_in_at")), paid=bool(a.get("paid_at"))) for a in atts if a["user_id"] in users] if can_see else [],
        "checked_in_count": sum(1 for a in atts if a.get("checked_in_at")),
        "paid_count": sum(1 for a in atts if a.get("paid_at")),
        "collected": round(sum(float(a.get("paid_amount", 0)) for a in atts if a.get("paid_at")), 2) if is_host else None,
        "my_paid": any(a["user_id"] == uid and a.get("paid_at") for a in atts),
        "started": parse_dt(p["starts_at"]) <= now(),
        "promoted": bool(p.get("promoted_until")) and parse_dt(p["promoted_until"]) > now(),
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
    # Promoted parties first, then Super Premium hosts
    views.sort(key=lambda v: (0 if v["promoted"] else 1, 0 if (v["host"] and v["host"]["tier"] == "super") else 1))
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


async def do_join(p: dict, u: dict, role: str, invited: bool = False, use_credits: bool = False):
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
            if use_credits:
                await spend_credits(u, COST_EXTRA_JOIN, "extra_join", party_id)
            else:
                raise HTTPException(402, f"Free plan: {FREE_JOINS_PER_DAY} joins per day. Go Premium for unlimited, or use {COST_EXTRA_JOIN} credits.")
    await db.parties.update_one({"party_id": party_id}, {"$push": {"attendees": {"user_id": u["user_id"], "role": role, "joined_at": iso(now()), "invited": invited}}})
    role_txt = {"drinks": "is bringing drinks", "chipin": "is chipping in", "house": "can offer a house"}[role]
    await notify([p["host_id"]], {"title": f"{u.get('name')} is down for {p['title']}", "message": f"{u.get('name')} {role_txt}{' (via your invite link)' if invited else ''}. Party's growing!", "action_url": f"/party/{party_id}"})
    return await get_party(party_id, u)


@api.post("/parties/{party_id}/join")
async def join_party(party_id: str, body: JoinIn, u=Depends(current_user)):
    p = await db.parties.find_one({"party_id": party_id}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Party not found")
    return await do_join(p, u, body.role, use_credits=body.use_credits)


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
    plan: Optional[Literal["premium", "super"]] = None
    pack: Optional[Literal["shot", "round", "bottle"]] = None
    party_id: Optional[str] = None  # pay the chip-in for a party you're attending
    bill_id: Optional[str] = None   # settle your share of a split bill
    origin_url: str


def stripe_client(request: Request) -> StripeCheckout:
    host = str(request.base_url).rstrip("/")
    return StripeCheckout(api_key=STRIPE_API_KEY, webhook_url=f"{host}/api/webhook/stripe")


@api.post("/payments/checkout")
async def checkout(body: CheckoutIn, request: Request, u=Depends(current_user)):
    if not body.plan and not body.pack and not body.party_id and not body.bill_id:
        raise HTTPException(400, "Choose a plan, a credit pack or a party to pay for")
    origin = body.origin_url.rstrip("/")
    if not origin.startswith(("http://", "https://")):
        raise HTTPException(400, "Invalid origin")
    sc = stripe_client(request)
    if body.bill_id:
        b = await db.bills.find_one({"bill_id": body.bill_id}, {"_id": 0})
        if not b:
            raise HTTPException(404, "Bill not found")
        if u["user_id"] not in b["shares"]:
            raise HTTPException(403, "You're not part of this bill")
        if u["user_id"] in b.get("paid", {}):
            raise HTTPException(400, "You've already settled this one")
        if b["creator_id"] == u["user_id"]:
            raise HTTPException(400, "You created this bill — others pay you")
        amount, kind, item, page = float(b["shares"][u["user_id"]]), "bill", body.bill_id, f"chat/{b['chat_id']}"
    elif body.party_id:
        p = await db.parties.find_one({"party_id": body.party_id}, {"_id": 0})
        if not p:
            raise HTTPException(404, "Party not found")
        att = next((a for a in p["attendees"] if a["user_id"] == u["user_id"]), None)
        if not att:
            raise HTTPException(403, "Join the party before paying the chip-in")
        if att.get("paid_at"):
            raise HTTPException(400, "You've already paid for this one")
        if p["chip_in"] <= 0:
            raise HTTPException(400, "This party has no chip-in")
        amount, kind, item, page = float(p["chip_in"]), "chipin", body.party_id, f"party/{body.party_id}"
    elif body.pack:
        amount, kind, item, page = CREDIT_PACKS[body.pack]["price"], "credits", body.pack, "credits"
    else:
        amount, kind, item, page = PLANS[body.plan], "plan", body.plan, "premium"
    req = CheckoutSessionRequest(
        amount=amount, currency="gbp",
        success_url=f"{origin}/{page}?stripe_session={{CHECKOUT_SESSION_ID}}",
        cancel_url=f"{origin}/{page}",
        metadata={"user_id": u["user_id"], "kind": kind, "item": item})
    s = await sc.create_checkout_session(req)
    await db.payment_transactions.insert_one({
        "session_id": s.session_id, "user_id": u["user_id"], "kind": kind, "plan": body.plan, "pack": body.pack, "party_id": body.party_id, "bill_id": body.bill_id, "amount": amount,
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
            if tx.get("bill_id"):
                await settle_bill_share(tx["bill_id"], tx["user_id"], "card")
            elif tx.get("party_id"):
                await settle_chipin(tx)
            elif tx.get("pack"):
                await add_credits(tx["user_id"], CREDIT_PACKS[tx["pack"]]["credits"], "purchase", session_id)
            else:
                await db.users.update_one({"user_id": tx["user_id"]}, {"$set": {"tier": tx["plan"], "tier_expires": iso(now() + timedelta(days=30))}})
    return tx


# ---------------- Host wallet & payouts ----------------
async def settle_chipin(tx: dict):
    """Guest paid the chip-in: mark them paid and credit the host's wallet (minus platform fee)."""
    p = await db.parties.find_one({"party_id": tx["party_id"]}, {"_id": 0})
    if not p:
        return
    ts = iso(now())
    await db.parties.update_one({"party_id": p["party_id"], "attendees.user_id": tx["user_id"]}, {"$set": {"attendees.$.paid_at": ts, "attendees.$.paid_amount": tx["amount"]}})
    net = round(tx["amount"] * (1 - PLATFORM_FEE), 2)
    await db.users.update_one({"user_id": p["host_id"]}, {"$inc": {"wallet_balance": net, "wallet_earned": net}})
    guest = await db.users.find_one({"user_id": tx["user_id"]}, {"_id": 0, "name": 1})
    await db.wallet_ledger.insert_one({"entry_id": new_id("w"), "user_id": p["host_id"], "amount": net, "gross": tx["amount"], "fee": round(tx["amount"] - net, 2),
                                       "type": "chipin", "party_id": p["party_id"], "party_title": p["title"], "from_name": guest.get("name") if guest else None, "created_at": ts})
    await notify([p["host_id"]], {"title": f"£{tx['amount']:.2f} chip-in received", "message": f"{guest.get('name') if guest else 'A guest'} paid for {p['title']}. £{net:.2f} added to your wallet.", "action_url": "/wallet"})


class PayoutMethodIn(BaseModel):
    method: Literal["bank", "paypal", "revolut"]
    account_name: str = Field(min_length=2, max_length=60)
    details: str = Field(min_length=4, max_length=80)  # sort code + account no. / PayPal email / Revolut tag


def masked(details: str) -> str:
    d = details.strip()
    return d if len(d) <= 4 else "•" * (len(d) - 4) + d[-4:]


@api.get("/wallet")
async def wallet(u=Depends(current_user)):
    ledger = await db.wallet_ledger.find({"user_id": u["user_id"]}, {"_id": 0}).sort("created_at", -1).to_list(50)
    pm = u.get("payout_method")
    return {"balance": round(float(u.get("wallet_balance", 0)), 2), "earned": round(float(u.get("wallet_earned", 0)), 2),
            "fee_pct": int(PLATFORM_FEE * 100), "min_payout": MIN_PAYOUT, "ledger": ledger,
            "payout_method": {"method": pm["method"], "account_name": pm["account_name"], "details_masked": masked(pm["details"])} if pm else None}


@api.put("/wallet/payout-method")
async def set_payout_method(body: PayoutMethodIn, u=Depends(current_user)):
    await db.users.update_one({"user_id": u["user_id"]}, {"$set": {"payout_method": body.model_dump()}})
    return {"method": body.method, "account_name": body.account_name, "details_masked": masked(body.details)}


@api.post("/wallet/payout")
async def request_payout(u=Depends(current_user)):
    bal = round(float(u.get("wallet_balance", 0)), 2)
    if not u.get("payout_method"):
        raise HTTPException(400, "Add where we should send your money first")
    if bal < MIN_PAYOUT:
        raise HTTPException(400, f"Minimum payout is £{MIN_PAYOUT:.2f} — you have £{bal:.2f}")
    res = await db.users.update_one({"user_id": u["user_id"], "wallet_balance": {"$gte": bal}}, {"$inc": {"wallet_balance": -bal}})
    if not res.modified_count:
        raise HTTPException(409, "Balance changed, try again")
    ts = iso(now())
    payout = {"payout_id": new_id("po"), "user_id": u["user_id"], "amount": bal, "method": u["payout_method"]["method"],
              "destination": masked(u["payout_method"]["details"]), "status": "processing", "eta": iso(now() + timedelta(days=2)), "created_at": ts}
    await db.payouts.insert_one(dict(payout))
    await db.wallet_ledger.insert_one({"entry_id": new_id("w"), "user_id": u["user_id"], "amount": -bal, "type": "payout", "status": "processing", "created_at": ts})
    return payout


@api.get("/payments/status/{session_id}")
async def payment_status(session_id: str, request: Request, u=Depends(current_user)):
    tx = await db.payment_transactions.find_one({"session_id": session_id, "user_id": u["user_id"]}, {"_id": 0})
    if not tx:
        raise HTTPException(404, "Transaction not found")
    st = await stripe_client(request).get_checkout_status(session_id)
    await grant_if_paid(session_id, st.payment_status)
    fresh = await db.users.find_one({"user_id": u["user_id"]}, {"_id": 0})
    return {"status": st.status, "payment_status": st.payment_status, "plan": tx.get("plan"), "kind": tx.get("kind"), "user": public_user(fresh, True)}


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
    await db.nights.create_index([("user_id", 1), ("weekend", 1)], unique=True)
    await db.wallet_ledger.create_index([("user_id", 1), ("created_at", -1)])
    asyncio.create_task(reminder_loop())
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
    # keep demo parties fresh (always upcoming tonight) and never full
    await db.parties.update_many({"host_id": {"$in": list(ids.values())}, "capacity": {"$lt": 60}}, {"$set": {"capacity": 60}})
    for i, (host, title, city, area, vibe, house, drinks, chip, cap, hrs) in enumerate(DEMO_PARTIES):
        cap = max(cap, 60)
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
    await db.credit_ledger.create_index([("user_id", 1), ("created_at", -1)])
    await db.users.create_index("referral_code", sparse=True)
    # Backfill: every account gets a referral code and a credits balance
    async for usr in db.users.find({"$or": [{"referral_code": {"$exists": False}}, {"credits": {"$exists": False}}]}, {"_id": 0, "user_id": 1, "referral_code": 1}):
        await db.users.update_one({"user_id": usr["user_id"], "credits": {"$exists": False}}, {"$set": {"credits": 0}})
        if not usr.get("referral_code"):
            await db.users.update_one({"user_id": usr["user_id"]}, {"$set": {"referral_code": secrets.token_hex(3).upper()}})


# ---------------- Security middleware ----------------
# Sliding-window rate limit per client IP on sensitive routes (auth, uploads, payments).
_hits: dict = defaultdict(deque)
RATE_LIMITS = {"/api/auth/": (20, 60), "/api/me/photo": (10, 60), "/api/payments/": (30, 60), "/api/reports": (10, 60), "/api/me/verify-age": (10, 60), "/api/me/verify-host": (5, 60), "/api/admin/": (30, 60)}


@app.middleware("http")
async def security_middleware(request: Request, call_next):
    path = request.url.path
    for prefix, (limit, window) in RATE_LIMITS.items():
        if path.startswith(prefix):
            ip = (request.headers.get("x-forwarded-for") or request.client.host or "?").split(",")[0].strip()
            key = f"{prefix}|{ip}"
            q = _hits[key]
            t = time.monotonic()
            while q and t - q[0] > window:
                q.popleft()
            if len(q) >= limit:
                return Response(content='{"detail":"Too many attempts. Slow down and try again in a minute."}', status_code=429, media_type="application/json", headers={"Retry-After": str(window)})
            q.append(t)
            break
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    response.headers["Cache-Control"] = response.headers.get("Cache-Control", "no-store")
    return response


app.include_router(api)
app.add_middleware(CORSMiddleware, allow_credentials=True, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
