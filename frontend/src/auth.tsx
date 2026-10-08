import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import Purchases from "react-native-purchases";
import { useQueryClient } from "@tanstack/react-query";

import { api, setApiToken, setStoreTier, setUnauthorizedHandler, TOKEN_KEY, User } from "@/src/api";
import { storage } from "@/src/utils/storage";
import { rcEnabled, useSubscription } from "@/src/revenuecat";

WebBrowser.maybeCompleteAuthSession();

type Ctx = {
  user: User | null;
  loading: boolean;
  purchaseIdentityError: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string, dob: string, ref?: string | null) => Promise<void>;
  googleLogin: () => Promise<void>;
  appleLogin: (identityToken: string, name?: string | null, email?: string | null) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  setUser: (u: User) => void;
};
const AuthContext = createContext<Ctx>(null!);

const extractSessionId = (url: string | null | undefined) => {
  if (!url) return null;
  const m = url.match(/[?#&]session_id=([^&#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [purchaseIdentityError, setPurchaseIdentityError] = useState<string | null>(null);
  const sent = useRef(new Set<string>());
  const rcIdentityRef = useRef<string | null>(null);
  const qc = useQueryClient();
  const { storeTier } = useSubscription();

  const saveSession = useCallback(async (token: string, u: User) => {
    setApiToken(token);
    await storage.secureSet(TOKEN_KEY, token);
    setUser(u);
  }, []);

  const clear = useCallback(async () => {
    setApiToken(null);
    await storage.secureRemove(TOKEN_KEY);
    qc.clear();
    setUser(null);
  }, [qc]);

  const exchange = useCallback(async (sessionId: string) => {
    if (sent.current.has(sessionId)) return false;
    sent.current.add(sessionId);
    const r = await api<{ token: string; user: User }>("/auth/session", { body: { session_id: sessionId } });
    await saveSession(r.token, r.user);
    return true;
  }, [saveSession]);

  useEffect(() => {
    setUnauthorizedHandler(() => { clear(); });
    (async () => {
      try {
        if (Platform.OS === "web" && typeof window !== "undefined") {
          const sid = extractSessionId(window.location.hash) ?? extractSessionId(window.location.search);
          if (sid) {
            try {
              await exchange(sid);
              const url = new URL(window.location.href);
              url.searchParams.delete("session_id");
              url.hash = url.hash.replace(/session_id=[^&]+&?/, "").replace(/^#$/, "");
              window.history.replaceState(window.history.state, "", url.toString());
              return;
            } catch {}
          }
        } else {
          const sid = extractSessionId(await Linking.getInitialURL());
          if (sid) {
            try { if (await exchange(sid)) return; } catch {}
          }
        }
        const t = await storage.secureGet(TOKEN_KEY, "");
        if (t) {
          setApiToken(t);
          try { setUser(await api<User>("/auth/me")); } catch { await clear(); }
        }
      } finally {
        setLoading(false);
      }
    })();
    if (Platform.OS === "web") return;
    const sub = Linking.addEventListener("url", ({ url }) => {
      const sid = extractSessionId(url);
      if (sid) exchange(sid).catch(() => {});
    });
    return () => sub.remove();
  }, [clear, exchange]);

  // RevenueCat identity binding — required before any purchase
  useEffect(() => {
    if (!rcEnabled) return;
    (async () => {
      try {
        if (user?.user_id && rcIdentityRef.current !== user.user_id) {
          await Purchases.logIn(user.user_id);
          rcIdentityRef.current = user.user_id;
          setPurchaseIdentityError(null);
        } else if (!user?.user_id && rcIdentityRef.current) {
          await Purchases.logOut();
          rcIdentityRef.current = null;
        }
      } catch (e) {
        setPurchaseIdentityError(String(e));
      }
    })();
  }, [user?.user_id]);

  const refresh = useCallback(async () => {
    try { setUser(await api<User>("/auth/me")); } catch {}
  }, []);

  // Sync in-app subscription tier to API calls
  useEffect(() => {
    setStoreTier(storeTier);
    if (user) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeTier]);

  const login = async (email: string, password: string) => {
    const r = await api<{ token: string; user: User }>("/auth/login", { body: { email, password } });
    await saveSession(r.token, r.user);
  };
  const register = async (name: string, email: string, password: string, dob: string, ref?: string | null) => {
    const r = await api<{ token: string; user: User }>("/auth/register", { body: { name, email, password, dob, ref: ref || undefined } });
    await saveSession(r.token, r.user);
  };
  const appleLogin = async (identityToken: string, name?: string | null, email?: string | null) => {
    const r = await api<{ token: string; user: User }>("/auth/apple", { body: { identity_token: identityToken, name, email } });
    await saveSession(r.token, r.user);
  };
  const googleLogin = async () => {
    if (Platform.OS === "web") {
      const redirect = window.location.origin + "/";
      window.location.href = `https://auth.emergentagent.com/?redirect=${encodeURIComponent(redirect)}`;
      return;
    }
    const redirect = Linking.createURL("");
    let captured: string | null = null;
    const sub = Linking.addEventListener("url", ({ url }) => { captured = url; });
    try {
      const res = await WebBrowser.openAuthSessionAsync(
        `https://auth.emergentagent.com/?redirect=${encodeURIComponent(redirect)}`, redirect);
      const url = (res.type === "success" ? res.url : null) ?? captured ?? (await Linking.getInitialURL());
      const sid = extractSessionId(url);
      if (sid) await exchange(sid);
    } finally {
      sub.remove();
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, purchaseIdentityError, login, register, googleLogin, appleLogin, logout: clear, refresh, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
