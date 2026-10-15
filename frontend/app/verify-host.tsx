import { useState } from "react";
import { Image, Platform, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import * as Linking from "expo-linking";

import { uploadFiles, User } from "@/src/api";
import { useAuth } from "@/src/auth";
import { Sheet } from "@/src/sheet";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { Btn, IconBtn, Ionicons, useToast } from "@/src/ui";

type Shot = { uri: string; name: string; type: string };
const OPTS: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.8 };

function toFile(a: ImagePicker.ImagePickerAsset, fallback: string): Shot {
  const type = a.mimeType ?? "image/jpeg";
  return { uri: a.uri, name: a.fileName ?? `${fallback}.jpg`, type };
}

// Host ID verification: photo of a government ID + a selfie, uploaded to private storage and reviewed.
export default function VerifyHost() {
  const s = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const { user, setUser } = useAuth();
  const [idDoc, setIdDoc] = useState<Shot | null>(null);
  const [selfie, setSelfie] = useState<Shot | null>(null);
  const [busy, setBusy] = useState(false);
  const [camNudge, setCamNudge] = useState(false);
  const status = user?.host_verification_status;

  const capture = async (which: "id" | "selfie", source: "camera" | "library") => {
    let res: ImagePicker.ImagePickerResult;
    if (source === "camera") {
      const perm = await ImagePicker.getCameraPermissionsAsync();
      let st = perm.status;
      if (st !== "granted") {
        if (!perm.canAskAgain) { setCamNudge(true); return; }
        st = (await ImagePicker.requestCameraPermissionsAsync()).status;
        if (st !== "granted") { toast("Camera is off — you can upload from your library instead"); return; }
      }
      res = await ImagePicker.launchCameraAsync({ ...OPTS, cameraType: which === "selfie" ? ImagePicker.CameraType.front : ImagePicker.CameraType.back });
    } else {
      res = await ImagePicker.launchImageLibraryAsync(OPTS);
    }
    if (res.canceled || !res.assets?.[0]) return;
    (which === "id" ? setIdDoc : setSelfie)(toFile(res.assets[0], which));
  };

  const submit = async () => {
    if (!idDoc || !selfie) return;
    setBusy(true);
    try {
      const u = await uploadFiles<User>("/me/verify-host", { id_document: idDoc, selfie });
      setUser(u);
      toast("Submitted — we'll review within 24 hours");
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };

  const Slot = ({ label, hint, shot, which, icon }: { label: string; hint: string; shot: Shot | null; which: "id" | "selfie"; icon: any }) => (
    <View style={s.slot} testID={`slot-${which}`}>
      {shot ? <Image source={{ uri: shot.uri }} style={s.preview} /> : <View style={s.placeholder}><Ionicons name={icon} size={36} color={colors.muted} /></View>}
      <View style={{ flex: 1, gap: 6 }}>
        <Text style={s.slotTitle}>{label}</Text>
        <Text style={s.hint}>{hint}</Text>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          {Platform.OS !== "web" && <Btn testID={`${which}-camera-button`} title="Camera" icon="camera" variant="ghost" onPress={() => capture(which, "camera")} style={{ height: 36, paddingHorizontal: 12 }} />}
          <Btn testID={`${which}-library-button`} title={shot ? "Change" : "Upload"} icon="images" variant="ghost" onPress={() => capture(which, "library")} style={{ height: 36, paddingHorizontal: 12 }} />
        </View>
      </View>
    </View>
  );

  return (
    <View style={s.root}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <IconBtn testID="verify-back-button" icon="chevron-back" onPress={() => router.back()} />
        <Text style={s.title}>Verified host</Text>
        <View style={{ width: 44 }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: insets.bottom + 24 }}>
        <View style={s.hero}>
          <Ionicons name="shield-checkmark" size={40} color={colors.brandSecondary} />
          <Text style={s.heroTitle}>Guests trust verified houses</Text>
          <Text style={s.heroSub}>Verified hosts get the shield badge on every party, rank higher in the feed and fill up faster. Your documents are stored privately, never shown to anyone, and deleted after review.</Text>
        </View>

        {status === "approved" ? (
          <View style={[s.status, { borderColor: colors.brandSecondary }]} testID="verify-status-approved">
            <Ionicons name="checkmark-circle" size={22} color={colors.brandSecondary} />
            <Text style={s.statusText}>You're a verified host. The badge is live on your parties.</Text>
          </View>
        ) : status === "pending" ? (
          <View style={[s.status, { borderColor: colors.gold }]} testID="verify-status-pending">
            <Ionicons name="time" size={22} color={colors.gold} />
            <Text style={s.statusText}>Under review — usually done within 24 hours. We'll notify you.</Text>
          </View>
        ) : (
          <>
            {status === "rejected" && (
              <View style={[s.status, { borderColor: colors.error }]} testID="verify-status-rejected">
                <Ionicons name="alert-circle" size={22} color={colors.error} />
                <Text style={s.statusText}>We couldn't verify your last submission. Please resubmit clear, well-lit photos.</Text>
              </View>
            )}
            <Slot which="id" label="1. Photo ID" hint="Passport, driving licence or national ID. All four corners visible, no glare." shot={idDoc} icon="card-outline" />
            <Slot which="selfie" label="2. Selfie" hint="Just you, face clearly visible, no sunglasses or hat." shot={selfie} icon="happy-outline" />
            <Btn testID="verify-submit-button" title="Submit for review" icon="shield-checkmark" loading={busy} disabled={!idDoc || !selfie} onPress={submit} />
            <Text style={s.fine}>By submitting you confirm the ID is yours and you're 18+. We check the name and photo match, then delete the files.</Text>
          </>
        )}
      </ScrollView>
      <Sheet visible={camNudge} onClose={() => setCamNudge(false)} title="Camera is off" sub="Turn on camera access in Settings to take the photos, or upload from your library." testID="camera-settings-sheet">
        <Btn title="Open Settings" icon="settings" onPress={() => { setCamNudge(false); Linking.openSettings(); }} />
        <Btn title="Not now" variant="ghost" onPress={() => setCamNudge(false)} />
      </Sheet>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, paddingBottom: 8 },
  title: { color: c.onSurface, fontSize: 18, fontWeight: "900" },
  hero: { alignItems: "center", gap: 8, padding: spacing.lg, borderRadius: radius.lg, backgroundColor: c.surfaceSecondary, borderWidth: 1, borderColor: c.border },
  heroTitle: { color: c.onSurface, fontSize: 20, fontWeight: "900", textAlign: "center" },
  heroSub: { color: c.onSurfaceTertiary, textAlign: "center", lineHeight: 20 },
  slot: { flexDirection: "row", gap: 12, padding: 12, borderRadius: radius.md, backgroundColor: c.surfaceSecondary, borderWidth: 1, borderColor: c.border },
  preview: { width: 96, height: 96, borderRadius: radius.md },
  placeholder: { width: 96, height: 96, borderRadius: radius.md, backgroundColor: c.surfaceTertiary, alignItems: "center", justifyContent: "center" },
  slotTitle: { color: c.onSurface, fontWeight: "900", fontSize: 15 },
  hint: { color: c.muted, fontSize: 12 },
  status: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderRadius: radius.md, backgroundColor: c.surfaceSecondary, borderWidth: 1.5 },
  statusText: { color: c.onSurface, fontWeight: "700", flex: 1 },
  fine: { color: c.muted, fontSize: 12, textAlign: "center" },
}));
