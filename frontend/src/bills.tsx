import { useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, TextInput, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";

import { api } from "@/src/api";
import { Sheet } from "@/src/sheet";
import { makeStyles, radius, useTheme } from "@/src/theme";
import { Avatar, Btn, Ionicons, useToast } from "@/src/ui";

export type Bill = {
  bill_id: string; chat_id: string; title: string; amount: number; creator_id: string; creator_name: string; created_at: string;
  people: { user_id: string; name: string; picture?: string | null; share: number; paid: boolean; method?: string | null }[];
  my_share: number | null; my_paid: boolean; is_creator: boolean; settled: boolean; collected: number;
};

export function useBills(chatId: string, enabled: boolean) {
  return useQuery({ queryKey: ["bills", chatId], queryFn: () => api<Bill[]>(`/chats/${chatId}/bills`), enabled });
}

// Split-the-bill sheet for party group chats: add a bill, see who owes what, settle by card or mark cash.
export function BillsSheet({ chatId, visible, onClose }: { chatId: string; visible: boolean; onClose: () => void }) {
  const s = useStyles();
  const { colors } = useTheme();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useBills(chatId, visible);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const bills = q.data ?? [];
  const owed = bills.filter((b) => !b.my_paid && b.my_share != null).reduce((a, b) => a + (b.my_share ?? 0), 0);

  const refresh = () => qc.invalidateQueries({ queryKey: ["bills", chatId] });

  const add = async () => {
    const amt = parseFloat(amount.replace(",", "."));
    if (!title.trim() || !(amt > 0)) { toast("Add a name and an amount", "err"); return; }
    setBusy("add");
    try {
      await api(`/chats/${chatId}/bills`, { body: { title: title.trim(), amount: Math.round(amt * 100) / 100 } });
      setTitle(""); setAmount(""); setAdding(false);
      refresh();
      toast("Bill split with everyone in the party");
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(null); }
  };

  const pay = async (b: Bill) => {
    setBusy(b.bill_id);
    try {
      const origin = Platform.OS === "web" && typeof window !== "undefined" ? window.location.origin : process.env.EXPO_PUBLIC_BACKEND_URL!;
      const r = await api<{ url: string; session_id: string }>("/payments/checkout", { body: { bill_id: b.bill_id, origin_url: origin } });
      if (Platform.OS === "web") { window.location.href = r.url; return; }
      await WebBrowser.openBrowserAsync(r.url);
      for (let i = 0; i < 8; i++) {
        const st = await api<{ payment_status: string }>(`/payments/status/${r.session_id}`);
        if (st.payment_status === "paid") { toast("Settled — money sent 🎉"); refresh(); break; }
        await new Promise((res) => setTimeout(res, 2000));
      }
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(null); }
  };

  const markPaid = async (b: Bill, userId: string) => {
    try { await api(`/bills/${b.bill_id}/mark-paid`, { body: { user_id: userId } }); refresh(); toast("Marked as paid in cash"); }
    catch (e) { toast((e as Error).message, "err"); }
  };

  const remove = async (b: Bill) => {
    try { await api(`/bills/${b.bill_id}`, { method: "DELETE" }); refresh(); toast("Bill removed"); }
    catch (e) { toast((e as Error).message, "err"); }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Split the bill" sub={owed > 0 ? `You owe £${owed.toFixed(2)} across ${bills.filter((b) => !b.my_paid).length} bill${bills.filter((b) => !b.my_paid).length === 1 ? "" : "s"}` : "Drinks, Ubers, mixers — split it, settle it, done."} testID="bills-sheet">
      {!adding ? (
        <Btn testID="add-bill-button" title="Add a bill" icon="add-circle" onPress={() => setAdding(true)} />
      ) : (
        <View style={s.form} testID="bill-form">
          <TextInput testID="bill-title-input" style={s.input} placeholder="What was it? (Drinks, Uber…)" placeholderTextColor={colors.muted} value={title} onChangeText={setTitle} maxLength={60} />
          <View style={s.amountRow}>
            <Text style={s.pound}>£</Text>
            <TextInput testID="bill-amount-input" style={[s.input, { flex: 1 }]} placeholder="0.00" placeholderTextColor={colors.muted} keyboardType="decimal-pad" value={amount} onChangeText={setAmount} />
          </View>
          <Text style={s.hint}>Split equally between everyone in this party (host + guests). Pennies round onto you.</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Btn testID="bill-submit-button" title="Split it" icon="git-branch" loading={busy === "add"} onPress={add} style={{ flex: 1 }} />
            <Btn title="Cancel" variant="ghost" onPress={() => setAdding(false)} />
          </View>
        </View>
      )}

      {q.isLoading ? <ActivityIndicator color={colors.brandPrimary} /> : bills.length === 0 ? (
        <Text style={s.hint} testID="bills-empty">No bills yet.</Text>
      ) : bills.map((b) => (
        <View key={b.bill_id} style={[s.bill, b.settled && { borderColor: colors.brandSecondary }]} testID={`bill-${b.bill_id}`}>
          <View style={s.billHead}>
            <View style={{ flex: 1 }}>
              <Text style={s.billTitle}>{b.title}</Text>
              <Text style={s.hint}>£{b.amount.toFixed(2)} · {b.creator_name} paid · £{(b.people[0]?.share ?? 0).toFixed(2)} each{b.settled ? " · all settled ✓" : ""}</Text>
            </View>
            {b.is_creator && !b.settled && (
              <Pressable testID={`bill-delete-${b.bill_id}`} onPress={() => remove(b)} hitSlop={8}><Ionicons name="trash-outline" size={18} color={colors.muted} /></Pressable>
            )}
          </View>
          {!b.my_paid && b.my_share != null && (
            <Btn testID={`bill-pay-${b.bill_id}`} title={`Pay my £${b.my_share.toFixed(2)} by card`} icon="card" variant="lime" loading={busy === b.bill_id} onPress={() => pay(b)} />
          )}
          {b.is_creator && (
            <View style={{ gap: 6 }}>
              {b.people.filter((p) => p.user_id !== b.creator_id).map((p) => (
                <View key={p.user_id} style={s.person} testID={`bill-person-${p.user_id}`}>
                  <Avatar uri={p.picture} name={p.name} size={28} />
                  <Text style={s.personName}>{p.name}</Text>
                  <Text style={[s.personShare, p.paid && { color: colors.brandSecondary }]}>{p.paid ? `✓ ${p.method === "card" ? "card" : "cash"}` : `£${p.share.toFixed(2)}`}</Text>
                  {!p.paid && <Pressable testID={`bill-mark-${p.user_id}`} onPress={() => markPaid(b, p.user_id)} style={s.cash}><Text style={s.cashText}>Got cash</Text></Pressable>}
                </View>
              ))}
              <Text style={s.hint}>£{b.collected.toFixed(2)} collected so far{b.collected > 0 ? " — card payments are in your wallet" : ""}</Text>
            </View>
          )}
        </View>
      ))}
      <Btn title="Done" variant="ghost" onPress={onClose} />
    </Sheet>
  );
}

const useStyles = makeStyles((c) => ({
  form: { gap: 10, padding: 12, borderRadius: radius.md, backgroundColor: c.surfaceSecondary, borderWidth: 1, borderColor: c.border },
  input: { backgroundColor: c.surfaceTertiary, color: c.onSurface, borderRadius: radius.md, padding: 14, fontSize: 16, borderWidth: 1, borderColor: c.border },
  amountRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  pound: { color: c.onSurface, fontSize: 22, fontWeight: "900" },
  hint: { color: c.muted, fontSize: 12 },
  bill: { gap: 10, padding: 12, borderRadius: radius.md, backgroundColor: c.surfaceSecondary, borderWidth: 1, borderColor: c.border },
  billHead: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  billTitle: { color: c.onSurface, fontWeight: "900", fontSize: 16 },
  person: { flexDirection: "row", alignItems: "center", gap: 8 },
  personName: { color: c.onSurface, fontWeight: "700", flex: 1 },
  personShare: { color: c.onSurfaceTertiary, fontWeight: "800" },
  cash: { paddingHorizontal: 10, height: 30, borderRadius: radius.pill, backgroundColor: c.surfaceTertiary, alignItems: "center", justifyContent: "center" },
  cashText: { color: c.onSurface, fontSize: 12, fontWeight: "800" },
}));
