import { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeInDown } from "react-native-reanimated";

import { api, CITIES, Party } from "@/src/api";
import { useAuth } from "@/src/auth";
import { usesNativeTabs } from "@/src/navigation";
import { Avatar, Btn, Chip, formatStart, Ionicons, TierBadge, useToast, Wordmark } from "@/src/ui";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

export default function Parties() {
  const s = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const [city, setCity] = useState(user?.city ?? "London");
  const q = useQuery({ queryKey: ["parties", city], queryFn: () => api<Party[]>(`/parties?city=${encodeURIComponent(city)}`) });
  const bottomChrome = usesNativeTabs ? insets.bottom : 0;

  return (
    <View style={s.root}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <View style={s.titleRow}>
          <View style={{ gap: 4 }}>
            <Wordmark size={32} testID="feed-logo" />
            <Text style={s.sub} testID="feed-subtitle">{q.data?.length ?? 0} afters near {city === "All" ? "you" : city}</Text>
          </View>
          {user?.tier === "free" && (
            <Pressable testID="header-premium-button" onPress={() => router.push("/premium")} style={s.goPro}>
              <Ionicons name="flash" size={14} color={colors.onGold} />
              <Text style={s.goProText}>GO PRO</Text>
            </Pressable>
          )}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.chipRow} contentContainerStyle={s.chipContent}>
          {["All", ...CITIES].map((c) => (
            <Chip key={c} testID={`city-chip-${c}`} label={c} selected={city === c} onPress={() => setCity(c)} />
          ))}
        </ScrollView>
      </View>

      {q.isLoading ? (
        <ActivityIndicator color={colors.brandPrimary} style={{ marginTop: 48 }} />
      ) : (
        <FlatList
          testID="party-list"
          data={q.data ?? []}
          keyExtractor={(p) => p.party_id}
          contentContainerStyle={{ padding: spacing.md, paddingBottom: bottomChrome + 96, gap: spacing.md }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={colors.brandPrimary} />}
          ListEmptyComponent={
            <View style={s.empty} testID="party-empty-state">
              <Ionicons name="moon" size={44} color={colors.muted} />
              <Text style={s.emptyTitle}>No afters in {city} yet</Text>
              <Text style={s.emptySub}>Be the legend who starts it.</Text>
              <Btn title="Host one" icon="add" onPress={() => router.push("/party/create")} testID="empty-host-button" />
            </View>
          }
          renderItem={({ item, index }) => <PartyCard p={item} index={index} onPress={() => router.push(`/party/${item.party_id}`)} />}
          ListHeaderComponent={(q.data?.length ?? 0) > 0 ? <VibeMatcher /> : null}
        />
      )}

      <Pressable testID="host-party-fab" onPress={() => router.push("/party/create")} style={[s.fab, { bottom: bottomChrome + 16 }]}>
        <Ionicons name="add" size={22} color={colors.onBrandSecondary} />
        <Text style={s.fabText}>Host afters</Text>
      </Pressable>
    </View>
  );
}

function PartyCard({ p, index, onPress }: { p: Party; index: number; onPress: () => void }) {
  const s = useStyles();
  const { colors } = useTheme();
  const full = p.going_count >= p.capacity;
  return (
    <Animated.View entering={FadeInDown.delay(index * 60).duration(400)}>
      <Pressable testID={`party-card-${p.party_id}`} onPress={onPress} style={s.card}>
        <Image source={{ uri: p.cover }} style={s.cover} contentFit="cover" transition={250} />
        <LinearGradient colors={["transparent", colors.scrim]} style={s.coverShade} />
        <View style={s.coverTop}>
          <View style={s.timePill}><Ionicons name="time" size={12} color={colors.onBrandSecondary} /><Text style={s.timeText}>{formatStart(p.starts_at)}</Text></View>
          <View style={s.vibePill}><Text style={s.vibeText}>{p.vibe}</Text></View>
        </View>
        <View style={s.coverBottom}>
          <Text style={s.cardTitle} numberOfLines={1}>{p.title}</Text>
          <Text style={s.cardArea}><Ionicons name="location" size={12} color={colors.onSurfaceTertiary} /> {p.area}, {p.city}</Text>
        </View>
        <View style={s.cardBody}>
          <View style={s.hostRow}>
            <Avatar uri={p.host?.picture} name={p.host?.name} size={28} />
            <Text style={s.hostName}>{p.host?.name}</Text>
            {p.host && <TierBadge tier={p.host.tier} />}
            <View style={{ flex: 1 }} />
            <View style={s.stack}>
              {p.attendee_pics.slice(0, 3).map((u, i) => (
                <View key={i} style={{ marginLeft: i ? -10 : 0 }}><Avatar uri={u} size={24} ring /></View>
              ))}
            </View>
            <Text style={[s.going, full && { color: colors.error }]}>{full ? "FULL" : `${p.going_count}/${p.capacity}`}</Text>
          </View>
          <View style={s.roles}>
            <Role icon="home" label={p.house_provided ? "House sorted" : "Need a house"} on={p.house_provided} />
            <Role icon="wine" label={`${p.drinks_count}/${p.drinks_needed} drinks`} on={p.drinks_count >= p.drinks_needed} />
            <Role icon="cash" label={`£${p.chip_in} chip-in`} on />
          </View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

type VibePick = { party_id: string; title: string; cover: string; vibe: string; area: string; reason: string };

function VibeMatcher() {
  const s = useStyles();
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const [pick, setPick] = useState<VibePick | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { setPick(await api<VibePick>("/ai/vibe-match", { method: "POST" })); }
    catch (e) { toast((e as Error).message, "err"); }
    finally { setBusy(false); }
  };
  if (!pick) {
    return (
      <Pressable testID="vibe-match-button" onPress={run} disabled={busy} style={s.vibeCta}>
        {busy ? <ActivityIndicator color={colors.onBrandSecondary} /> : <Ionicons name="sparkles" size={22} color={colors.onBrandSecondary} />}
        <View style={{ flex: 1 }}>
          <Text style={s.vibeCtaTitle}>{busy ? "Reading the room..." : "Find my vibe"}</Text>
          <Text style={s.vibeCtaSub}>AI picks tonight's best afters for you</Text>
        </View>
        <Ionicons name="arrow-forward" size={20} color={colors.onBrandSecondary} />
      </Pressable>
    );
  }
  return (
    <Animated.View entering={FadeInDown} style={s.vibeResult} testID="vibe-match-result">
      <Image source={{ uri: pick.cover }} style={s.vibeImg} contentFit="cover" />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.vibeLabel}>YOUR VIBE MATCH</Text>
        <Text style={s.vibeTitle} numberOfLines={1}>{pick.title}</Text>
        <Text style={s.vibeReason} numberOfLines={2}>{pick.reason}</Text>
        <View style={{ flexDirection: "row", gap: 12, marginTop: 6 }}>
          <Text testID="vibe-match-open" onPress={() => router.push(`/party/${pick.party_id}`)} style={s.vibeLink}>Open party</Text>
          <Text testID="vibe-match-retry" onPress={run} style={[s.vibeLink, { color: colors.muted }]}>Try again</Text>
        </View>
      </View>
    </Animated.View>
  );
}

function Role({ icon, label, on }: { icon: any; label: string; on: boolean }) {
  const s = useStyles();
  const { colors } = useTheme();
  return (
    <View style={s.role}>
      <Ionicons name={icon} size={14} color={on ? colors.brandSecondary : colors.warning} />
      <Text style={s.roleText}>{label}</Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: { backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.divider },
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: spacing.md },
  logo: { color: c.brandPrimary, fontSize: 34, fontWeight: "900", letterSpacing: -1.5 },
  sub: { color: c.onSurfaceTertiary, fontWeight: "600", marginTop: 2 },
  goPro: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: c.gold, paddingHorizontal: 12, height: 32, borderRadius: radius.pill },
  goProText: { color: c.onGold, fontWeight: "900", fontSize: 12 },
  chipRow: { height: 56, flexGrow: 0 },
  chipContent: { paddingHorizontal: spacing.md, gap: spacing.sm, alignItems: "center" },
  card: { backgroundColor: c.surfaceSecondary, borderRadius: radius.lg, overflow: "hidden", borderWidth: 1, borderColor: c.border },
  cover: { height: 170, width: "100%" },
  coverShade: { position: "absolute", top: 70, left: 0, right: 0, height: 100 },
  coverTop: { position: "absolute", top: 12, left: 12, right: 12, flexDirection: "row", justifyContent: "space-between" },
  timePill: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: c.brandSecondary, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  timeText: { color: c.onBrandSecondary, fontWeight: "800", fontSize: 12 },
  vibePill: { backgroundColor: c.scrim, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  vibeText: { color: c.onSurface, fontWeight: "700", fontSize: 12 },
  coverBottom: { position: "absolute", top: 112, left: 14, right: 14 },
  cardTitle: { color: c.onSurface, fontSize: 21, fontWeight: "900", letterSpacing: -0.5 },
  cardArea: { color: c.onSurfaceTertiary, fontWeight: "600", marginTop: 2 },
  cardBody: { padding: 14, gap: 12 },
  hostRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  hostName: { color: c.onSurface, fontWeight: "700" },
  stack: { flexDirection: "row" },
  going: { color: c.brandSecondary, fontWeight: "900" },
  roles: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  role: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: c.surfaceTertiary, paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.sm },
  roleText: { color: c.onSurfaceSecondary, fontSize: 12, fontWeight: "700" },
  empty: { alignItems: "center", gap: 10, paddingTop: 60 },
  emptyTitle: { color: c.onSurface, fontSize: 20, fontWeight: "800" },
  emptySub: { color: c.muted, marginBottom: 8 },
  vibeCta: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.lg, backgroundColor: c.brandSecondary },
  vibeCtaTitle: { color: c.onBrandSecondary, fontWeight: "900", fontSize: 17 },
  vibeCtaSub: { color: c.onBrandSecondary, opacity: 0.75, fontWeight: "600" },
  vibeResult: { flexDirection: "row", gap: 12, padding: 12, borderRadius: radius.lg, backgroundColor: c.surfaceSecondary, borderWidth: 1.5, borderColor: c.brandSecondary },
  vibeImg: { width: 76, height: 76, borderRadius: radius.md },
  vibeLabel: { color: c.brandSecondary, fontWeight: "900", fontSize: 11, letterSpacing: 1 },
  vibeTitle: { color: c.onSurface, fontWeight: "900", fontSize: 16 },
  vibeReason: { color: c.onSurfaceTertiary, fontSize: 13 },
  vibeLink: { color: c.brandPrimary, fontWeight: "800" },
  fab: { position: "absolute", right: 16, height: 52, borderRadius: 26, paddingHorizontal: 20, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: c.brandSecondary, shadowColor: c.brandSecondary, shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  fabText: { color: c.onBrandSecondary, fontWeight: "900", fontSize: 15 },
}));
