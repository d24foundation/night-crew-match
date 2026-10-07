import { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/src/api";
import { Btn, Ionicons, useToast } from "@/src/ui";
import { Sheet } from "@/src/sheet";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

// Small "★ 4.8 (12)" host trust score
export function Rating({ avg, count, size = 12, testID }: { avg?: number | null; count?: number; size?: number; testID?: string }) {
  const { colors } = useTheme();
  if (!avg) return null;
  return (
    <View testID={testID} style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
      <Ionicons name="star" size={size} color={colors.gold} />
      <Text style={{ color: colors.gold, fontWeight: "900", fontSize: size }}>{avg.toFixed(1)}</Text>
      {!!count && <Text style={{ color: colors.muted, fontWeight: "700", fontSize: size - 1 }}>({count})</Text>}
    </View>
  );
}

// Guest rating card shown on a party page once it has started
export function RateCard({ partyId, hostName, onRated }: { partyId: string; hostName?: string; onRated: () => void }) {
  const s = useStyles();
  const { colors } = useTheme();
  const toast = useToast();
  const [stars, setStars] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const submit = async (n: number) => {
    setStars(n); setBusy(true);
    try {
      await api(`/parties/${partyId}/rate`, { body: { stars: n } });
      setDone(true);
      toast(n >= 4 ? `${hostName ?? "The host"} will love that` : "Thanks — your rating helps keep hosts honest");
      onRated();
    } catch (e) { toast((e as Error).message, "err"); setStars(0); } finally { setBusy(false); }
  };
  return (
    <View style={s.rate} testID="rate-card">
      <Text style={s.rateTitle}>{done ? "You rated this afters" : "How was it?"}</Text>
      <Text style={s.rateSub}>{done ? "Tap a star to change your mind." : `Rate ${hostName ?? "the host"}'s afters — great hosts rise to the top.`}</Text>
      <View style={{ flexDirection: "row", gap: 6, marginTop: 4 }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Pressable key={n} testID={`star-${n}`} disabled={busy} onPress={() => submit(n)} hitSlop={6}>
            <Ionicons name={n <= stars ? "star" : "star-outline"} size={34} color={n <= stars ? colors.gold : colors.muted} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// Attendee's door pass: QR + short code the host scans or types
export function DoorPass({ partyId, visible, onClose }: { partyId: string; visible: boolean; onClose: () => void }) {
  const s = useStyles();
  const { colors } = useTheme();
  const q = useQuery({ queryKey: ["ticket", partyId], queryFn: () => api<{ code: string; qr: string; checked_in: boolean; party_title: string }>(`/parties/${partyId}/ticket`), enabled: visible, refetchInterval: visible ? 5000 : false });
  return (
    <Sheet visible={visible} onClose={onClose} title="Your door pass" sub="Show this at the door. The host scans it to let you in." testID="door-pass-sheet">
      {q.data && (
        <View style={{ alignItems: "center", gap: 12 }}>
          <View style={s.qrBox}><QRCode value={q.data.qr} size={200} backgroundColor={colors.onSurface} color={colors.surface} /></View>
          <Text style={s.code} testID="door-pass-code">{q.data.code}</Text>
          <Text style={s.codeHint}>{q.data.checked_in ? "✓ You're checked in. Have a great one." : "Or give the host this code"}</Text>
        </View>
      )}
      <Btn title="Done" variant="ghost" onPress={onClose} />
    </Sheet>
  );
}

export function CheckinResult({ result, onClose }: { result: { ok: boolean; already: boolean; guest: { name: string; picture?: string | null } } | null; onClose: () => void }) {
  const s = useStyles();
  const { colors } = useTheme();
  return (
    <Modal visible={!!result} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.resWrap} onPress={onClose}>
        <View style={[s.res, { borderColor: result?.already ? colors.warning : colors.brandSecondary }]} testID="checkin-result">
          <Ionicons name={result?.already ? "alert-circle" : "checkmark-circle"} size={56} color={result?.already ? colors.warning : colors.brandSecondary} />
          <Text style={s.resName}>{result?.guest.name}</Text>
          <Text style={s.resSub}>{result?.already ? "Already checked in earlier" : "On the list — let them in!"}</Text>
          <Btn title="Next guest" onPress={onClose} style={{ alignSelf: "stretch" }} testID="checkin-next-button" />
        </View>
      </Pressable>
    </Modal>
  );
}

const useStyles = makeStyles((c) => ({
  rate: { padding: spacing.md, borderRadius: radius.lg, backgroundColor: c.surfaceSecondary, borderWidth: 1.5, borderColor: c.gold, gap: 4 },
  rateTitle: { color: c.onSurface, fontWeight: "900", fontSize: 18 },
  rateSub: { color: c.onSurfaceTertiary, fontSize: 13 },
  qrBox: { padding: 14, borderRadius: radius.lg, backgroundColor: c.onSurface },
  code: { color: c.brandSecondary, fontSize: 30, fontWeight: "900", letterSpacing: 6 },
  codeHint: { color: c.muted, fontSize: 13 },
  resWrap: { flex: 1, backgroundColor: c.scrim, alignItems: "center", justifyContent: "center", padding: spacing.lg },
  res: { width: "100%", maxWidth: 360, backgroundColor: c.surfaceSecondary, borderRadius: radius.lg, padding: spacing.lg, alignItems: "center", gap: 10, borderWidth: 2 },
  resName: { color: c.onSurface, fontSize: 28, fontWeight: "900" },
  resSub: { color: c.onSurfaceTertiary, fontSize: 15 },
}));
