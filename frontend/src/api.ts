import { Platform } from "react-native";

const BASE = `${process.env.EXPO_PUBLIC_BACKEND_URL}/api`;

export const TOKEN_KEY = "afterparty_token";
let token: string | null = null;
let storeTier: string | null = null;
let onUnauthorized: (() => void) | null = null;

export const setApiToken = (t: string | null) => { token = t; };
export const getApiToken = () => token;
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
  tier_expires?: string | null; rating_avg?: number | null; rating_count?: number; age_verified?: boolean; credits?: number;
  host_verified?: boolean; host_verification_status?: "pending" | "approved" | "rejected" | null; is_admin?: boolean;
};

export type Party = {
  party_id: string; title: string; description: string; city: string; area: string; starts_at: string;
  vibe: string; house_provided: boolean; drinks_needed: number; chip_in: number; capacity: number; cover: string;
  host_id: string; host: User | null; going_count: number; drinks_count: number; chipin_count: number;
  is_host: boolean; attending: boolean; my_role: string | null; address: string | null;
  can_see_attendees: boolean; attendees: (User & { role: string; checked_in: boolean; paid: boolean })[]; attendee_pics: (string | null)[];
  lat: number | null; lng: number | null; distance_km: number | null; invite_code: string | null;
  started: boolean; checked_in_count: number; promoted: boolean; paid_count: number; collected: number | null; my_paid: boolean;
};

export const wsUrl = (path: string) => `${process.env.EXPO_PUBLIC_BACKEND_URL!.replace(/^http/, "ws")}/api${path}`;

// Profile photos are stored as "/api/files/<id>" and served by our backend; absolute URLs pass through.
export const resolveUri = (uri?: string | null) => (!uri ? uri : uri.startsWith("/") ? `${process.env.EXPO_PUBLIC_BACKEND_URL}${uri}` : uri);

export const inviteLink = (code: string) => `${process.env.EXPO_PUBLIC_BACKEND_URL}/invite/${code}`;
export const referralLink = (code: string) => `${process.env.EXPO_PUBLIC_BACKEND_URL}/r/${code}`;
export const partyLink = (id: string) => `${process.env.EXPO_PUBLIC_BACKEND_URL}/party/${id}`;

export async function uploadPhoto(file: { uri: string; name: string; type: string }): Promise<User> {
  return uploadFiles<User>("/me/photo", { file });
}

export async function uploadFiles<T>(path: string, files: Record<string, { uri: string; name: string; type: string }>): Promise<T> {
  const form = new FormData();
  for (const [field, file] of Object.entries(files)) {
    if (Platform.OS === "web") {
      const blob = await (await fetch(file.uri)).blob();
      form.append(field, blob, file.name);
    } else {
      form.append(field, file as any);
    }
  }
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers, body: form });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new ApiError(r.status, typeof data.detail === "string" ? data.detail : `Upload failed (${r.status})`);
  }
  return r.json();
}

export const fmtDistance = (km: number | null | undefined) => km == null ? null : km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;

export const CITIES = ["London", "Manchester", "Ibiza", "Berlin", "Paris", "Amsterdam", "New York", "Dubai", "Lagos"];
export const CITY_COORDS: Record<string, [number, number]> = {
  London: [51.5074, -0.1278], Manchester: [53.4808, -2.2426], Ibiza: [38.9067, 1.4206], Berlin: [52.52, 13.405], Paris: [48.8566, 2.3522],
  Amsterdam: [52.3676, 4.9041], "New York": [40.7128, -74.006], Dubai: [25.2048, 55.2708], Lagos: [6.5244, 3.3792],
};
export const VIBES = ["House", "Techno", "Afrobeats", "Amapiano", "R&B", "Garage", "Hip-Hop", "Disco", "Chill"];
