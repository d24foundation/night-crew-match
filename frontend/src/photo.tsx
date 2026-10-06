import { useState } from "react";
import { Platform, Pressable, Text } from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as Linking from "expo-linking";

import { uploadPhoto, User } from "@/src/api";
import { Btn, Ionicons, useToast } from "@/src/ui";
import { Sheet } from "@/src/sheet";
import { makeStyles, radius, useTheme } from "@/src/theme";

const OPTS: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 0.7 };

function toFile(a: ImagePicker.ImagePickerAsset) {
  const type = a.mimeType ?? "image/jpeg";
  const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
  return { uri: a.uri, name: a.fileName ?? `photo.${ext}`, type };
}

// Profile photo picker: library needs no permission; camera asks contextually with a Settings fallback.
export function usePhotoPicker(onDone: (u: User) => void) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [camNudge, setCamNudge] = useState(false);
  const [busy, setBusy] = useState(false);

  const finish = async (res: ImagePicker.ImagePickerResult) => {
    if (res.canceled || !res.assets?.[0]) return;
    setBusy(true);
    try {
      onDone(await uploadPhoto(toFile(res.assets[0])));
      toast("Looking good — photo updated");
      setOpen(false);
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };

  const library = async () => finish(await ImagePicker.launchImageLibraryAsync(OPTS));

  const camera = async () => {
    const perm = await ImagePicker.getCameraPermissionsAsync();
    let status = perm.status;
    if (status !== "granted") {
      if (!perm.canAskAgain) { setCamNudge(true); return; }
      status = (await ImagePicker.requestCameraPermissionsAsync()).status;
      if (status !== "granted") { toast("Camera is off — you can still pick from your library"); return; }
    }
    await finish(await ImagePicker.launchCameraAsync(OPTS));
  };

  const ui = (
    <>
      <Sheet visible={open} onClose={() => setOpen(false)} title="Your profile photo" sub="Real photos get 3× more matches. Square crop, your best night-out energy." testID="photo-sheet">
        <Btn testID="photo-library-button" title="Choose from library" icon="images" loading={busy} onPress={library} />
        {Platform.OS !== "web" && <Btn testID="photo-camera-button" title="Take a photo" icon="camera" variant="ghost" disabled={busy} onPress={camera} />}
        <Btn title="Cancel" variant="ghost" onPress={() => setOpen(false)} />
      </Sheet>
      <Sheet visible={camNudge} onClose={() => setCamNudge(false)} title="Camera is off" sub="Turn on camera access in Settings to take a photo, or just pick one from your library." testID="camera-settings-sheet">
        <Btn testID="camera-open-settings-button" title="Open Settings" icon="settings" onPress={() => { setCamNudge(false); Linking.openSettings(); }} />
        <Btn title="Not now" variant="ghost" onPress={() => setCamNudge(false)} />
      </Sheet>
    </>
  );

  return { open: () => setOpen(true), busy, ui };
}

export function ChangePhotoBadge({ onPress }: { onPress: () => void }) {
  const s = useStyles();
  const { colors } = useTheme();
  return (
    <Pressable testID="change-photo-button" onPress={onPress} style={s.badge} hitSlop={8}>
      <Ionicons name="camera" size={14} color={colors.onBrandSecondary} />
      <Text style={s.badgeText}>Edit photo</Text>
    </Pressable>
  );
}

const useStyles = makeStyles((c) => ({
  badge: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: c.brandSecondary, paddingHorizontal: 10, height: 28, borderRadius: radius.pill, marginTop: -16, borderWidth: 2, borderColor: c.surface },
  badgeText: { color: c.onBrandSecondary, fontWeight: "900", fontSize: 11 },
}));
