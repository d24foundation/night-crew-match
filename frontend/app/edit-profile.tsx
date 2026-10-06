import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, CITIES, User, VIBES } from "@/src/api";
import { useAuth } from "@/src/auth";
import { ChangePhotoBadge, usePhotoPicker } from "@/src/photo";
import { Avatar, Btn, Chip, IconBtn, useToast } from "@/src/ui";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

export default function EditProfile() {
  const s = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const { user, setUser } = useAuth();
  const [name, setName] = useState(user?.name ?? "");
  const [age, setAge] = useState(user?.age ? String(user.age) : "");
  const [bio, setBio] = useState(user?.bio ?? "");
  const [city, setCity] = useState(user?.city ?? "London");
  const [vibes, setVibes] = useState<string[]>(user?.vibes ?? []);
  const [busy, setBusy] = useState(false);
  const photo = usePhotoPicker(setUser);

  const save = async () => {
    const a = parseInt(age, 10);
    if (age && (isNaN(a) || a < 18)) { toast("You must be 18+", "err"); return; }
    setBusy(true);
    try {
      const u = await api<User>("/me", { method: "PUT", body: { name: name.trim() || undefined, bio, city, vibes, age: age ? a : undefined } });
      setUser(u);
      toast("Profile saved");
      router.back();
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };

  return (
    <View style={s.root}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <IconBtn testID="edit-close-button" icon="close" onPress={() => router.back()} />
        <Text style={s.hTitle}>Edit profile</Text>
        <View style={{ width: 44 }} />
      </View>
      <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: insets.bottom + 24 }}>
        <Pressable testID="edit-avatar" onPress={photo.open} style={{ alignItems: "center" }}>
          <Avatar uri={user?.picture} name={user?.name} size={104} />
          <ChangePhotoBadge onPress={photo.open} />
        </Pressable>
        <Text style={s.label}>Name</Text>
        <TextInput testID="edit-name-input" style={s.input} value={name} onChangeText={setName} placeholderTextColor={colors.muted} maxLength={40} />
        <Text style={s.label}>Age</Text>
        <TextInput testID="edit-age-input" style={s.input} value={age} onChangeText={setAge} keyboardType="number-pad" placeholder="18+" placeholderTextColor={colors.muted} maxLength={2} />
        <Text style={s.label}>Bio</Text>
        <TextInput testID="edit-bio-input" style={[s.input, { height: 90, paddingTop: 14 }]} multiline value={bio} onChangeText={setBio} placeholder="What's your afters energy?" placeholderTextColor={colors.muted} maxLength={200} />
        <Text style={s.label}>City</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {CITIES.map((c) => <Chip key={c} testID={`edit-city-${c}`} label={c} selected={city === c} onPress={() => setCity(c)} />)}
        </ScrollView>
        <Text style={s.label}>Vibes</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {VIBES.map((v) => <Chip key={v} testID={`edit-vibe-${v}`} label={v} selected={vibes.includes(v)} onPress={() => setVibes((x) => x.includes(v) ? x.filter((y) => y !== v) : [...x, v])} />)}
        </View>
        <Btn testID="save-profile-button" title="Save" loading={busy} onPress={save} />
      </KeyboardAwareScrollView>
      {photo.ui}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: c.divider },
  hTitle: { color: c.onSurface, fontSize: 18, fontWeight: "900" },
  label: { color: c.onSurfaceTertiary, fontWeight: "700", fontSize: 13, textTransform: "uppercase", marginBottom: -8 },
  input: { height: 52, borderRadius: radius.md, backgroundColor: c.surfaceTertiary, color: c.onSurface, paddingHorizontal: spacing.md, fontSize: 16, borderWidth: 1, borderColor: c.border },
}));
