import { useState } from "react";
import { Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, CITIES, Party, VIBES } from "@/src/api";
import { useAuth } from "@/src/auth";
import { Btn, Chip, IconBtn, Ionicons, useToast } from "@/src/ui";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

const STARTS = [{ l: "Now", h: 0 }, { l: "+1h", h: 1 }, { l: "+2h", h: 2 }, { l: "+3h", h: 3 }, { l: "+5h", h: 5 }];

export default function CreateParty() {
  const s = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [city, setCity] = useState(user?.city ?? "London");
  const [area, setArea] = useState("");
  const [address, setAddress] = useState("");
  const [vibe, setVibe] = useState("House");
  const [startH, setStartH] = useState(2);
  const [house, setHouse] = useState(true);
  const [drinks, setDrinks] = useState(3);
  const [chip, setChip] = useState(5);
  const [cap, setCap] = useState(15);
  const [busy, setBusy] = useState(false);

  const [hyping, setHyping] = useState(false);
  const hype = async () => {
    setHyping(true);
    try {
      const r = await api<{ title: string; description: string }>("/ai/party-hype", { body: { vibe, city, area, house_provided: house } });
      setTitle(r.title);
      setDesc(r.description);
      toast("AI hype ready — tweak it if you like");
    } catch (e) { toast((e as Error).message, "err"); } finally { setHyping(false); }
  };

  const submit = async () => {
    if (title.trim().length < 3 || !area.trim()) { toast("Add a title and area", "err"); return; }
    setBusy(true);
    try {
      const p = await api<Party>("/parties", { body: {
        title: title.trim(), description: desc.trim(), city, area: area.trim(), address: address.trim(), vibe,
        starts_at: new Date(Date.now() + startH * 3600e3).toISOString(), house_provided: house,
        drinks_needed: drinks, chip_in: chip, capacity: cap } });
      qc.invalidateQueries({ queryKey: ["parties"] });
      qc.invalidateQueries({ queryKey: ["chats"] });
      toast("Your afters is live");
      router.replace(`/party/${p.party_id}`);
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };

  return (
    <View style={s.root}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <IconBtn testID="create-close-button" icon="close" onPress={() => router.back()} />
        <Text style={s.hTitle}>Host afters</Text>
        <View style={{ width: 44 }} />
      </View>
      <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: insets.bottom + 24 }}>
        <Btn testID="ai-hype-button" title="Write it for me with AI" icon="sparkles" variant="lime" loading={hyping} onPress={hype} />
        <Field label="Party name">
          <TextInput testID="party-title-input" style={s.input} placeholder="e.g. Peckham Rooftop Afters" placeholderTextColor={colors.muted} value={title} onChangeText={setTitle} maxLength={60} />
        </Field>
        <Field label="Vibe">
          <ChipRow items={VIBES} value={vibe} onChange={setVibe} prefix="vibe" />
        </Field>
        <Field label="City">
          <ChipRow items={CITIES} value={city} onChange={setCity} prefix="create-city" />
        </Field>
        <Field label="Area (public)">
          <TextInput testID="party-area-input" style={s.input} placeholder="e.g. Shoreditch" placeholderTextColor={colors.muted} value={area} onChangeText={setArea} />
        </Field>
        <Field label="Address (only shown to people who join)">
          <TextInput testID="party-address-input" style={s.input} placeholder="Flat & street" placeholderTextColor={colors.muted} value={address} onChangeText={setAddress} />
        </Field>
        <Field label="Starts">
          <ChipRow items={STARTS.map((x) => x.l)} value={STARTS.find((x) => x.h === startH)!.l} onChange={(l) => setStartH(STARTS.find((x) => x.l === l)!.h)} prefix="start" />
        </Field>
        <View style={s.toggle}>
          <Ionicons name="home" size={20} color={colors.brandSecondary} />
          <Text style={s.toggleText}>I'm providing the house</Text>
          <Switch testID="house-provided-switch" value={house} onValueChange={setHouse} trackColor={{ true: colors.brandPrimary, false: colors.surfaceTertiary }} thumbColor={colors.onSurface} />
        </View>
        <Stepper testID="drinks-stepper" icon="wine" label="Drinks needed" value={drinks} onChange={setDrinks} min={0} max={50} />
        <Stepper testID="chipin-stepper" icon="cash" label="Chip-in per person" value={chip} onChange={setChip} min={0} max={100} fmt={(v) => `£${v}`} />
        <Stepper testID="capacity-stepper" icon="people" label="Max people" value={cap} onChange={setCap} min={2} max={200} />
        <Field label="Details">
          <TextInput testID="party-description-input" style={[s.input, { height: 96, paddingTop: 14 }]} multiline placeholder="Music, rules, what to bring..." placeholderTextColor={colors.muted} value={desc} onChangeText={setDesc} maxLength={400} />
        </Field>
        <Btn testID="create-party-submit-button" title="Post my afters" icon="flame" loading={busy} onPress={submit} />
      </KeyboardAwareScrollView>
    </View>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const s = useStyles();
  return <View style={{ gap: 8 }}><Text style={s.label}>{label}</Text>{children}</View>;
}

function ChipRow({ items, value, onChange, prefix }: { items: string[]; value: string; onChange: (v: string) => void; prefix: string }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
      {items.map((i) => <Chip key={i} testID={`${prefix}-chip-${i}`} label={i} selected={value === i} onPress={() => onChange(i)} />)}
    </ScrollView>
  );
}

function Stepper({ icon, label, value, onChange, min, max, fmt, testID }: { icon: any; label: string; value: number; onChange: (v: number) => void; min: number; max: number; fmt?: (v: number) => string; testID: string }) {
  const s = useStyles();
  const { colors } = useTheme();
  return (
    <View style={s.toggle} testID={testID}>
      <Ionicons name={icon} size={20} color={colors.brandSecondary} />
      <Text style={s.toggleText}>{label}</Text>
      <Pressable testID={`${testID}-minus`} onPress={() => onChange(Math.max(min, value - 1))} style={s.step}><Ionicons name="remove" size={18} color={colors.onSurface} /></Pressable>
      <Text style={s.stepVal}>{fmt ? fmt(value) : value}</Text>
      <Pressable testID={`${testID}-plus`} onPress={() => onChange(Math.min(max, value + 1))} style={s.step}><Ionicons name="add" size={18} color={colors.onSurface} /></Pressable>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: c.divider },
  hTitle: { color: c.onSurface, fontSize: 18, fontWeight: "900" },
  label: { color: c.onSurfaceTertiary, fontWeight: "700", fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5 },
  input: { height: 52, borderRadius: radius.md, backgroundColor: c.surfaceTertiary, color: c.onSurface, paddingHorizontal: spacing.md, fontSize: 16, borderWidth: 1, borderColor: c.border },
  toggle: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: radius.md, backgroundColor: c.surfaceSecondary, borderWidth: 1, borderColor: c.border },
  toggleText: { color: c.onSurface, fontWeight: "700", flex: 1 },
  step: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.surfaceTertiary, alignItems: "center", justifyContent: "center" },
  stepVal: { color: c.onSurface, fontWeight: "900", minWidth: 40, textAlign: "center", fontSize: 16 },
}));
