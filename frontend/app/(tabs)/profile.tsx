import { ScrollView, Text, View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";

import { useAuth } from "@/src/auth";
import { usesNativeTabs } from "@/src/navigation";
import { Avatar, Btn, Ionicons, TierBadge } from "@/src/ui";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

export default function Profile() {
  const s = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, logout } = useAuth();
  const bottomChrome = usesNativeTabs ? insets.bottom : 0;
  if (!user) return null;

  return (
    <ScrollView style={s.root} contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: bottomChrome + 24, paddingHorizontal: spacing.md, gap: spacing.md }}>
      <View style={s.top}>
        <Avatar uri={user.picture} name={user.name} size={96} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={s.name} testID="profile-name">{user.name}{user.age ? `, ${user.age}` : ""}</Text>
          <TierBadge tier={user.tier} testID="profile-tier-badge" />
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

      <View style={s.card}>
        <Row icon="mail-outline" label={user.email ?? ""} />
        <Row icon="shield-checkmark-outline" label="Safety: meet in groups, share your location with a friend" />
      </View>

      <Btn testID="logout-button" title="Log out" variant="ghost" icon="log-out-outline" onPress={logout} />
    </ScrollView>
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
