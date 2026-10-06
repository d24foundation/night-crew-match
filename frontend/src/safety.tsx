import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { api } from "@/src/api";
import { Btn, Ionicons, useToast } from "@/src/ui";
import { Sheet } from "@/src/sheet";
import { makeStyles, radius, useTheme } from "@/src/theme";

const REASONS: { key: string; label: string }[] = [
  { key: "harassment", label: "Harassment or abuse" },
  { key: "fake", label: "Fake profile" },
  { key: "unsafe", label: "Unsafe behaviour" },
  { key: "spam", label: "Spam or scam" },
  { key: "other", label: "Something else" },
];

// Report / block sheet for any user (match chat, party chat sender, swipe card, host).
export function SafetySheet({ target, context, onClose, onBlocked }: {
  target: { user_id: string; name: string } | null; context?: string; onClose: () => void; onBlocked?: (userId: string) => void;
}) {
  const s = useStyles();
  const { colors } = useTheme();
  const toast = useToast();
  const [mode, setMode] = useState<"menu" | "report" | "block">("menu");
  const [reason, setReason] = useState<string | null>(null);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);

  const close = () => { setMode("menu"); setReason(null); setDetails(""); onClose(); };

  const submitReport = async () => {
    if (!target || !reason) return;
    setBusy(true);
    try {
      await api("/reports", { body: { target_id: target.user_id, reason, details: details.trim(), context } });
      toast("Thanks — our team will review this report");
      close();
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };

  const block = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await api(`/users/${target.user_id}/block`, { method: "POST" });
      toast(`${target.name} is blocked`);
      onBlocked?.(target.user_id);
      close();
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };

  const name = target?.name ?? "this user";
  return (
    <Sheet visible={!!target} onClose={close} testID="safety-sheet"
      title={mode === "menu" ? "Keep it safe" : mode === "report" ? `Report ${name}` : `Block ${name}?`}
      sub={mode === "menu" ? "Reports are private. Blocking hides you from each other everywhere in the app."
        : mode === "report" ? "Tell us what happened. We never tell them who reported."
        : "They won't see your profile, parties or messages, and you won't see theirs. You can unblock from your profile."}>
      {mode === "menu" && (
        <>
          <Pressable testID="safety-report-option" onPress={() => setMode("report")} style={s.opt}>
            <Ionicons name="flag" size={20} color={colors.warning} /><Text style={s.optText}>Report {name}</Text><Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>
          <Pressable testID="safety-block-option" onPress={() => setMode("block")} style={s.opt}>
            <Ionicons name="ban" size={20} color={colors.error} /><Text style={s.optText}>Block {name}</Text><Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>
          <Btn title="Cancel" variant="ghost" onPress={close} testID="safety-cancel-button" />
        </>
      )}
      {mode === "report" && (
        <>
          <View style={{ gap: 8 }}>
            {REASONS.map((r) => (
              <Pressable key={r.key} testID={`report-reason-${r.key}`} onPress={() => setReason(r.key)} style={[s.opt, reason === r.key && s.optOn]}>
                <Ionicons name={reason === r.key ? "radio-button-on" : "radio-button-off"} size={20} color={reason === r.key ? colors.brandPrimary : colors.muted} />
                <Text style={s.optText}>{r.label}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput testID="report-details-input" style={s.input} placeholder="Add details (optional)" placeholderTextColor={colors.muted} value={details} onChangeText={setDetails} maxLength={500} multiline />
          <Btn testID="report-submit-button" title="Send report" icon="flag" disabled={!reason} loading={busy} onPress={submitReport} />
          <Btn title="Back" variant="ghost" onPress={() => setMode("menu")} />
        </>
      )}
      {mode === "block" && (
        <>
          <Btn testID="block-confirm-button" title={`Block ${name}`} icon="ban" loading={busy} onPress={block} />
          <Btn title="Back" variant="ghost" onPress={() => setMode("menu")} />
        </>
      )}
    </Sheet>
  );
}

const useStyles = makeStyles((c) => ({
  opt: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.md, backgroundColor: c.surfaceTertiary, borderWidth: 1.5, borderColor: c.border },
  optOn: { borderColor: c.brandPrimary },
  optText: { color: c.onSurface, fontWeight: "700", flex: 1, fontSize: 15 },
  input: { minHeight: 70, borderRadius: radius.md, backgroundColor: c.surfaceTertiary, color: c.onSurface, padding: 14, fontSize: 15, borderWidth: 1, borderColor: c.border, textAlignVertical: "top" },
}));
