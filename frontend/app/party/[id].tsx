import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, ApiError, Party } from "@/src/api";
import { Avatar, Btn, formatStart, IconBtn, Ionicons, TierBadge, useToast } from "@/src/ui";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Role = "drinks" | "chipin" | "house";

export default function PartyDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const s = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["party", id], queryFn: () => api<Party>(`/parties/${id}`) });
  const [role, setRole] = useState<Role>("chipin");
  const [busy, setBusy] = useState(false);
  const p = q.data;

  const act = async (path: string, body?: object) => {
    setBusy(true);
    try {
      const r = await api<Party>(`/parties/${id}/${path}`, { method: "POST", body });
      qc.setQueryData(["party", id], r);
      qc.invalidateQueries({ queryKey: ["parties"] });
      qc.invalidateQueries({ queryKey: ["chats"] });
      toast(path === "join" ? "You're in! Address unlocked" : "You left the party");
    } catch (e) {
      toast((e as Error).message, "err");
      if (e instanceof ApiError && e.status === 402) router.push("/premium");
    } finally { setBusy(false); }
  };

  if (!p) return <View style={[s.root, { justifyContent: "center" }]}><ActivityIndicator color={colors.brandPrimary} /></View>;

  const roles: { key: Role; icon: any; title: string; sub: string }[] = [
    { key: "chipin", icon: "cash", title: `Chip in £${p.chip_in}`, sub: "Split the costs" },
    { key: "drinks", icon: "wine", title: "Bring drinks", sub: `${p.drinks_count}/${p.drinks_needed} covered` },
    ...(!p.house_provided ? [{ key: "house" as Role, icon: "home", title: "Offer my place", sub: "Be the house" }] : []),
  ];

  return (
    <View style={s.root}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 120 }}>
        <View>
          <Image source={{ uri: p.cover }} style={s.hero} contentFit="cover" />
          <LinearGradient colors={["transparent", colors.surface]} style={s.heroShade} />
          <View style={[s.topBar, { top: insets.top + 8 }]}>
            <IconBtn testID="party-back-button" icon="chevron-back" onPress={() => router.back()} />
          </View>
          <View style={s.heroText}>
            <View style={s.timePill}><Ionicons name="time" size={12} color={colors.onBrandSecondary} /><Text style={s.timeText}>{formatStart(p.starts_at)}</Text></View>
            <Text style={s.title} testID="party-title">{p.title}</Text>
            <Text style={s.area}>{p.vibe} · {p.area}, {p.city}</Text>
          </View>
        </View>

        <View style={s.body}>
          <View style={s.hostCard}>
            <Avatar uri={p.host?.picture} name={p.host?.name} size={44} />
            <View style={{ flex: 1 }}>
              <Text style={s.muted}>Hosted by</Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Text style={s.hostName}>{p.host?.name}</Text>
                {p.host && <TierBadge tier={p.host.tier} />}
              </View>
            </View>
            <Text style={s.count} testID="party-going-count">{p.going_count}/{p.capacity}</Text>
          </View>

          <View style={s.stats}>
            <Stat icon="home" label={p.house_provided ? "House sorted" : "Need a house"} ok={p.house_provided} />
            <Stat icon="wine" label={`${p.drinks_count}/${p.drinks_needed} drinks`} ok={p.drinks_count >= p.drinks_needed} />
            <Stat icon="cash" label={`£${p.chip_in} each`} ok />
          </View>

          {!!p.description && <Text style={s.desc}>{p.description}</Text>}

          <View style={s.addr} testID="party-address">
            <Ionicons name={p.address ? "location" : "lock-closed"} size={18} color={p.address ? colors.brandSecondary : colors.muted} />
            <Text style={[s.addrText, !p.address && { color: colors.muted }]}>{p.address ?? "Exact address unlocks when you join"}</Text>
          </View>

          <Text style={s.section}>Who's going</Text>
          {p.can_see_attendees ? (
            <View style={{ gap: 10 }} testID="attendee-list">
              {p.attendees.length === 0 && <Text style={s.muted}>No one yet — be first.</Text>}
              {p.attendees.map((a) => (
                <View key={a.user_id} style={s.att}>
                  <Avatar uri={a.picture} name={a.name} size={36} />
                  <Text style={s.attName}>{a.name}</Text>
                  <TierBadge tier={a.tier} />
                  <View style={{ flex: 1 }} />
                  <Text style={s.attRole}>{a.role === "drinks" ? "Drinks" : a.role === "house" ? "House" : "Chip-in"}</Text>
                </View>
              ))}
            </View>
          ) : (
            <Pressable testID="unlock-attendees-button" onPress={() => router.push("/premium")} style={s.locked}>
              <View style={{ flexDirection: "row" }}>
                {p.attendee_pics.map((u, i) => (
                  <View key={i} style={{ marginLeft: i ? -12 : 0, opacity: 0.35 }}><Avatar uri={u} size={36} ring /></View>
                ))}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.lockedTitle}>{p.going_count - 1} people going</Text>
                <Text style={s.muted}>Super Premium shows you exactly who</Text>
              </View>
              <Ionicons name="lock-closed" size={18} color={colors.gold} />
            </Pressable>
          )}

          {!p.attending && !p.is_host && (
            <>
              <Text style={s.section}>How are you contributing?</Text>
              <View style={{ gap: 10 }}>
                {roles.map((r) => (
                  <Pressable key={r.key} testID={`role-option-${r.key}`} onPress={() => setRole(r.key)} style={[s.roleOpt, role === r.key && s.roleOn]}>
                    <Ionicons name={r.icon} size={22} color={role === r.key ? colors.brandPrimary : colors.onSurfaceTertiary} />
                    <View style={{ flex: 1 }}>
                      <Text style={s.roleTitle}>{r.title}</Text>
                      <Text style={s.muted}>{r.sub}</Text>
                    </View>
                    <Ionicons name={role === r.key ? "radio-button-on" : "radio-button-off"} size={22} color={role === r.key ? colors.brandPrimary : colors.muted} />
                  </Pressable>
                ))}
              </View>
            </>
          )}
        </View>
      </ScrollView>

      <View style={[s.bar, { paddingBottom: insets.bottom + 12 }]}>
        {p.is_host || p.attending ? (
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Btn testID="open-party-chat-button" title="Group chat" icon="chatbubbles" style={{ flex: 1 }} onPress={() => router.push(`/chat/${p.party_id}`)} />
            {p.attending && <Btn testID="leave-party-button" title="Leave" variant="ghost" loading={busy} onPress={() => act("leave")} />}
          </View>
        ) : (
          <Btn testID="join-party-button" title={p.going_count >= p.capacity ? "Party is full" : "I'm down — join"} icon="flame" loading={busy} disabled={p.going_count >= p.capacity} onPress={() => act("join", { role })} />
        )}
      </View>
    </View>
  );
}

function Stat({ icon, label, ok }: { icon: any; label: string; ok: boolean }) {
  const s = useStyles();
  const { colors } = useTheme();
  return (
    <View style={s.stat}>
      <Ionicons name={icon} size={20} color={ok ? colors.brandSecondary : colors.warning} />
      <Text style={s.statText}>{label}</Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  hero: { width: "100%", height: 320 },
  heroShade: { position: "absolute", left: 0, right: 0, bottom: 0, height: 200 },
  topBar: { position: "absolute", left: 16 },
  heroText: { position: "absolute", left: 16, right: 16, bottom: 8, gap: 6 },
  timePill: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: c.brandSecondary, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  timeText: { color: c.onBrandSecondary, fontWeight: "800", fontSize: 12 },
  title: { color: c.onSurface, fontSize: 32, fontWeight: "900", letterSpacing: -1 },
  area: { color: c.onSurfaceTertiary, fontWeight: "600" },
  body: { padding: spacing.md, gap: spacing.md },
  hostCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: c.surfaceSecondary, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: c.border },
  hostName: { color: c.onSurface, fontWeight: "800", fontSize: 16 },
  count: { color: c.brandSecondary, fontWeight: "900", fontSize: 18 },
  muted: { color: c.muted, fontSize: 13 },
  stats: { flexDirection: "row", gap: 8 },
  stat: { flex: 1, alignItems: "center", gap: 6, backgroundColor: c.surfaceSecondary, paddingVertical: 14, borderRadius: radius.md, borderWidth: 1, borderColor: c.border },
  statText: { color: c.onSurfaceSecondary, fontWeight: "700", fontSize: 12 },
  desc: { color: c.onSurfaceSecondary, fontSize: 15, lineHeight: 22 },
  addr: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderRadius: radius.md, backgroundColor: c.surfaceTertiary },
  addrText: { color: c.onSurface, fontWeight: "700", flex: 1 },
  section: { color: c.onSurface, fontSize: 18, fontWeight: "900", marginTop: 4 },
  att: { flexDirection: "row", alignItems: "center", gap: 10 },
  attName: { color: c.onSurface, fontWeight: "700" },
  attRole: { color: c.brandSecondary, fontWeight: "700", fontSize: 12 },
  locked: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.md, borderWidth: 1, borderColor: c.gold, backgroundColor: c.surfaceSecondary },
  lockedTitle: { color: c.onSurface, fontWeight: "800" },
  roleOpt: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.md, backgroundColor: c.surfaceSecondary, borderWidth: 1.5, borderColor: c.border },
  roleOn: { borderColor: c.brandPrimary },
  roleTitle: { color: c.onSurface, fontWeight: "800", fontSize: 15 },
  bar: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: spacing.md, paddingTop: 12, backgroundColor: c.surface, borderTopWidth: 1, borderTopColor: c.divider },
}));
