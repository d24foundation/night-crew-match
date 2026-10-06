import { useState } from "react";
import { ActivityIndicator, Modal, Text, View, useWindowDimensions } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming, ZoomIn } from "react-native-reanimated";
import * as Haptics from "expo-haptics";

import { api, ApiError, User } from "@/src/api";
import { useAuth } from "@/src/auth";
import { usesNativeTabs } from "@/src/navigation";
import { Avatar, Btn, IconBtn, Ionicons, TierBadge, useToast } from "@/src/ui";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

export default function Swipe() {
  const s = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const { user, refresh } = useAuth();
  const q = useQuery({ queryKey: ["discover"], queryFn: () => api<User[]>("/discover") });
  const [idx, setIdx] = useState(0);
  const [match, setMatch] = useState<{ match_id: string; user: User } | null>(null);
  const people = q.data ?? [];
  const current = people[idx];
  const bottomChrome = usesNativeTabs ? insets.bottom : 0;

  const decide = async (like: boolean) => {
    if (!current) return;
    try {
      const r = await api<{ match: { match_id: string; user: User } | null }>("/swipe", { body: { target_id: current.user_id, like } });
      setIdx((i) => i + 1);
      if (r.match) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        setMatch(r.match);
        qc.invalidateQueries({ queryKey: ["chats"] });
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 402) { toast(e.message, "err"); router.push("/premium"); }
      else toast((e as Error).message, "err");
      throw e;
    }
  };

  const boost = async () => {
    if (user?.tier === "free") { router.push("/premium"); return; }
    try { await api("/me/boost", { method: "POST" }); await refresh(); toast("Boosted for 60 min — you're top of the deck"); }
    catch (e) { toast((e as Error).message, "err"); }
  };

  return (
    <View style={[s.root, { paddingTop: insets.top + 8 }]}>
      <View style={s.header}>
        <Text style={s.title}>Who's out tonight</Text>
        <IconBtn testID="boost-button" icon={user?.boosted ? "rocket" : "rocket-outline"} onPress={boost} />
      </View>
      <View style={s.deck}>
        {q.isLoading ? <ActivityIndicator color={colors.brandPrimary} /> : !current ? (
          <View style={s.empty} testID="swipe-empty-state">
            <Ionicons name="people" size={48} color={colors.muted} />
            <Text style={s.emptyTitle}>You've seen everyone</Text>
            <Text style={s.emptySub}>New ravers drop in all night.</Text>
            <Btn title="Refresh" variant="ghost" icon="refresh" onPress={() => { setIdx(0); q.refetch(); }} testID="swipe-refresh-button" />
          </View>
        ) : (
          <>
            {people[idx + 1] && <Card u={people[idx + 1]} behind />}
            <SwipeCard key={current.user_id} u={current} onDecide={decide} />
          </>
        )}
      </View>
      {current && (
        <View style={[s.actions, { paddingBottom: bottomChrome + 16 }]}>
          <ActionBtn testID="swipe-pass-button" icon="close" color={colors.error} onPress={() => decide(false).catch(() => {})} />
          <ActionBtn testID="swipe-like-button" icon="heart" color={colors.brandPrimary} big onPress={() => decide(true).catch(() => {})} />
          <ActionBtn testID="swipe-boost-button" icon="flash" color={colors.gold} onPress={boost} />
        </View>
      )}

      <Modal visible={!!match} transparent animationType="fade" onRequestClose={() => setMatch(null)}>
        <View style={s.matchWrap}>
          <Animated.View entering={ZoomIn.springify()} style={s.matchCard} testID="match-modal">
            <Text style={s.matchTitle}>It's an{"\n"}after party!</Text>
            <View style={s.matchAvatars}>
              <Avatar uri={user?.picture} name={user?.name} size={88} />
              <View style={{ marginLeft: -20 }}><Avatar uri={match?.user.picture} name={match?.user.name} size={88} /></View>
            </View>
            <Text style={s.matchSub}>You and {match?.user.name} are both down for afters.</Text>
            <Btn testID="match-message-button" title="Send a message" icon="chatbubble" onPress={() => { const id = match!.match_id; setMatch(null); router.push(`/chat/${id}`); }} style={{ alignSelf: "stretch" }} />
            <Btn testID="match-keep-swiping-button" title="Keep swiping" variant="ghost" onPress={() => setMatch(null)} style={{ alignSelf: "stretch" }} />
          </Animated.View>
        </View>
      </Modal>
    </View>
  );
}

function ActionBtn({ icon, color, onPress, big, testID }: { icon: any; color: string; onPress: () => void; big?: boolean; testID: string }) {
  const s = useStyles();
  const size = big ? 72 : 58;
  return (
    <Animated.View>
      <View style={[s.action, { width: size, height: size, borderRadius: size / 2, borderColor: color }]}>
        <Ionicons name={icon} size={big ? 34 : 26} color={color} onPress={onPress} testID={testID} suppressHighlighting />
      </View>
    </Animated.View>
  );
}

function SwipeCard({ u, onDecide }: { u: User; onDecide: (like: boolean) => Promise<void> }) {
  const { width } = useWindowDimensions();
  const s = useStyles();
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const fling = (like: boolean) => { onDecide(like).catch(() => { x.value = withSpring(0); y.value = withSpring(0); }); };
  const pan = Gesture.Pan()
    .onUpdate((e) => { x.value = e.translationX; y.value = e.translationY; })
    .onEnd((e) => {
      if (Math.abs(e.translationX) > width * 0.28) {
        const like = e.translationX > 0;
        x.value = withTiming(like ? width * 1.5 : -width * 1.5, { duration: 220 });
        runOnJS(fling)(like);
      } else { x.value = withSpring(0); y.value = withSpring(0); }
    });
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { rotate: `${interpolate(x.value, [-width, width], [-14, 14])}deg` }],
  }));
  const likeO = useAnimatedStyle(() => ({ opacity: interpolate(x.value, [0, 120], [0, 1], "clamp") }));
  const nopeO = useAnimatedStyle(() => ({ opacity: interpolate(x.value, [-120, 0], [1, 0], "clamp") }));
  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[s.cardAbs, style]} testID={`swipe-card-${u.user_id}`}>
        <Card u={u} />
        <Animated.View style={[s.stamp, s.stampLike, likeO]}><Text style={[s.stampText, s.stampLikeText]}>DOWN</Text></Animated.View>
        <Animated.View style={[s.stamp, s.stampNope, nopeO]}><Text style={[s.stampText, s.stampNopeText]}>NAH</Text></Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

function Card({ u, behind }: { u: User; behind?: boolean }) {
  const s = useStyles();
  const { colors } = useTheme();
  return (
    <View style={[s.card, behind && s.cardAbs, behind && { transform: [{ scale: 0.95 }], opacity: 0.6 }]}>
      {u.picture ? <Image source={{ uri: u.picture }} style={s.photo} contentFit="cover" /> : <View style={[s.photo, { backgroundColor: colors.brandTertiary }]} />}
      <LinearGradient colors={["transparent", colors.surface]} locations={[0.45, 1]} style={s.photo} />
      {u.boosted && <View style={s.boostTag}><Ionicons name="rocket" size={12} color={colors.onGold} /><Text style={s.boostText}>BOOSTED</Text></View>}
      <View style={s.info}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={s.name}>{u.name}{u.age ? `, ${u.age}` : ""}</Text>
          <TierBadge tier={u.tier} />
        </View>
        <Text style={s.city}><Ionicons name="location" size={14} color={colors.brandSecondary} /> {u.city}</Text>
        {!!u.bio && <Text style={s.bio} numberOfLines={2}>{u.bio}</Text>}
        <View style={s.vibes}>{u.vibes.map((v) => <View key={v} style={s.vibe}><Text style={s.vibeText}>{v}</Text></View>)}</View>
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: spacing.md, marginBottom: spacing.sm },
  title: { color: c.onSurface, fontSize: 28, fontWeight: "900", letterSpacing: -1 },
  deck: { flex: 1, marginHorizontal: spacing.md, alignItems: "center", justifyContent: "center" },
  card: { width: "100%", height: "100%", borderRadius: radius.lg, overflow: "hidden", backgroundColor: c.surfaceSecondary, borderWidth: 1, borderColor: c.border },
  cardAbs: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  photo: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  info: { position: "absolute", left: 20, right: 20, bottom: 20, gap: 6 },
  name: { color: c.onSurface, fontSize: 32, fontWeight: "900", letterSpacing: -1 },
  city: { color: c.onSurfaceSecondary, fontWeight: "700" },
  bio: { color: c.onSurfaceSecondary, fontSize: 15, lineHeight: 21 },
  vibes: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
  vibe: { backgroundColor: c.brandTertiary, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  vibeText: { color: c.onBrandTertiary, fontWeight: "700", fontSize: 12 },
  boostTag: { position: "absolute", top: 16, left: 16, flexDirection: "row", gap: 4, alignItems: "center", backgroundColor: c.gold, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  boostText: { color: c.onGold, fontWeight: "900", fontSize: 11 },
  stamp: { position: "absolute", top: 40, paddingHorizontal: 14, paddingVertical: 6, borderWidth: 4, borderRadius: 10 },
  stampLike: { left: 24, borderColor: c.brandSecondary, transform: [{ rotate: "-14deg" }] },
  stampNope: { right: 24, borderColor: c.error, transform: [{ rotate: "14deg" }] },
  stampText: { fontSize: 34, fontWeight: "900" },
  stampLikeText: { color: c.brandSecondary },
  stampNopeText: { color: c.error },
  actions: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 24, paddingTop: 16 },
  action: { borderWidth: 2, alignItems: "center", justifyContent: "center", backgroundColor: c.surfaceSecondary },
  empty: { alignItems: "center", gap: 10 },
  emptyTitle: { color: c.onSurface, fontSize: 20, fontWeight: "800" },
  emptySub: { color: c.muted, marginBottom: 8 },
  matchWrap: { flex: 1, backgroundColor: c.scrim, alignItems: "center", justifyContent: "center", padding: spacing.lg },
  matchCard: { width: "100%", maxWidth: 380, backgroundColor: c.surfaceSecondary, borderRadius: radius.lg, padding: spacing.lg, alignItems: "center", gap: spacing.md, borderWidth: 1, borderColor: c.brandPrimary },
  matchTitle: { color: c.brandPrimary, fontSize: 40, fontWeight: "900", textAlign: "center", letterSpacing: -1.5, lineHeight: 40 },
  matchAvatars: { flexDirection: "row" },
  matchSub: { color: c.onSurfaceSecondary, textAlign: "center", fontSize: 15 },
}));
