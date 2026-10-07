import { useEffect, useRef, useState } from "react";
import { Linking, Platform, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api";
import { CheckinResult } from "@/src/party-extras";
import { Btn, IconBtn, Ionicons, useToast } from "@/src/ui";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Result = { ok: boolean; already: boolean; guest: { name: string; picture?: string | null } };

// Host door scanner: camera QR scan (contextual permission) with a manual 6-digit code fallback.
export default function Scan() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const s = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const [perm, requestPerm] = useCameraPermissions();
  const [explained, setExplained] = useState(false);
  const [code, setCode] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  const check = async (value: string) => {
    if (lock.current || !value.trim()) return;
    lock.current = true; setBusy(true);
    try {
      setResult(await api<Result>(`/parties/${id}/checkin`, { body: { code: value.trim() } }));
      setCode("");
      qc.invalidateQueries({ queryKey: ["party", id] });
    } catch (e) { toast((e as Error).message, "err"); lock.current = false; }
    finally { setBusy(false); }
  };
  const next = () => { setResult(null); lock.current = false; };

  const camOk = perm?.granted;
  useEffect(() => { if (perm && !perm.granted && perm.canAskAgain && explained) requestPerm(); }, [explained, perm, requestPerm]);

  return (
    <View style={s.root}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <IconBtn testID="scan-close-button" icon="close" onPress={() => router.back()} />
        <Text style={s.hTitle}>Door check-in</Text>
        <View style={{ width: 44 }} />
      </View>

      <View style={s.camWrap}>
        {Platform.OS !== "web" && camOk ? (
          <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={result ? undefined : ({ data }) => check(data)} />
        ) : (
          <View style={s.camEmpty} testID="scan-permission-panel">
            <Ionicons name="qr-code" size={56} color={colors.brandSecondary} />
            {Platform.OS === "web" ? (
              <Text style={s.camText}>Camera scanning works in the mobile app. Type the guest's code below.</Text>
            ) : perm && !perm.canAskAgain && !perm.granted ? (
              <>
                <Text style={s.camText}>Camera is off. Turn it on in Settings to scan passes, or type the code below.</Text>
                <Btn testID="scan-open-settings-button" title="Open Settings" icon="settings" variant="ghost" onPress={() => Linking.openSettings()} />
              </>
            ) : (
              <>
                <Text style={s.camText}>Point your camera at a guest's door pass to check them in instantly.</Text>
                <Btn testID="scan-enable-camera-button" title="Enable camera" icon="camera" onPress={() => setExplained(true)} />
              </>
            )}
          </View>
        )}
        {camOk && Platform.OS !== "web" && <View style={s.frame} pointerEvents="none" />}
      </View>

      <View style={[s.manual, { paddingBottom: insets.bottom + 16 }]}>
        <Text style={s.label}>Or enter their code</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TextInput testID="checkin-code-input" style={s.input} value={code} onChangeText={(v) => setCode(v.toUpperCase())} placeholder="e.g. 3A9F21" placeholderTextColor={colors.muted} autoCapitalize="characters" maxLength={12} onSubmitEditing={() => check(code)} />
          <Btn testID="checkin-submit-button" title="Check in" icon="checkmark" loading={busy} onPress={() => check(code)} />
        </View>
      </View>
      <CheckinResult result={result} onClose={next} />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, paddingBottom: 8 },
  hTitle: { color: c.onSurface, fontSize: 18, fontWeight: "900" },
  camWrap: { flex: 1, margin: spacing.md, borderRadius: radius.lg, overflow: "hidden", backgroundColor: c.surfaceSecondary, borderWidth: 1, borderColor: c.border },
  camEmpty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14, padding: spacing.lg },
  camText: { color: c.onSurfaceTertiary, textAlign: "center", fontSize: 15, lineHeight: 21 },
  frame: { position: "absolute", top: "20%", left: "15%", right: "15%", bottom: "20%", borderWidth: 3, borderColor: c.brandSecondary, borderRadius: radius.lg },
  manual: { paddingHorizontal: spacing.md, gap: 8 },
  label: { color: c.onSurfaceTertiary, fontWeight: "700", fontSize: 13, textTransform: "uppercase" },
  input: { flex: 1, height: 52, borderRadius: radius.md, backgroundColor: c.surfaceTertiary, color: c.onSurface, paddingHorizontal: spacing.md, fontSize: 18, fontWeight: "800", letterSpacing: 2, borderWidth: 1, borderColor: c.border },
}));
