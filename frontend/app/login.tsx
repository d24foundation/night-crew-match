import { useEffect, useState } from "react";
import { Platform, Pressable, Text, TextInput, View, useWindowDimensions } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";

import { useAuth } from "@/src/auth";
import { Btn, Ionicons, Wordmark } from "@/src/ui";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

const HOOKS = [
  "The club closes.\nWe don't.",
  "3am? That's\nthe warm-up.",
  "Lights on at 3.\nAfters at 3:05.",
  "Your night isn't over.\nIt's just moving house.",
  "One brings the house.\nOne brings the drinks.",
];

function RotatingHook() {
  const s = useStyles();
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => (x + 1) % HOOKS.length), 2600);
    return () => clearInterval(t);
  }, []);
  return (
    <View style={s.hookBox}>
      <View style={s.hookSlot}>
        <Animated.Text key={i} entering={FadeInDown.duration(380)} exiting={FadeOut.duration(200)} style={s.hook} testID="login-hook">
          {HOOKS[i]}
        </Animated.Text>
      </View>
      <Text style={s.hookSub}>Match. Link up. Chip in. Never go home early again.</Text>
    </View>
  );
}

export default function Login() {
  const s = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { login, register, googleLogin, appleLogin } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const [appleAvailable, setAppleAvailable] = useState(false);
  useEffect(() => {
    if (Platform.OS === "ios") AppleAuthentication.isAvailableAsync().then(setAppleAvailable).catch(() => {});
  }, []);

  const signInApple = async () => {
    setErr("");
    try {
      const cred = await AppleAuthentication.signInAsync({
        requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
      });
      if (!cred.identityToken) throw new Error("No Apple identity token");
      const fullName = [cred.fullName?.givenName, cred.fullName?.familyName].filter(Boolean).join(" ") || null;
      await appleLogin(cred.identityToken, fullName, cred.email);
    } catch (e: any) {
      if (e?.code === "ERR_REQUEST_CANCELED") return;
      setErr(String(e?.message ?? e));
    }
  };

  const submit = async () => {
    setErr("");
    setBusy(true);
    try {
      if (mode === "login") await login(email.trim(), password);
      else await register(name.trim(), email.trim(), password);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.root}>
      <Image source={{ uri: "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=900" }} style={s.bg} contentFit="cover" />
      <LinearGradient colors={["transparent", colors.surface, colors.surface]} locations={[0, 0.5, 1]} style={s.bg} />
      <KeyboardAwareScrollView bottomOffset={24} contentContainerStyle={[s.content, { paddingTop: insets.top + 120, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
        <Animated.View entering={FadeInDown.duration(500)}>
          <View style={s.tag}><Ionicons name="location" size={12} color={colors.onBrandSecondary} /><Text style={s.tagText}>LONDON · WORLDWIDE</Text></View>
          <View style={{ marginTop: spacing.md }}><Wordmark fillWidth={Math.round((width - spacing.lg * 2) * 0.8)} stacked testID="app-logo" /></View>
          <RotatingHook />
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(150).duration(500)} style={s.form}>
          {mode === "register" && (
            <TextInput testID="register-name-input" style={s.input} placeholder="Your name" placeholderTextColor={colors.muted} value={name} onChangeText={setName} />
          )}
          <TextInput testID="login-email-input" style={s.input} placeholder="Email" placeholderTextColor={colors.muted} autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
          <TextInput testID="login-password-input" style={s.input} placeholder="Password" placeholderTextColor={colors.muted} secureTextEntry value={password} onChangeText={setPassword} />
          {!!err && <Text testID="login-error" style={s.err}>{err}</Text>}
          <Btn testID="login-submit-button" title={mode === "login" ? "Keep the night going" : "I'm down — sign me up"} icon="flame" onPress={submit} loading={busy} />
          <View style={s.orRow}><View style={s.line} /><Text style={s.or}>or</Text><View style={s.line} /></View>
          <Btn testID="google-login-button" title="Continue with Google" variant="ghost" icon="logo-google" onPress={() => googleLogin().catch((e) => setErr(String(e.message ?? e)))} />
          {appleAvailable && (
            <AppleAuthentication.AppleAuthenticationButton
              testID="apple-login-button"
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
              buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
              cornerRadius={26}
              style={{ height: 52 }}
              onPress={signInApple}
            />
          )}
          <Pressable testID="toggle-auth-mode" onPress={() => { setErr(""); setMode(mode === "login" ? "register" : "login"); }} style={s.switch}>
            <Text style={s.switchText}>{mode === "login" ? "First night out with us? " : "Already on the list? "}<Text style={{ color: colors.brandSecondary }}>{mode === "login" ? "Get on the list" : "Log in"}</Text></Text>
          </Pressable>
        </Animated.View>
      </KeyboardAwareScrollView>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  bg: { position: "absolute", top: 0, left: 0, right: 0, height: 560 },
  content: { paddingHorizontal: spacing.lg, flexGrow: 1, justifyContent: "flex-end" },
  tag: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: c.brandSecondary, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  tagText: { color: c.onBrandSecondary, fontSize: 11, fontWeight: "900", letterSpacing: 1 },
  logo: { color: c.onSurface, fontSize: 72, fontWeight: "900", letterSpacing: -3, lineHeight: 70, marginTop: spacing.md },
  hookBox: { marginTop: spacing.md, gap: 8 },
  hookSlot: { height: 60, overflow: "hidden" },
  hook: { position: "absolute", top: 0, left: 0, right: 0, color: c.onSurface, fontSize: 24, fontWeight: "900", lineHeight: 28, letterSpacing: -0.5 },
  hookSub: { color: c.onSurfaceTertiary, fontSize: 14, fontWeight: "600" },
  tagline: { color: c.onSurfaceTertiary, fontSize: 16, lineHeight: 23, marginTop: spacing.md },
  form: { marginTop: spacing.xl, gap: 12 },
  input: { height: 54, borderRadius: radius.md, backgroundColor: c.surfaceTertiary, color: c.onSurface, paddingHorizontal: spacing.md, fontSize: 16, borderWidth: 1, borderColor: c.border },
  err: { color: c.error, fontWeight: "600" },
  orRow: { flexDirection: "row", alignItems: "center", gap: 12, marginVertical: 4 },
  line: { flex: 1, height: 1, backgroundColor: c.border },
  or: { color: c.muted },
  switch: { alignItems: "center", padding: 12 },
  switchText: { color: c.onSurfaceTertiary, fontWeight: "600" },
}));
