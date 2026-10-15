import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/src/api";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { Ionicons } from "@/src/ui";

type Streak = { current: number; best: number; nights: number; this_weekend_done: boolean; next_reward: number; badges: { name: string; icon: string; at: number; unlocked: boolean }[] };

export function StreakCard() {
  const s = useStyles();
  const { colors } = useTheme();
  const q = useQuery({ queryKey: ["streak"], queryFn: () => api<Streak>("/me/streak") });
  const d = q.data;
  if (!d) return null;
  return (
    <View style={s.card} testID="streak-card">
      <View style={s.top}>
        <View style={s.flame}><Ionicons name="flame" size={26} color={d.current > 0 ? colors.gold : colors.muted} /></View>
        <View style={{ flex: 1 }}>
          <Text style={s.big} testID="streak-current">{d.current} weekend{d.current === 1 ? "" : "s"} in a row</Text>
          <Text style={s.sub}>
            {d.this_weekend_done ? "This weekend's done — see you next Friday." : `Go out this weekend and get checked in or rate the afters → +${d.next_reward} credit${d.next_reward === 1 ? "" : "s"}`}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={s.best}>BEST</Text>
          <Text style={s.bestNum}>{d.best}</Text>
        </View>
      </View>
      <View style={s.badges}>
        {d.badges.map((b) => (
          <View key={b.name} style={[s.badge, b.unlocked && s.badgeOn]} testID={`badge-${b.at}`}>
            <Ionicons name={b.icon as any} size={16} color={b.unlocked ? colors.onGold : colors.muted} />
            <Text style={[s.badgeText, b.unlocked && { color: colors.onGold }]}>{b.name}</Text>
            <Text style={[s.badgeAt, b.unlocked && { color: colors.onGold }]}>{b.at}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  card: { backgroundColor: c.surfaceSecondary, borderRadius: radius.lg, padding: spacing.md, gap: 12, borderWidth: 1, borderColor: c.border },
  top: { flexDirection: "row", alignItems: "center", gap: 12 },
  flame: { width: 48, height: 48, borderRadius: 24, backgroundColor: c.surfaceTertiary, alignItems: "center", justifyContent: "center" },
  big: { color: c.onSurface, fontSize: 17, fontWeight: "900" },
  sub: { color: c.onSurfaceTertiary, fontSize: 12, marginTop: 2 },
  best: { color: c.muted, fontSize: 10, fontWeight: "900", letterSpacing: 1 },
  bestNum: { color: c.gold, fontSize: 22, fontWeight: "900" },
  badges: { flexDirection: "row", gap: 8 },
  badge: { flex: 1, alignItems: "center", gap: 2, paddingVertical: 8, borderRadius: radius.md, backgroundColor: c.surfaceTertiary },
  badgeOn: { backgroundColor: c.gold },
  badgeText: { color: c.muted, fontSize: 10, fontWeight: "800" },
  badgeAt: { color: c.muted, fontSize: 10 },
}));
