import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, Share, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import * as WebBrowser from "expo-web-browser";
import * as Clipboard from "expo-clipboard";

import { api, referralLink, User } from "@/src/api";
import { useAuth } from "@/src/auth";
import { Btn, IconBtn, Ionicons, useToast } from "@/src/ui";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Pack = { price: number; credits: number; label: string };
type Credits = { balance: number; packs: Record<string, Pack>; ledger: { entry_id: string; amount: number; reason: string; created_at: string }[]; costs: { boost: number; extra_join: number; promote: number; referral: number } };
type Referral = { code: string; invited: number; earned: number; reward: number };

const REASONS: Record<string, string> = { purchase: "Credits purchased", boost: "Boost (60 min)", extra_join: "Extra join", promote: "Party promoted", referral_welcome: "Welcome bonus", referral_reward: "Friend joined" };

export default function CreditsScreen() {
  const s = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const { user, setUser } = useAuth();
  const params = useLocalSearchParams<{ stripe_session?: string }>();
  const [pack, setPack] = useState("round");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const q = useQuery({ queryKey: ["credits"], queryFn: () => api<Credits>("/credits") });
  const ref = useQuery({ queryKey: ["referral"], queryFn: () => api<Referral>("/me/referral") });

  const pollStripe = async (sid: string) => {
    setChecking(true);
    for (let i = 0; i < 8; i++) {
      try {
        const r = await api<{ payment_status: string; status: string; user: User }>(`/payments/status/${sid}`);
        if (r.payment_status === "paid") { setUser(r.user); qc.invalidateQueries({ queryKey: ["credits"] }); toast(`Credits added — you have ${r.user.credits}`); setChecking(false); return; }
        if (r.status === "expired") break;
      } catch {}
      await new Promise((res) => setTimeout(res, 2000));
    }
    setChecking(false);
    toast("Payment not confirmed yet", "err");
  };
  useEffect(() => {
    if (params.stripe_session) pollStripe(params.stripe_session);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.stripe_session]);

  const buy = async () => {
    setBusy(true);
    try {
      const origin = Platform.OS === "web" ? window.location.origin : process.env.EXPO_PUBLIC_BACKEND_URL!;
      const r = await api<{ url: string; session_id: string }>("/payments/checkout", { body: { pack, origin_url: origin } });
      if (Platform.OS === "web") { window.location.assign(r.url); return; }
      await WebBrowser.openBrowserAsync(r.url);
      await pollStripe(r.session_id);
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };

  const shareReferral = async () => {
    if (!ref.data) return;
    const url = referralLink(ref.data.code);
    const message = `I'm on After Party — the app for finding afters after the club 🔥 Join with my link and we both get ${ref.data.reward} free credits: ${url}`;
    try {
      if (Platform.OS === "web") { await Clipboard.setStringAsync(url); toast("Invite link copied"); return; }
      await Share.share(Platform.OS === "ios" ? { message, url } : { message });
    } catch (e) { toast((e as Error).message, "err"); }
  };

  const packs = q.data?.packs ?? {};
  const selected = packs[pack];
  return (
    <View style={s.root}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <IconBtn testID="credits-back-button" icon="chevron-back" onPress={() => router.back()} />
        <Text style={s.hTitle}>Credits</Text>
        <View style={{ width: 44 }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: insets.bottom + 24 }}>
        <LinearGradient colors={[colors.brandSecondary, colors.brandTertiary]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.balance}>
          <Text style={s.balLabel}>YOUR BALANCE</Text>
          <Text style={s.balNum} testID="credits-balance">{q.data?.balance ?? user?.credits ?? 0}</Text>
          <Text style={s.balSub}>credits · boost {q.data?.costs.boost ?? 5} · extra join {q.data?.costs.extra_join ?? 2} · promote party {q.data?.costs.promote ?? 10}</Text>
        </LinearGradient>

        {checking && <View style={s.checking}><ActivityIndicator color={colors.brandSecondary} /><Text style={s.muted}>Confirming your payment…</Text></View>}

        <Text style={s.section}>Top up from £1</Text>
        <View style={{ flexDirection: "row", gap: 10 }}>
          {Object.entries(packs).map(([key, p]) => (
            <Pressable key={key} testID={`pack-${key}`} onPress={() => setPack(key)} style={[s.pack, pack === key && s.packOn]}>
              {key === "round" && <View style={s.pop}><Text style={s.popText}>POPULAR</Text></View>}
              <Text style={s.packCredits}>{p.credits}</Text>
              <Text style={s.packLabel}>credits</Text>
              <Text style={s.packPrice} testID={`pack-${key}-price`}>£{p.price.toFixed(2)}</Text>
            </Pressable>
          ))}
        </View>
        <Btn testID="buy-credits-button" title={selected ? `Buy ${selected.credits} credits for £${selected.price.toFixed(2)}` : "Buy credits"} icon="card" loading={busy} onPress={buy} />
        <Text style={s.fine}>One-off payment via Stripe in GBP. Credits never expire.</Text>

        <Pressable testID="referral-card" onPress={shareReferral} style={s.refer}>
          <Ionicons name="gift" size={26} color={colors.gold} />
          <View style={{ flex: 1 }}>
            <Text style={s.referTitle}>Invite friends, earn {ref.data?.reward ?? 5} credits each</Text>
            <Text style={s.referSub}>Your code <Text style={{ color: colors.gold, fontWeight: "900" }} testID="referral-code">{ref.data?.code ?? "…"}</Text> · {ref.data?.invited ?? 0} joined · {ref.data?.earned ?? 0} earned</Text>
          </View>
          <Ionicons name="share-social" size={20} color={colors.gold} />
        </Pressable>

        <Text style={s.section}>History</Text>
        {(q.data?.ledger ?? []).length === 0 ? <Text style={s.muted} testID="ledger-empty">No activity yet.</Text> : (q.data?.ledger ?? []).map((e) => (
          <View key={e.entry_id} style={s.row} testID={`ledger-${e.entry_id}`}>
            <Text style={s.rowText}>{REASONS[e.reason] ?? e.reason}</Text>
            <Text style={[s.rowAmt, { color: e.amount > 0 ? colors.brandSecondary : colors.onSurfaceTertiary }]}>{e.amount > 0 ? "+" : ""}{e.amount}</Text>
          </View>
        ))}
        <Btn title="Want unlimited? See Premium" variant="ghost" icon="flash" onPress={() => router.push("/premium")} testID="credits-to-premium-button" />
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, paddingBottom: 8 },
  hTitle: { color: c.onSurface, fontSize: 18, fontWeight: "900" },
  balance: { borderRadius: radius.lg, padding: spacing.lg, alignItems: "center", gap: 4 },
  balLabel: { color: c.onBrandSecondary, fontWeight: "900", fontSize: 12, letterSpacing: 1, opacity: 0.8 },
  balNum: { color: c.onBrandSecondary, fontWeight: "900", fontSize: 56, lineHeight: 60 },
  balSub: { color: c.onBrandSecondary, opacity: 0.8, fontSize: 12, fontWeight: "700", textAlign: "center" },
  checking: { flexDirection: "row", gap: 10, alignItems: "center", justifyContent: "center" },
  section: { color: c.onSurface, fontWeight: "900", fontSize: 18, marginTop: 4 },
  pack: { flex: 1, alignItems: "center", padding: 14, borderRadius: radius.md, backgroundColor: c.surfaceSecondary, borderWidth: 2, borderColor: c.border, gap: 2 },
  packOn: { borderColor: c.brandSecondary },
  pop: { position: "absolute", top: -10, backgroundColor: c.gold, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill },
  popText: { color: c.onGold, fontWeight: "900", fontSize: 9 },
  packCredits: { color: c.onSurface, fontWeight: "900", fontSize: 28 },
  packLabel: { color: c.onSurfaceTertiary, fontSize: 12, fontWeight: "700" },
  packPrice: { color: c.brandSecondary, fontWeight: "900", fontSize: 18, marginTop: 4 },
  fine: { color: c.muted, fontSize: 12, textAlign: "center" },
  refer: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.md, backgroundColor: c.surfaceSecondary, borderWidth: 1.5, borderColor: c.gold },
  referTitle: { color: c.onSurface, fontWeight: "900", fontSize: 15 },
  referSub: { color: c.onSurfaceTertiary, fontSize: 13, marginTop: 2 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.divider },
  rowText: { color: c.onSurface, fontWeight: "600" },
  rowAmt: { fontWeight: "900", fontSize: 16 },
  muted: { color: c.muted },
}));
