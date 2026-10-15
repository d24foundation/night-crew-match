import { useState } from "react";
import { ActivityIndicator, ScrollView, Text, View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api, User } from "@/src/api";
import { useAuth } from "@/src/auth";
import { usesNativeTabs } from "@/src/navigation";
import { ChangePhotoBadge, usePhotoPicker } from "@/src/photo";
import { Rating } from "@/src/party-extras";
import { StreakCard } from "@/src/streak";
import { Sheet } from "@/src/sheet";
import { Avatar, Btn, Ionicons, TierBadge, useToast } from "@/src/ui";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

export default function Profile() {
  const s = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, logout, setUser } = useAuth();
  const bottomChrome = usesNativeTabs ? insets.bottom : 0;
  const photo = usePhotoPicker(setUser);
  const [blocksOpen, setBlocksOpen] = useState(false);
  if (!user) return null;

  return (
    <ScrollView style={s.root} contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: bottomChrome + 24, paddingHorizontal: spacing.md, gap: spacing.md }}>
      <View style={s.top}>
        <Pressable testID="profile-avatar" onPress={photo.open} style={{ alignItems: "center" }}>
          <Avatar uri={user.picture} name={user.name} size={112} />
          <ChangePhotoBadge onPress={photo.open} />
        </Pressable>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={s.name} testID="profile-name">{user.name}{user.age ? `, ${user.age}` : ""}</Text>
          <TierBadge tier={user.tier} testID="profile-tier-badge" />
          <Rating avg={user.rating_avg} count={user.rating_count} size={14} testID="profile-rating" />
        </View>
        <Text style={s.city}><Ionicons name="location" size={14} color={colors.brandSecondary} /> {user.city}</Text>
        {!!user.bio && <Text style={s.bio}>{user.bio}</Text>}
        <View style={s.vibes}>{user.vibes.map((v) => <View key={v} style={s.vibe}><Text style={s.vibeText}>{v}</Text></View>)}</View>
        <Btn testID="edit-profile-button" title="Edit profile" variant="ghost" icon="create-outline" onPress={() => router.push("/edit-profile")} style={{ alignSelf: "stretch" }} />
      </View>

      <Pressable testID="profile-premium-card" onPress={() => router.push("/premium")}>
        <LinearGradient colors={[colors.brandPrimary, colors.brandTertiary]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.promo}>
          <Ionicons name={user.tier === "free" ? "flash" : "diamond"} size={28} color={colors.onBrandPrimary} />
          <View style={{ flex: 1 }}>
            <Text style={s.promoTitle}>{user.tier === "free" ? "Go Premium from £3.99" : user.tier === "super" ? "You're Super Premium" : "You're Premium"}</Text>
            <Text style={s.promoSub}>{user.tier === "free" ? "Unlimited joins, boosts, see who's going, verified badge" : user.tier_expires ? `Active until ${new Date(user.tier_expires).toLocaleDateString()}` : "Manage your plan"}</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.onBrandPrimary} />
        </LinearGradient>
      </Pressable>

      <StreakCard />

      <View style={s.card}>
        <Pressable testID="wallet-row" onPress={() => router.push("/wallet")} style={s.row}>
          <Ionicons name="wallet-outline" size={18} color={colors.brandSecondary} />
          <Text style={s.rowText}>Host wallet — chip-ins you've earned</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.muted} />
        </Pressable>
        <Pressable testID="credits-row" onPress={() => router.push("/credits")} style={s.row}>
          <Ionicons name="ticket-outline" size={18} color={colors.gold} />
          <Text style={s.rowText}>Credits · <Text style={{ color: colors.gold, fontWeight: "900" }} testID="profile-credits">{user.credits ?? 0}</Text> — top up from £1</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.muted} />
        </Pressable>
        <Pressable testID="referral-row" onPress={() => router.push("/credits")} style={s.row}>
          <Ionicons name="gift-outline" size={18} color={colors.gold} />
          <Text style={s.rowText}>Invite friends — you both get 5 free credits</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.muted} />
        </Pressable>
        <Row icon="mail-outline" label={user.email ?? ""} />
        <Row icon="shield-checkmark-outline" label="Safety: meet in groups, share your location with a friend" />
        <Pressable testID="blocked-users-row" onPress={() => setBlocksOpen(true)} style={s.row}>
          <Ionicons name="ban-outline" size={18} color={colors.onSurfaceTertiary} />
          <Text style={s.rowText}>Blocked users</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.muted} />
        </Pressable>
      </View>

      <Btn testID="logout-button" title="Log out" variant="ghost" icon="log-out-outline" onPress={logout} />
      {photo.ui}
      <BlockedSheet visible={blocksOpen} onClose={() => setBlocksOpen(false)} />
    </ScrollView>
  );
}

function BlockedSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const s = useStyles();
  const toast = useToast();
  const q = useQuery({ queryKey: ["blocks"], queryFn: () => api<User[]>("/me/blocks"), enabled: visible });
  const qc = useQueryClient();
  const unblock = async (u: User) => {
    try {
      await api(`/users/${u.user_id}/block`, { method: "DELETE" });
      qc.invalidateQueries({ queryKey: ["blocks"] });
      qc.invalidateQueries({ queryKey: ["discover"] });
      qc.invalidateQueries({ queryKey: ["chats"] });
      qc.invalidateQueries({ queryKey: ["parties"] });
      toast(`${u.name} unblocked`);
    } catch (e) { toast((e as Error).message, "err"); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Blocked users" sub="Blocked people can't see you anywhere in the app." testID="blocked-sheet">
      {q.isLoading ? <ActivityIndicator /> : (q.data ?? []).length === 0 ? (
        <Text style={s.rowText} testID="blocked-empty">Nobody blocked. Keep it that way.</Text>
      ) : (q.data ?? []).map((u) => (
        <View key={u.user_id} style={s.row} testID={`blocked-${u.user_id}`}>
          <Avatar uri={u.picture} name={u.name} size={36} />
          <Text style={[s.rowText, { fontWeight: "700" }]}>{u.name}</Text>
          <Btn testID={`unblock-${u.user_id}`} title="Unblock" variant="ghost" onPress={() => unblock(u)} style={{ height: 36, paddingHorizontal: 14 }} />
        </View>
      ))}
      <Btn title="Done" variant="ghost" onPress={onClose} />
    </Sheet>
  );
}

function Row({ icon, label }: { icon: any; label: string }) {
  const s = useStyles();
  const { colors } = useTheme();
  return (
    <View style={s.row}>
      <Ionicons name={icon} size={18} color={colors.onSurfaceTertiary} />
      <Text style={s.rowText}>{label}</Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  top: { alignItems: "center", gap: 8 },
  name: { color: c.onSurface, fontSize: 28, fontWeight: "900", letterSpacing: -1 },
  city: { color: c.onSurfaceSecondary, fontWeight: "700" },
  bio: { color: c.onSurfaceTertiary, textAlign: "center", fontSize: 15 },
  vibes: { flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: "center", marginBottom: 8 },
  vibe: { backgroundColor: c.brandTertiary, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  vibeText: { color: c.onBrandTertiary, fontWeight: "700", fontSize: 12 },
  promo: { flexDirection: "row", alignItems: "center", gap: 12, padding: spacing.md, borderRadius: radius.lg },
  promoTitle: { color: c.onBrandPrimary, fontSize: 17, fontWeight: "900" },
  promoSub: { color: c.onBrandPrimary, opacity: 0.85, marginTop: 2 },
  card: { backgroundColor: c.surfaceSecondary, borderRadius: radius.lg, padding: spacing.md, gap: 14, borderWidth: 1, borderColor: c.border },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowText: { color: c.onSurfaceSecondary, flex: 1 },
}));
