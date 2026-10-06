import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, Party } from "@/src/api";
import { Avatar, Btn, formatStart, IconBtn, Ionicons, useToast } from "@/src/ui";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

// Landing screen for shared invite links: /invite/<code>
export default function Invite() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const s = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["invite", code], queryFn: () => api<Party>(`/invites/${code}`), retry: false });
  const [busy, setBusy] = useState(false);
  const p = q.data;

  const accept = async () => {
    setBusy(true);
    try {
      const r = await api<Party>(`/invites/${code}/accept`, { body: { role: "chipin" } });
      qc.setQueryData(["party", r.party_id], r);
      qc.invalidateQueries({ queryKey: ["parties"] });
      qc.invalidateQueries({ queryKey: ["chats"] });
      toast(r.is_host ? "This is your party" : "You're in — address unlocked");
      router.replace(`/party/${r.party_id}`);
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };

  const home = () => (router.canGoBack() ? router.back() : router.replace("/(tabs)"));

  return (
    <View style={s.root}>
      <View style={[s.top, { paddingTop: insets.top + 8 }]}><IconBtn testID="invite-close-button" icon="close" onPress={home} /></View>
      {q.isLoading ? <ActivityIndicator color={colors.brandPrimary} style={{ marginTop: 80 }} /> : !p ? (
        <View style={s.center} testID="invite-expired">
          <Ionicons name="link" size={44} color={colors.muted} />
          <Text style={s.title}>This invite has expired</Text>
          <Text style={s.sub}>Ask your friend for a fresh link, or find tonight's afters on the map.</Text>
          <Btn title="Browse afters" onPress={home} />
        </View>
      ) : (
        <View style={s.center}>
          <View style={s.card} testID="invite-card">
            <Image source={{ uri: p.cover }} style={s.cover} contentFit="cover" />
            <LinearGradient colors={["transparent", colors.surfaceSecondary]} style={s.shade} />
            <View style={s.body}>
              <Text style={s.kicker}>YOU'RE INVITED</Text>
              <Text style={s.title} testID="invite-party-title">{p.title}</Text>
              <Text style={s.sub}>{formatStart(p.starts_at)} · {p.area}, {p.city}</Text>
              <View style={s.host}>
                <Avatar uri={p.host?.picture} name={p.host?.name} size={32} />
                <Text style={s.hostText}>{p.host?.name} is hosting · {p.going_count}/{p.capacity} going</Text>
              </View>
            </View>
          </View>
          <Btn testID="invite-accept-button" title={p.attending || p.is_host ? "Open the party" : "I'm in — join the afters"} icon="flame" loading={busy} onPress={accept} style={{ alignSelf: "stretch" }} />
          <Text style={s.fine}>Invite links skip the free daily join limit. Address and group chat unlock once you're in.</Text>
        </View>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  top: { paddingHorizontal: spacing.md },
  center: { flex: 1, padding: spacing.lg, gap: spacing.md, justifyContent: "center", alignItems: "center" },
  card: { alignSelf: "stretch", borderRadius: radius.lg, overflow: "hidden", backgroundColor: c.surfaceSecondary, borderWidth: 1, borderColor: c.border },
  cover: { width: "100%", height: 200 },
  shade: { position: "absolute", top: 100, left: 0, right: 0, height: 100 },
  body: { padding: spacing.md, gap: 6 },
  kicker: { color: c.brandSecondary, fontWeight: "900", fontSize: 12, letterSpacing: 1.5 },
  title: { color: c.onSurface, fontSize: 26, fontWeight: "900", letterSpacing: -0.5, textAlign: "center" },
  sub: { color: c.onSurfaceTertiary, fontWeight: "600", textAlign: "center" },
  host: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  hostText: { color: c.onSurfaceSecondary, fontWeight: "700" },
  fine: { color: c.muted, fontSize: 12, textAlign: "center" },
}));
