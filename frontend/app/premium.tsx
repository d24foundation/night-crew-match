import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PurchasesPackage } from "react-native-purchases";

import { api, User } from "@/src/api";
import { useAuth } from "@/src/auth";
import { isTestStore, useSubscription } from "@/src/revenuecat";
import { Btn, IconBtn, Ionicons, useToast } from "@/src/ui";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Plan = "premium" | "super";
const PLANS: { key: Plan; name: string; price: string; perks: string[] }[] = [
  { key: "premium", name: "Premium", price: "£3.99", perks: ["Unlimited party joins", "Unlimited likes", "Boost your profile to the top"] },
  { key: "super", name: "Super Premium", price: "£7.99", perks: ["Everything in Premium", "Host priority — your parties go first", "See exactly who's going", "Verified gold badge"] },
];

export default function Premium() {
  const s = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const params = useLocalSearchParams<{ stripe_session?: string }>();
  const { user, setUser, purchaseIdentityError } = useAuth();
  const sub = useSubscription();
  const [plan, setPlan] = useState<Plan>("super");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [confirm, setConfirm] = useState<PurchasesPackage | null>(null);

  const pollStripe = async (sid: string) => {
    setChecking(true);
    for (let i = 0; i < 8; i++) {
      try {
        const r = await api<{ payment_status: string; status: string; user: User }>(`/payments/status/${sid}`);
        if (r.payment_status === "paid") { setUser(r.user); toast(`Welcome to ${r.user.tier === "super" ? "Super Premium" : "Premium"}!`); setChecking(false); return; }
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

  const payStripe = async () => {
    setBusy(true);
    try {
      const origin = Platform.OS === "web" ? window.location.origin : process.env.EXPO_PUBLIC_BACKEND_URL!;
      const r = await api<{ url: string; session_id: string }>("/payments/checkout", { body: { plan, origin_url: origin } });
      if (Platform.OS === "web") { window.location.assign(r.url); return; }
      await WebBrowser.openBrowserAsync(r.url);
      await pollStripe(r.session_id);
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };

  const pkg = plan === "super" ? sub.superPkg : sub.premiumPkg;
  const buyInApp = async (p: PurchasesPackage) => {
    setConfirm(null);
    try {
      await sub.purchase(p);
      toast("Subscription active!");
    } catch (e: any) {
      if (e?.userCancelled) return;
      toast(e?.message === "identity_not_ready" ? "Account not linked yet, try again in a moment" : String(e?.message ?? e), "err");
    }
  };
  const restore = async () => {
    try { await sub.restore(); toast("Purchases restored"); } catch (e: any) { toast(String(e?.message ?? e), "err"); }
  };

  const current = user?.tier ?? "free";

  return (
    <View style={s.root}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24, paddingHorizontal: spacing.md, gap: spacing.md }}>
        <IconBtn testID="premium-close-button" icon="close" onPress={() => router.back()} />
        <Text style={s.title}>Never let{"\n"}the night end.</Text>
        <Text style={s.sub}>Upgrade and get first dibs on every after party in London and beyond.</Text>
        {current !== "free" && (
          <View style={s.active} testID="premium-active-banner">
            <Ionicons name="checkmark-circle" size={20} color={colors.onBrandSecondary} />
            <Text style={s.activeText}>You're on {current === "super" ? "Super Premium" : "Premium"}</Text>
          </View>
        )}
        {checking && <View style={s.active}><ActivityIndicator color={colors.onBrandSecondary} /><Text style={s.activeText}>Confirming payment...</Text></View>}

        {PLANS.map((p) => {
          const on = plan === p.key;
          const rcPrice = (p.key === "super" ? sub.superPkg : sub.premiumPkg)?.product.priceString;
          return (
            <Pressable key={p.key} testID={`plan-${p.key}`} onPress={() => setPlan(p.key)}>
              <LinearGradient colors={on ? (p.key === "super" ? [colors.gold, colors.brandPrimary] : [colors.brandPrimary, colors.brandTertiary]) : [colors.surfaceSecondary, colors.surfaceSecondary]}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[s.plan, !on && { borderColor: colors.border, borderWidth: 1 }]}>
                <View style={s.planHead}>
                  <View style={s.planLeft}>
                    <Text style={s.planName} numberOfLines={2}>{p.name}</Text>
                    {p.key === "super" && <View style={s.pop}><Text style={s.popText}>MOST VIRAL</Text></View>}
                  </View>
                  <Text style={s.price} testID={`plan-${p.key}-price`}>{isTestStore ? p.price : rcPrice ?? p.price}<Text style={s.per}>/mo</Text></Text>
                </View>
                {p.perks.map((perk) => (
                  <View key={perk} style={s.perk}><Ionicons name="checkmark" size={16} color={colors.onSurface} /><Text style={s.perkText}>{perk}</Text></View>
                ))}
              </LinearGradient>
            </Pressable>
          );
        })}

        {!!purchaseIdentityError && <Text style={s.err} testID="purchase-identity-error">Account link issue: {purchaseIdentityError}</Text>}

        {sub.isLoading ? <ActivityIndicator color={colors.brandPrimary} /> : pkg ? (
          <Btn testID="subscribe-in-app-button" title={`Subscribe in app${isTestStore ? " (simulated)" : ""}`} icon="phone-portrait" variant={plan === "super" ? "gold" : "primary"}
            disabled={!sub.identityReady || sub.isPurchasing} loading={sub.isPurchasing}
            onPress={() => (isTestStore ? setConfirm(pkg) : buyInApp(pkg))} />
        ) : (
          <Text style={s.muted}>In-app subscription options are unavailable right now. Please try again later.</Text>
        )}
        <Btn testID="pay-with-card-button" title={`Pay ${PLANS.find((x) => x.key === plan)!.price} with card`} icon="card" variant="ghost" loading={busy} onPress={payStripe} />
        <Pressable testID="restore-purchases-button" onPress={restore} style={{ alignItems: "center", padding: 8 }}>
          <Text style={s.link}>{sub.isRestoring ? "Restoring..." : "Restore purchases"}</Text>
        </Pressable>
        <Text style={s.fine}>Monthly, cancel anytime. Card payments give 30 days access.</Text>
      </ScrollView>

      <Modal visible={!!confirm} transparent animationType="fade" onRequestClose={() => setConfirm(null)}>
        <View style={s.modalWrap}>
          <View style={s.modal} testID="purchase-confirm-modal">
            <Text style={s.modalTitle}>Simulated purchase</Text>
            <Text style={s.muted}>This is a test-store purchase of {confirm?.product.title} ({confirm?.product.priceString}). No real money is charged.</Text>
            <Btn testID="confirm-purchase-button" title="Confirm" onPress={() => confirm && buyInApp(confirm)} />
            <Btn testID="cancel-purchase-button" title="Cancel" variant="ghost" onPress={() => setConfirm(null)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  title: { color: c.onSurface, fontSize: 40, fontWeight: "900", letterSpacing: -1.5, lineHeight: 42 },
  sub: { color: c.onSurfaceTertiary, fontSize: 15 },
  active: { flexDirection: "row", gap: 8, alignItems: "center", backgroundColor: c.brandSecondary, padding: 12, borderRadius: radius.md },
  activeText: { color: c.onBrandSecondary, fontWeight: "800" },
  plan: { borderRadius: radius.lg, padding: spacing.md, gap: 8 },
  planHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
  planLeft: { flex: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  planName: { color: c.onSurface, fontSize: 20, fontWeight: "900", flexShrink: 1 },
  pop: { backgroundColor: c.surface, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill },
  popText: { color: c.gold, fontSize: 10, fontWeight: "900" },
  price: { color: c.onSurface, fontSize: 24, fontWeight: "900", flexShrink: 0 },
  per: { fontSize: 13, fontWeight: "600" },
  perk: { flexDirection: "row", gap: 8, alignItems: "center" },
  perkText: { color: c.onSurface, fontWeight: "600" },
  err: { color: c.error, fontWeight: "600" },
  muted: { color: c.muted, textAlign: "center" },
  link: { color: c.brandSecondary, fontWeight: "700" },
  fine: { color: c.muted, fontSize: 12, textAlign: "center" },
  modalWrap: { flex: 1, backgroundColor: c.scrim, justifyContent: "center", padding: spacing.lg },
  modal: { backgroundColor: c.surfaceSecondary, borderRadius: radius.lg, padding: spacing.lg, gap: 12 },
  modalTitle: { color: c.onSurface, fontSize: 20, fontWeight: "900" },
}));
