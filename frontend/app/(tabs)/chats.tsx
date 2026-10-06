import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api";
import { usesNativeTabs } from "@/src/navigation";
import { Avatar, Ionicons } from "@/src/ui";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

type ChatItem = { chat_id: string; title: string; kind: "party" | "match"; picture?: string | null; subtitle: string };

export default function Chats() {
  const s = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const q = useQuery({ queryKey: ["chats"], queryFn: () => api<ChatItem[]>("/chats"), refetchInterval: 8000 });
  const bottomChrome = usesNativeTabs ? insets.bottom : 0;

  return (
    <View style={[s.root, { paddingTop: insets.top + 8 }]}>
      <Text style={s.title}>Chats</Text>
      {q.isLoading ? <ActivityIndicator color={colors.brandPrimary} style={{ marginTop: 40 }} /> : (
        <FlatList
          testID="chat-list"
          data={q.data ?? []}
          keyExtractor={(c) => c.chat_id}
          contentContainerStyle={{ paddingBottom: bottomChrome + 24 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={colors.brandPrimary} />}
          ListEmptyComponent={
            <View style={s.empty} testID="chats-empty-state">
              <Ionicons name="chatbubbles-outline" size={44} color={colors.muted} />
              <Text style={s.emptyTitle}>No chats yet</Text>
              <Text style={s.emptySub}>Join a party or match with someone to start the group chat.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable testID={`chat-row-${item.chat_id}`} onPress={() => router.push(`/chat/${item.chat_id}`)} style={({ pressed }) => [s.row, pressed && { backgroundColor: colors.surfaceSecondary }]}>
              <Avatar uri={item.picture} name={item.title} size={52} />
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text style={s.rowTitle} numberOfLines={1}>{item.title}</Text>
                  <View style={[s.kind, item.kind === "party" ? { backgroundColor: colors.brandTertiary } : { backgroundColor: colors.surfaceTertiary }]}>
                    <Text style={[s.kindText, { color: item.kind === "party" ? colors.onBrandTertiary : colors.brandSecondary }]}>{item.kind === "party" ? "PARTY" : "MATCH"}</Text>
                  </View>
                </View>
                <Text style={s.rowSub} numberOfLines={1}>{item.subtitle}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.muted} />
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  title: { color: c.onSurface, fontSize: 28, fontWeight: "900", letterSpacing: -1, paddingHorizontal: spacing.md, marginBottom: spacing.sm },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: spacing.md, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.divider },
  rowTitle: { color: c.onSurface, fontWeight: "800", fontSize: 16, flexShrink: 1 },
  rowSub: { color: c.muted, marginTop: 2 },
  kind: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm },
  kindText: { fontSize: 10, fontWeight: "900" },
  empty: { alignItems: "center", gap: 8, paddingTop: 80, paddingHorizontal: spacing.xl },
  emptyTitle: { color: c.onSurface, fontSize: 20, fontWeight: "800" },
  emptySub: { color: c.muted, textAlign: "center" },
}));
