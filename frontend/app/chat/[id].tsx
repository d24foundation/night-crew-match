import { useRef, useState } from "react";
import { ActivityIndicator, FlatList, Platform, Pressable, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { Avatar, IconBtn, Ionicons, useToast } from "@/src/ui";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Msg = { message_id: string; sender_id: string; sender_name: string; sender_picture?: string | null; text: string; created_at: string };
type Chat = { chat_id: string; title: string; kind: string; picture?: string | null; messages: Msg[] };

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const s = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [text, setText] = useState("");
  const list = useRef<FlatList>(null);
  const q = useQuery({ queryKey: ["chat", id], queryFn: () => api<Chat>(`/chats/${id}`), refetchInterval: 3000 });

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    try {
      await api(`/chats/${id}`, { body: { text: t } });
      await qc.invalidateQueries({ queryKey: ["chat", id] });
      qc.invalidateQueries({ queryKey: ["chats"] });
    } catch (e) { setText(t); toast((e as Error).message, "err"); }
  };

  const [wing, setWing] = useState(false);
  const icebreaker = async () => {
    setWing(true);
    try {
      const r = await api<{ text: string }>(`/ai/icebreaker/${id}`, { method: "POST" });
      setText(r.text);
    } catch (e) { toast((e as Error).message, "err"); } finally { setWing(false); }
  };

  const msgs = q.data?.messages ?? [];

  return (
    <View style={s.root}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <IconBtn testID="chat-back-button" icon="chevron-back" onPress={() => router.back()} />
        <Avatar uri={q.data?.picture} name={q.data?.title} size={36} />
        <View style={{ flex: 1 }}>
          <Text style={s.title} numberOfLines={1} testID="chat-title">{q.data?.title ?? "..."}</Text>
          <Text style={s.sub}>{q.data?.kind === "party" ? "Party group chat" : "Match"}</Text>
        </View>
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <FlatList
          ref={list}
          testID="message-list"
          data={msgs}
          keyExtractor={(m) => m.message_id}
          contentContainerStyle={{ padding: spacing.md, gap: 8, flexGrow: 1 }}
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
          ListEmptyComponent={<View style={s.empty}><Ionicons name="sparkles" size={36} color={colors.brandSecondary} /><Text style={s.emptyText}>Kick it off — who's bringing what?</Text></View>}
          renderItem={({ item }) => {
            const mine = item.sender_id === user?.user_id;
            return (
              <View style={[s.msgRow, mine && { justifyContent: "flex-end" }]}>
                {!mine && <Avatar uri={item.sender_picture} name={item.sender_name} size={28} />}
                <View style={[s.bubble, mine ? s.mine : s.theirs]}>
                  {!mine && q.data?.kind === "party" && <Text style={s.sender}>{item.sender_name}</Text>}
                  <Text style={[s.msg, mine && { color: colors.onBrandPrimary }]}>{item.text}</Text>
                </View>
              </View>
            );
          }}
        />
        <View style={[s.inputBar, { paddingBottom: insets.bottom + 8 }]}>
          {q.data?.kind === "match" && (
            <Pressable testID="ai-icebreaker-button" onPress={icebreaker} disabled={wing} style={s.wing}>
              {wing ? <ActivityIndicator color={colors.onBrandSecondary} size="small" /> : <Ionicons name="sparkles" size={20} color={colors.onBrandSecondary} />}
            </Pressable>
          )}
          <TextInput testID="chat-input" style={s.input} placeholder="Message..." placeholderTextColor={colors.muted} value={text} onChangeText={setText} onSubmitEditing={send} returnKeyType="send" />
          <Pressable testID="chat-send-button" onPress={send} style={s.send}>
            <Ionicons name="arrow-up" size={22} color={colors.onBrandPrimary} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: spacing.md, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: c.divider },
  title: { color: c.onSurface, fontWeight: "900", fontSize: 17 },
  sub: { color: c.muted, fontSize: 12 },
  msgRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  bubble: { maxWidth: "78%", paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.lg },
  mine: { backgroundColor: c.brandPrimary, borderBottomRightRadius: 6 },
  theirs: { backgroundColor: c.surfaceTertiary, borderBottomLeftRadius: 6 },
  sender: { color: c.brandSecondary, fontWeight: "800", fontSize: 12, marginBottom: 2 },
  msg: { color: c.onSurface, fontSize: 15, lineHeight: 20 },
  inputBar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: spacing.md, paddingTop: 8, borderTopWidth: 1, borderTopColor: c.divider, backgroundColor: c.surface },
  input: { flex: 1, height: 46, borderRadius: 23, backgroundColor: c.surfaceTertiary, color: c.onSurface, paddingHorizontal: 16, fontSize: 15 },
  wing: { width: 46, height: 46, borderRadius: 23, backgroundColor: c.brandSecondary, alignItems: "center", justifyContent: "center" },
  send: { width: 46, height: 46, borderRadius: 23, backgroundColor: c.brandPrimary, alignItems: "center", justifyContent: "center" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  emptyText: { color: c.muted },
}));
