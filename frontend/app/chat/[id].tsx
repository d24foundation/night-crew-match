import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Platform, Pressable, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, getApiToken } from "@/src/api";
import { useAuth } from "@/src/auth";
import { useLiveChat } from "@/src/live-chat";
import { BillsSheet, useBills } from "@/src/bills";
import { SafetySheet } from "@/src/safety";
import { Avatar, IconBtn, Ionicons, useToast } from "@/src/ui";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Msg = { message_id: string; sender_id: string; sender_name: string; sender_picture?: string | null; text: string; created_at: string };
type Chat = { chat_id: string; title: string; kind: string; picture?: string | null; other_user_id?: string; messages: Msg[] };

export default function ChatScreen() {
  const { id, stripe_session } = useLocalSearchParams<{ id: string; stripe_session?: string }>();
  const s = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [text, setText] = useState("");
  const [safety, setSafety] = useState<{ user_id: string; name: string } | null>(null);
  const list = useRef<FlatList>(null);
  const appendMsg = useCallback((m: Msg) => {
    qc.setQueryData<Chat>(["chat", id], (old) => {
      if (!old) return old;
      if (old.messages.some((x) => x.message_id === m.message_id)) return old;
      return { ...old, messages: [...old.messages, m] };
    });
    qc.invalidateQueries({ queryKey: ["chats"] });
  }, [qc, id]);
  const live = useLiveChat(id, getApiToken(), appendMsg, () => qc.invalidateQueries({ queryKey: ["bills", id] }));
  const [bills, setBills] = useState(false);
  const billsQ = useBills(id, true);
  const owedCount = (billsQ.data ?? []).filter((b) => !b.my_paid && b.my_share != null).length;

  // Back from Stripe after settling a bill share
  const polled = useRef(false);
  useEffect(() => {
    if (!stripe_session || polled.current) return;
    polled.current = true;
    (async () => {
      for (let i = 0; i < 6; i++) {
        try {
          const r = await api<{ payment_status: string }>(`/payments/status/${stripe_session}`);
          if (r.payment_status === "paid") { toast("Settled — money sent 🎉"); qc.invalidateQueries({ queryKey: ["bills", id] }); setBills(true); return; }
          if (r.payment_status === "expired") break;
        } catch { break; }
        await new Promise((res) => setTimeout(res, 2000));
      }
    })();
  }, [stripe_session, id, qc, toast]);
  // Socket delivers messages instantly; the poll is only a safety net.
  const q = useQuery({ queryKey: ["chat", id], queryFn: () => api<Chat>(`/chats/${id}`), refetchInterval: live.connected ? 20000 : 3000 });

  const onBlocked = () => {
    qc.invalidateQueries({ queryKey: ["chats"] });
    if (q.data?.kind === "match") router.back();
    else q.refetch();
  };

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    live.sendTyping(false);
    try {
      const m = await api<Msg>(`/chats/${id}`, { body: { text: t } });
      appendMsg(m);
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
          <Text style={s.sub}>
            {live.typingNames.length ? `${live.typingNames.slice(0, 2).join(", ")} ${live.typingNames.length > 1 ? "are" : "is"} typing…`
              : q.data?.kind === "party" ? "Party group chat · hold a message to report" : live.connected ? "Live" : "Match"}
          </Text>
        </View>
        {q.data?.kind === "party" && (
          <View>
            <IconBtn testID="chat-bills-button" icon="receipt-outline" onPress={() => setBills(true)} />
            {owedCount > 0 && <View style={s.dot} testID="bills-owed-dot"><Text style={s.dotText}>{owedCount}</Text></View>}
          </View>
        )}
        {q.data?.kind === "match" && q.data.other_user_id && (
          <IconBtn testID="chat-safety-button" icon="ellipsis-horizontal" onPress={() => setSafety({ user_id: q.data!.other_user_id!, name: q.data!.title })} />
        )}
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
              <Pressable style={[s.msgRow, mine && { justifyContent: "flex-end" }]} disabled={mine} testID={`message-${item.message_id}`}
                onLongPress={() => setSafety({ user_id: item.sender_id, name: item.sender_name })} delayLongPress={350}>
                {!mine && <Avatar uri={item.sender_picture} name={item.sender_name} size={28} />}
                <View style={[s.bubble, mine ? s.mine : s.theirs]}>
                  {!mine && q.data?.kind === "party" && <Text style={s.sender}>{item.sender_name}</Text>}
                  <Text style={[s.msg, mine && { color: colors.onBrandPrimary }]}>{item.text}</Text>
                </View>
              </Pressable>
            );
          }}
        />
        <View style={[s.inputBar, { paddingBottom: insets.bottom + 8 }]}>
          {live.typingNames.length > 0 && (
            <View style={s.typingPill} testID="typing-indicator"><Text style={s.typingText}>{live.typingNames[0]} is typing…</Text></View>
          )}
          {q.data?.kind === "match" && (
            <Pressable testID="ai-icebreaker-button" onPress={icebreaker} disabled={wing} style={s.wing}>
              {wing ? <ActivityIndicator color={colors.onBrandSecondary} size="small" /> : <Ionicons name="sparkles" size={20} color={colors.onBrandSecondary} />}
            </Pressable>
          )}
          <TextInput testID="chat-input" style={s.input} placeholder="Message..." placeholderTextColor={colors.muted} value={text} onChangeText={(v) => { setText(v); if (v) live.sendTyping(true); }} onSubmitEditing={send} returnKeyType="send" />
          <Pressable testID="chat-send-button" onPress={send} style={s.send}>
            <Ionicons name="arrow-up" size={22} color={colors.onBrandPrimary} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
      <SafetySheet target={safety} context={id} onClose={() => setSafety(null)} onBlocked={onBlocked} />
      {q.data?.kind === "party" && <BillsSheet chatId={id} visible={bills} onClose={() => setBills(false)} />}
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
  typingPill: { position: "absolute", top: -30, left: spacing.md, backgroundColor: c.surfaceTertiary, paddingHorizontal: 12, paddingVertical: 5, borderRadius: radius.pill },
  typingText: { color: c.brandSecondary, fontSize: 12, fontWeight: "700" },
  dot: { position: "absolute", top: -2, right: -2, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: c.gold, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 },
  dotText: { color: c.onGold, fontSize: 10, fontWeight: "900" },
  input: { flex: 1, height: 46, borderRadius: 23, backgroundColor: c.surfaceTertiary, color: c.onSurface, paddingHorizontal: 16, fontSize: 15 },
  wing: { width: 46, height: 46, borderRadius: 23, backgroundColor: c.brandSecondary, alignItems: "center", justifyContent: "center" },
  send: { width: 46, height: 46, borderRadius: 23, backgroundColor: c.brandPrimary, alignItems: "center", justifyContent: "center" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  emptyText: { color: c.muted },
}));
