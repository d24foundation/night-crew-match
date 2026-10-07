import { useState } from "react";
import { Modal, Text, TextInput, View } from "react-native";

import { api, User } from "@/src/api";
import { useAuth } from "@/src/auth";
import { Btn, Ionicons } from "@/src/ui";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

// "12/03/1999" → "1999-03-12" (or null if not a real date)
export function dobToIso(v: string): string | null {
  const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  if (dt.getFullYear() !== Number(y) || dt.getMonth() !== Number(mo) - 1 || dt.getDate() !== Number(d)) return null;
  return `${y}-${mo}-${d}`;
}

// Auto-insert slashes while typing digits
export function formatDob(v: string) {
  const d = v.replace(/\D/g, "").slice(0, 8);
  return d.length > 4 ? `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}` : d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
}

// Blocking 18+ gate for accounts that signed in with Google/Apple and have no birthday yet.
export function AgeGate() {
  const s = useStyles();
  const { colors } = useTheme();
  const { user, setUser, logout } = useAuth();
  const [dob, setDob] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (!user || user.age_verified) return null;

  const submit = async () => {
    const iso = dobToIso(dob);
    if (!iso) { setErr("Enter your birthday as DD/MM/YYYY"); return; }
    setErr(""); setBusy(true);
    try { setUser(await api<User>("/me/verify-age", { body: { dob: iso } })); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Modal visible transparent animationType="fade">
      <View style={s.wrap}>
        <View style={s.card} testID="age-gate">
          <Ionicons name="shield-checkmark" size={36} color={colors.brandSecondary} />
          <Text style={s.title}>18+ only</Text>
          <Text style={s.sub}>After Party is for adults. Confirm your birthday to continue — it's never shown publicly.</Text>
          <TextInput testID="age-gate-dob-input" style={s.input} placeholder="DD/MM/YYYY" placeholderTextColor={colors.muted} keyboardType="number-pad" value={dob} onChangeText={(v) => setDob(formatDob(v))} maxLength={10} />
          {!!err && <Text style={s.err} testID="age-gate-error">{err}</Text>}
          <Btn testID="age-gate-submit-button" title="Confirm I'm 18+" icon="checkmark" loading={busy} onPress={submit} style={{ alignSelf: "stretch" }} />
          <Btn testID="age-gate-logout-button" title="Log out" variant="ghost" onPress={logout} style={{ alignSelf: "stretch" }} />
        </View>
      </View>
    </Modal>
  );
}

const useStyles = makeStyles((c) => ({
  wrap: { flex: 1, backgroundColor: c.scrim, alignItems: "center", justifyContent: "center", padding: spacing.lg },
  card: { width: "100%", maxWidth: 380, backgroundColor: c.surfaceSecondary, borderRadius: radius.lg, padding: spacing.lg, alignItems: "center", gap: 12, borderWidth: 1, borderColor: c.border },
  title: { color: c.onSurface, fontSize: 26, fontWeight: "900" },
  sub: { color: c.onSurfaceTertiary, textAlign: "center", fontSize: 15, lineHeight: 21 },
  input: { alignSelf: "stretch", height: 52, borderRadius: radius.md, backgroundColor: c.surfaceTertiary, color: c.onSurface, paddingHorizontal: spacing.md, fontSize: 18, textAlign: "center", borderWidth: 1, borderColor: c.border, letterSpacing: 1 },
  err: { color: c.error, fontWeight: "700" },
}));
