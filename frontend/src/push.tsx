import { useEffect, useState } from "react";
import { Modal, Platform, Text, View } from "react-native";
import * as Notifications from "expo-notifications";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";

import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { storage } from "@/src/utils/storage";
import { Btn, Ionicons } from "@/src/ui";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

const NUDGE_KEY = "pushNudgeAt";
const ASKED_KEY = "pushAskedAt";

async function registerToken(userId: string) {
  const tokenResp = await Notifications.getDevicePushTokenAsync();
  await api("/register-push", { body: { user_id: userId, platform: Platform.OS, device_token: String(tokenResp.data) } });
}

// Handles tap routing, contextual permission ask, token registration and the denied nudge.
export function PushManager() {
  const router = useRouter();
  const { user } = useAuth();
  const s = useStyles();
  const { colors } = useTheme();
  const [sheet, setSheet] = useState<"ask" | "nudge" | null>(null);

  useEffect(() => {
    if (Platform.OS === "web") return;
    const go = (data: any) => {
      const url = data?.deeplink || data?.action_url;
      if (!url) return;
      if (String(url).startsWith("http")) Linking.openURL(url);
      else router.push(url);
    };
    const tapSub = Notifications.addNotificationResponseReceivedListener((r) => go(r.notification.request.content.data));
    Notifications.getLastNotificationResponseAsync().then((r) => r && go(r.notification.request.content.data));
    return () => tapSub.remove();
  }, [router]);

  useEffect(() => {
    if (Platform.OS === "web" || !user) return;
    (async () => {
      try {
        const { status, canAskAgain } = await Notifications.getPermissionsAsync();
        if (status === "granted") { await registerToken(user.user_id); return; }
        if (canAskAgain) {
          const asked = await storage.getItem(ASKED_KEY, 0);
          if (!asked) setSheet("ask");
          return;
        }
        const last = await storage.getItem(NUDGE_KEY, 0);
        if (!last || Date.now() - Number(last) > 7 * 24 * 3600e3) setSheet("nudge");
      } catch (e) {
        console.warn("push setup failed", e);
      }
    })();
  }, [user]);

  const allow = async () => {
    setSheet(null);
    await storage.setItem(ASKED_KEY, Date.now());
    const { status } = await Notifications.requestPermissionsAsync();
    if (status === "granted" && user) registerToken(user.user_id).catch((e) => console.warn(e));
  };
  const later = async () => {
    await storage.setItem(sheet === "nudge" ? NUDGE_KEY : ASKED_KEY, Date.now());
    setSheet(null);
  };
  const openSettings = async () => {
    await storage.setItem(NUDGE_KEY, Date.now());
    setSheet(null);
    Linking.openSettings();
  };

  return (
    <Modal visible={!!sheet} transparent animationType="slide" onRequestClose={later}>
      <View style={s.wrap}>
        <View style={s.sheet} testID="push-permission-sheet">
          <Ionicons name="notifications" size={36} color={colors.brandSecondary} />
          <Text style={s.title}>Don't miss the afters</Text>
          <Text style={s.sub}>
            {sheet === "nudge"
              ? "Notifications are off. Turn them on in Settings to hear about matches, messages and who's joining your party."
              : "Get pinged when you match, when someone joins your party and when the group chat pops off."}
          </Text>
          {sheet === "nudge"
            ? <Btn testID="push-open-settings-button" title="Open Settings" icon="settings" onPress={openSettings} style={{ alignSelf: "stretch" }} />
            : <Btn testID="push-allow-button" title="Turn on notifications" icon="notifications" onPress={allow} style={{ alignSelf: "stretch" }} />}
          <Btn testID="push-later-button" title="Later" variant="ghost" onPress={later} style={{ alignSelf: "stretch" }} />
        </View>
      </View>
    </Modal>
  );
}

const useStyles = makeStyles((c) => ({
  wrap: { flex: 1, backgroundColor: c.scrim, justifyContent: "flex-end" },
  sheet: { backgroundColor: c.surfaceSecondary, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: spacing.lg, paddingBottom: spacing.xl + 8, alignItems: "center", gap: 12 },
  title: { color: c.onSurface, fontSize: 22, fontWeight: "900" },
  sub: { color: c.onSurfaceTertiary, textAlign: "center", fontSize: 15, lineHeight: 21 },
}));
