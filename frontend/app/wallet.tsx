import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";

import { api } from "@/src/api";
import { Sheet } from "@/src/sheet";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { Btn, Chip, IconBtn, Ionicons, useToast } from "@/src/ui";

type Ledger = { entry_id: string; amount: number; gross?: number; fee?: number; type: "chipin" | "payout"; party_title?: string; from_name?: string | null; status?: string; created_at: string };
type Wallet = { balance: number; earned: number; fee_pct: number; min_payout: number; ledger: Ledger[]; payout_method: { method: string; account_name: string; details_masked: string } | null };
type Method = "bank" | "paypal" | "revolut";

const METHODS: { key: Method; label: string; hint: string }[] = [
  { key: "bank", label: "UK bank", hint: "Sort code + account number" },
  { key: "paypal", label: "PayPal", hint: "PayPal email" },
  { key: "revolut", label: "Revolut", hint: "@revtag or phone" },
];

export default function WalletScreen() {
  const s = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["wallet"], queryFn: () => api<Wallet>("/wallet") });
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const w = q.data;

  const payout = async () => {
    if (!w) return;
    if (!w.payout_method) { setEdit(true); return; }
    setBusy(true);
    try {
      const r = await api<{ amount: number; eta: string }>("/wallet/payout", { method: "POST" });
      toast(`£${r.amount.toFixed(2)} on its way — arrives by ${new Date(r.eta).toLocaleDateString()}`);
      qc.invalidateQueries({ queryKey: ["wallet"] });
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };

  return (
    <View style={s.root}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <IconBtn testID="wallet-back-button" icon="chevron-back" onPress={() => router.back()} />
        <Text style={s.title}>Host wallet</Text>
        <View style={{ width: 44 }} />
      </View>
      {!w ? <ActivityIndicator color={colors.brandPrimary} style={{ marginTop: 40 }} /> : (
        <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: insets.bottom + 24 }}>
          <LinearGradient colors={[colors.brandSecondary, colors.brandPrimary]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.hero}>
            <Text style={s.heroLabel}>AVAILABLE TO WITHDRAW</Text>
            <Text style={s.heroAmt} testID="wallet-balance">£{w.balance.toFixed(2)}</Text>
            <Text style={s.heroSub}>£{w.earned.toFixed(2)} earned in total · we keep {w.fee_pct}% per chip-in</Text>
          </LinearGradient>

          <Btn testID="payout-button" title={w.payout_method ? `Send £${w.balance.toFixed(2)} to my ${METHODS.find((m) => m.key === w.payout_method!.method)?.label ?? "account"}` : "Add where to send my money"} icon={w.payout_method ? "arrow-up-circle" : "wallet"} loading={busy} disabled={!!w.payout_method && w.balance < w.min_payout} onPress={payout} />
          <Text style={s.fine}>Minimum payout £{w.min_payout.toFixed(2)}. Payouts are sent automatically and usually land in 1–2 business days.</Text>

          <Pressable testID="payout-method-row" onPress={() => setEdit(true)} style={s.card}>
            <Ionicons name="card-outline" size={20} color={colors.brandSecondary} />
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{w.payout_method ? `${w.payout_method.account_name} · ${w.payout_method.details_masked}` : "No payout method yet"}</Text>
              <Text style={s.muted}>{w.payout_method ? METHODS.find((m) => m.key === w.payout_method!.method)?.label : "Bank, PayPal or Revolut"}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>

          <Text style={s.section}>Activity</Text>
          {w.ledger.length === 0 && <Text style={s.muted} testID="wallet-empty">Chip-ins from your guests will show up here. Host an afters and set a chip-in to start earning.</Text>}
          {w.ledger.map((e) => (
            <View key={e.entry_id} style={s.row} testID={`wallet-${e.entry_id}`}>
              <Ionicons name={e.type === "payout" ? "arrow-up-circle" : "cash"} size={18} color={e.type === "payout" ? colors.onSurfaceTertiary : colors.brandSecondary} />
              <View style={{ flex: 1 }}>
                <Text style={s.rowText}>{e.type === "payout" ? `Payout · ${e.status}` : `${e.from_name ?? "Guest"} chipped in · ${e.party_title}`}</Text>
                <Text style={s.muted}>{new Date(e.created_at).toLocaleString()}{e.gross != null ? ` · £${e.gross.toFixed(2)} − £${(e.fee ?? 0).toFixed(2)} fee` : ""}</Text>
              </View>
              <Text style={[s.rowAmt, { color: e.amount > 0 ? colors.brandSecondary : colors.onSurfaceTertiary }]}>{e.amount > 0 ? "+" : ""}£{Math.abs(e.amount).toFixed(2)}</Text>
            </View>
          ))}
        </ScrollView>
      )}
      <PayoutMethodSheet visible={edit} onClose={() => setEdit(false)} initial={w?.payout_method?.method as Method | undefined} />
    </View>
  );
}

function PayoutMethodSheet({ visible, onClose, initial }: { visible: boolean; onClose: () => void; initial?: Method }) {
  const s = useStyles();
  const { colors } = useTheme();
  const toast = useToast();
  const qc = useQueryClient();
  const [method, setMethod] = useState<Method>(initial ?? "bank");
  const [name, setName] = useState("");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const hint = METHODS.find((m) => m.key === method)!.hint;

  const save = async () => {
    setBusy(true);
    try {
      await api("/wallet/payout-method", { method: "PUT", body: { method, account_name: name.trim(), details: details.trim() } });
      qc.invalidateQueries({ queryKey: ["wallet"] });
      toast("Payout details saved");
      onClose();
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Where should we send your money?" sub="Stored securely and only shown masked." testID="payout-method-sheet">
      <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {METHODS.map((m) => <Chip key={m.key} testID={`method-${m.key}`} label={m.label} selected={method === m.key} onPress={() => setMethod(m.key)} />)}
        </View>
        <TextInput testID="payout-name-input" style={s.input} placeholder="Account holder name" placeholderTextColor={colors.muted} value={name} onChangeText={setName} />
        <TextInput testID="payout-details-input" style={s.input} placeholder={hint} placeholderTextColor={colors.muted} value={details} onChangeText={setDetails} autoCapitalize="none" />
        <Btn testID="payout-save-button" title="Save" loading={busy} disabled={name.trim().length < 2 || details.trim().length < 4} onPress={save} />
        <Btn title="Cancel" variant="ghost" onPress={onClose} />
      </KeyboardAwareScrollView>
    </Sheet>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, paddingBottom: 8 },
  title: { color: c.onSurface, fontSize: 18, fontWeight: "900" },
  hero: { borderRadius: radius.lg, padding: spacing.lg, gap: 4 },
  heroLabel: { color: c.onBrandPrimary, opacity: 0.8, fontSize: 11, fontWeight: "900", letterSpacing: 1 },
  heroAmt: { color: c.onBrandPrimary, fontSize: 44, fontWeight: "900" },
  heroSub: { color: c.onBrandPrimary, opacity: 0.85, fontWeight: "600" },
  fine: { color: c.muted, fontSize: 12, textAlign: "center" },
  card: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.md, backgroundColor: c.surfaceSecondary, borderWidth: 1, borderColor: c.border },
  cardTitle: { color: c.onSurface, fontWeight: "800" },
  muted: { color: c.muted, fontSize: 12 },
  section: { color: c.onSurface, fontSize: 16, fontWeight: "900", marginTop: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.divider },
  rowText: { color: c.onSurface, fontWeight: "600" },
  rowAmt: { fontWeight: "900", fontSize: 16 },
  input: { backgroundColor: c.surfaceTertiary, color: c.onSurface, borderRadius: radius.md, padding: 14, fontSize: 16, borderWidth: 1, borderColor: c.border },
}));
