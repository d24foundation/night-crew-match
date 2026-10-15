import { Linking, Platform, Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { LinearGradient } from "expo-linear-gradient";

import { api, Party } from "@/src/api";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { Ionicons } from "@/src/ui";

type Upcoming = Party & { minutes_until: number };

export function openDirections(p: Pick<Party, "address" | "city" | "lat" | "lng">) {
  const q = p.address ? encodeURIComponent(`${p.address}, ${p.city}`) : p.lat != null && p.lng != null ? `${p.lat},${p.lng}` : null;
  if (!q) return;
  const url = Platform.select({
    ios: p.address ? `maps:0,0?q=${q}` : `maps:0,0?q=${q}&ll=${q}`,
    default: `https://www.google.com/maps/search/?api=1&query=${q}`,
  })!;
  Linking.openURL(url);
}

// "Starts in 48 min" banner for afters you're going to — polls every minute while the feed is open.
export function ReminderBanner() {
  const s = useStyles();
  const { colors } = useTheme();
  const router = useRouter();
  const q = useQuery({ queryKey: ["reminders"], queryFn: () => api<Upcoming[]>("/reminders/upcoming"), refetchInterval: 60000 });
  const p = q.data?.[0];
  if (!p) return null;
  const m = p.minutes_until;
  const when = m > 1 ? `Starts in ${m} min` : m >= -1 ? "Starting now" : `Started ${Math.abs(m)} min ago`;
  return (
    <Pressable testID="reminder-banner" onPress={() => router.push(`/party/${p.party_id}`)} style={{ marginBottom: spacing.md }}>
      <LinearGradient colors={[colors.brandPrimary, colors.brandSecondary]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.banner}>
        <View style={s.pulse}><Ionicons name="time" size={20} color={colors.onBrandPrimary} /></View>
        <View style={{ flex: 1 }}>
          <Text style={s.when} testID="reminder-when">{when}</Text>
          <Text style={s.title} numberOfLines={1}>{p.title}</Text>
          <Text style={s.sub} numberOfLines={1}>{p.address ?? `${p.area}, ${p.city}`}{p.is_host ? " · you're hosting" : ""}</Text>
        </View>
        {(p.address || p.lat != null) && (
          <Pressable testID="reminder-directions-button" onPress={() => openDirections(p)} style={s.dir} hitSlop={8}>
            <Ionicons name="navigate" size={18} color={colors.brandPrimary} />
            <Text style={s.dirText}>Go</Text>
          </Pressable>
        )}
      </LinearGradient>
    </Pressable>
  );
}

const useStyles = makeStyles((c) => ({
  banner: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.lg },
  pulse: { width: 40, height: 40, borderRadius: 20, backgroundColor: c.brandTertiary, alignItems: "center", justifyContent: "center" },
  when: { color: c.onBrandPrimary, fontSize: 11, fontWeight: "900", letterSpacing: 1, opacity: 0.9 },
  title: { color: c.onBrandPrimary, fontSize: 17, fontWeight: "900" },
  sub: { color: c.onBrandPrimary, opacity: 0.85, fontSize: 12, fontWeight: "600" },
  dir: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: c.onBrandPrimary, paddingHorizontal: 12, height: 40, borderRadius: radius.pill },
  dirText: { color: c.brandPrimary, fontWeight: "900" },
}));
