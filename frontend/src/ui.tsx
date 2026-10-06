import React, { createContext, useCallback, useContext, useRef, useState } from "react";
import { ActivityIndicator, Pressable, PressableProps, Text, View, ViewStyle, StyleProp } from "react-native";
import { Image } from "expo-image";
import Ionicons from "@react-native-vector-icons/ionicons";
import Animated, { FadeInUp, FadeOutUp, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";

import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

export type IconName = React.ComponentProps<typeof Ionicons>["name"];
export { Ionicons };

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function Btn({ title, onPress, variant = "primary", icon, loading, disabled, style, testID }: {
  title: string; onPress?: () => void; variant?: "primary" | "lime" | "ghost" | "gold"; icon?: IconName;
  loading?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle>; testID?: string;
}) {
  const s = useStyles();
  const { colors } = useTheme();
  const scale = useSharedValue(1);
  const aStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const bg = { primary: colors.brandPrimary, lime: colors.brandSecondary, ghost: colors.surfaceTertiary, gold: colors.gold }[variant];
  const fg = { primary: colors.onBrandPrimary, lime: colors.onBrandSecondary, ghost: colors.onSurface, gold: colors.onGold }[variant];
  return (
    <AnimatedPressable
      testID={testID}
      disabled={disabled || loading}
      onPressIn={() => { scale.value = withSpring(0.96); }}
      onPressOut={() => { scale.value = withSpring(1); }}
      onPress={() => { Haptics.selectionAsync().catch(() => {}); onPress?.(); }}
      style={[s.btn, { backgroundColor: bg, opacity: disabled ? 0.5 : 1 }, aStyle, style]}
    >
      {loading ? <ActivityIndicator color={fg} /> : (
        <>
          {icon && <Ionicons name={icon} size={18} color={fg} />}
          <Text style={[s.btnText, { color: fg }]}>{title}</Text>
        </>
      )}
    </AnimatedPressable>
  );
}

export function Chip({ label, selected, onPress, testID, icon }: { label: string; selected?: boolean; onPress?: () => void; testID?: string; icon?: IconName }) {
  const s = useStyles();
  const { colors } = useTheme();
  return (
    <Pressable testID={testID} onPress={onPress} style={[s.chip, selected && s.chipOn]}>
      {icon && <Ionicons name={icon} size={14} color={selected ? colors.onBrandPrimary : colors.onSurfaceTertiary} />}
      <Text style={[s.chipText, { color: selected ? colors.onBrandPrimary : colors.onSurfaceTertiary }]}>{label}</Text>
    </Pressable>
  );
}

export function Avatar({ uri, name, size = 40, ring }: { uri?: string | null; name?: string; size?: number; ring?: boolean }) {
  const { colors } = useTheme();
  const st = { width: size, height: size, borderRadius: size / 2, borderWidth: ring ? 2 : 0, borderColor: colors.surface };
  if (uri) return <Image source={{ uri }} style={st} contentFit="cover" transition={200} />;
  return (
    <View style={[st, { backgroundColor: colors.brandTertiary, alignItems: "center", justifyContent: "center" }]}>
      <Text style={{ color: colors.onBrandTertiary, fontWeight: "800", fontSize: size * 0.4 }}>{(name ?? "?").charAt(0).toUpperCase()}</Text>
    </View>
  );
}

export function TierBadge({ tier, testID }: { tier: string; testID?: string }) {
  const { colors } = useTheme();
  if (tier === "free") return null;
  const isSuper = tier === "super";
  return (
    <View testID={testID} style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, backgroundColor: isSuper ? colors.gold : colors.brandPrimary }}>
      <Ionicons name={isSuper ? "checkmark-circle" : "flash"} size={12} color={isSuper ? colors.onGold : colors.onBrandPrimary} />
      <Text style={{ fontSize: 11, fontWeight: "800", color: isSuper ? colors.onGold : colors.onBrandPrimary }}>{isSuper ? "VERIFIED" : "PREMIUM"}</Text>
    </View>
  );
}

// ---------- Wordmark (viral neon logo) ----------
export function Wordmark({ size = 40, stacked, testID }: { size?: number; stacked?: boolean; testID?: string }) {
  const { colors } = useTheme();
  const base = { fontSize: size, fontWeight: "900" as const, fontStyle: "italic" as const, letterSpacing: -size * 0.04, lineHeight: size * 1.02, includeFontPadding: false };
  const glow = (c: string) => ({ textShadowColor: c, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: size * 0.35 });
  return (
    <View testID={testID} style={{ flexDirection: stacked ? "column" : "row", alignItems: stacked ? "flex-start" : "baseline", gap: stacked ? 0 : size * 0.18 }}>
      <Text style={[base, { color: colors.onSurface }, glow(colors.brandPrimary)]}>AFTER</Text>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Text style={[base, { color: colors.brandSecondary }, glow(colors.brandSecondary)]}>PARTY</Text>
        <View style={{ width: size * 0.22, height: size * 0.22, borderRadius: size, backgroundColor: colors.brandPrimary, marginLeft: size * 0.08, alignSelf: "flex-end", marginBottom: size * 0.16 }} />
      </View>
    </View>
  );
}

// ---------- Toast ----------
type ToastT = { msg: string; kind: "ok" | "err" };
const ToastCtx = createContext<(msg: string, kind?: "ok" | "err") => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastT | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const show = useCallback((msg: string, kind: "ok" | "err" = "ok") => {
    setToast({ msg, kind });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 2800);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && (
        <Animated.View entering={FadeInUp} exiting={FadeOutUp}
          style={{ pointerEvents: "none", position: "absolute", top: insets.top + 8, left: 16, right: 16, padding: 14, borderRadius: radius.md,
            backgroundColor: toast.kind === "err" ? colors.error : colors.brandSecondary, flexDirection: "row", gap: 8, alignItems: "center" }}>
          <Ionicons name={toast.kind === "err" ? "alert-circle" : "sparkles"} size={18} color={toast.kind === "err" ? colors.onError : colors.onBrandSecondary} />
          <Text testID="toast-message" style={{ flex: 1, fontWeight: "700", color: toast.kind === "err" ? colors.onError : colors.onBrandSecondary }}>{toast.msg}</Text>
        </Animated.View>
      )}
    </ToastCtx.Provider>
  );
}

export function IconBtn({ icon, onPress, testID, ...rest }: { icon: IconName; onPress?: () => void; testID?: string } & PressableProps) {
  const { colors } = useTheme();
  return (
    <Pressable testID={testID} onPress={onPress} hitSlop={8} {...rest}
      style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.scrim, alignItems: "center", justifyContent: "center" }}>
      <Ionicons name={icon} size={22} color={colors.onSurface} />
    </Pressable>
  );
}

export const formatStart = (iso: string) => {
  const d = new Date(iso);
  const diff = (d.getTime() - Date.now()) / 36e5;
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diff < 0) return `Live now · since ${time}`;
  if (diff < 24 && d.getDate() === new Date().getDate()) return `Tonight · ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short" })} · ${time}`;
};

const useStyles = makeStyles((c) => ({
  btn: { height: 52, borderRadius: radius.pill, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, paddingHorizontal: spacing.lg },
  btnText: { fontSize: 16, fontWeight: "800", letterSpacing: 0.2 },
  chip: { height: 36, flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: c.surfaceTertiary, borderWidth: 1, borderColor: c.border },
  chipOn: { backgroundColor: c.brandPrimary, borderColor: c.brandPrimary },
  chipText: { fontSize: 14, fontWeight: "700" },
}));
