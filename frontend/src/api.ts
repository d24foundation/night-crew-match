const BASE = `${process.env.EXPO_PUBLIC_BACKEND_URL}/api`;

export const TOKEN_KEY = "afterparty_token";
let token: string | null = null;
let storeTier: string | null = null;
let onUnauthorized: (() => void) | null = null;

export const setApiToken = (t: string | null) => { token = t; };
export const setStoreTier = (t: string | null) => { storeTier = t; };
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (storeTier) headers["X-Store-Tier"] = storeTier;
  const r = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && token) onUnauthorized?.();
    const msg = typeof data.detail === "string" ? data.detail : Array.isArray(data.detail) ? data.detail[0]?.msg : `Error ${r.status}`;
    throw new ApiError(r.status, msg);
  }
  return r.json();
}

export type User = {
  user_id: string; name: string; picture?: string | null; city: string; bio: string; age?: number | null;
  vibes: string[]; tier: "free" | "premium" | "super"; verified: boolean; boosted: boolean; email?: string;
  tier_expires?: string | null;
};

export type Party = {
  party_id: string; title: string; description: string; city: string; area: string; starts_at: string;
  vibe: string; house_provided: boolean; drinks_needed: number; chip_in: number; capacity: number; cover: string;
  host_id: string; host: User | null; going_count: number; drinks_count: number; chipin_count: number;
  is_host: boolean; attending: boolean; my_role: string | null; address: string | null;
  can_see_attendees: boolean; attendees: (User & { role: string })[]; attendee_pics: (string | null)[];
};

export const CITIES = ["London", "Manchester", "Ibiza", "Berlin", "Paris", "Amsterdam", "New York", "Dubai", "Lagos"];
export const VIBES = ["House", "Techno", "Afrobeats", "Amapiano", "R&B", "Garage", "Hip-Hop", "Disco", "Chill"];
