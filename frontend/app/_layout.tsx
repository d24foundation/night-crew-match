import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Stack, useRouter } from "expo-router";
import * as Linking from "expo-linking";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, LogBox, Platform, View } from "react-native";
import { Notifications, pushEnabled } from "@/src/push-env";
import { PushManager } from "@/src/push";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { ErrorBoundary } from "@/src/components/error-boundary";
import { AgeGate } from "@/src/age";
import { storage } from "@/src/utils/storage";
import { queryClient } from "@/src/query-client";
import { AuthProvider, useAuth } from "@/src/auth";
import { initializeRevenueCat, SubscriptionProvider } from "@/src/revenuecat";
import { ToastProvider, Wordmark } from "@/src/ui";
import { colors } from "@/src/theme";

LogBox.ignoreAllLogs(true);

if (Notifications) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}
if (Notifications && Platform.OS === "android") {
  Notifications.setNotificationChannelAsync("default", {
    name: "Default",
    importance: Notifications.AndroidImportance.MAX,
    sound: "default",
  });
}

try {
  initializeRevenueCat();
} catch (err) {
  console.warn("RevenueCat unavailable:", err);
}

function Gate() {
  const { user, loading } = useAuth();
  const router = useRouter();
  // Invite / party / referral links opened while logged out: remember them and land there after login.
  const url = Linking.useURL();
  const pendingRoute = useRef<string | null>(null);
  useEffect(() => {
    const inv = url?.match(/\/invite\/([A-Za-z0-9_-]+)/);
    const party = url?.match(/\/party\/(party_[A-Za-z0-9]+)/);
    const ref = url?.match(/\/r\/([A-Za-z0-9]+)/);
    if (inv) pendingRoute.current = `/invite/${inv[1]}`;
    else if (party) pendingRoute.current = `/party/${party[1]}`;
    if (ref) storage.setItem("pending_ref", ref[1].toUpperCase());
  }, [url]);
  useEffect(() => {
    if (user && pendingRoute.current) {
      const route = pendingRoute.current;
      pendingRoute.current = null;
      setTimeout(() => router.replace(route as any), 0);
    }
  }, [user, router]);
  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center", gap: 16 }}>
        <Wordmark size={56} />
        <ActivityIndicator color={colors.brandSecondary} />
      </View>
    );
  }
  return (
    <>
    {user && pushEnabled && <PushManager />}
    {user && <AgeGate />}
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.surface } }}>
      <Stack.Protected guard={!user}>
        <Stack.Screen name="login" />
      </Stack.Protected>
      <Stack.Protected guard={!!user}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="party/[id]" />
        <Stack.Screen name="party/create" options={{ presentation: "modal" }} />
        <Stack.Screen name="chat/[id]" />
        <Stack.Screen name="premium" options={{ presentation: "modal" }} />
        <Stack.Screen name="edit-profile" options={{ presentation: "modal" }} />
        <Stack.Screen name="invite/[code]" options={{ presentation: "modal" }} />
        <Stack.Screen name="party/scan/[id]" options={{ presentation: "modal" }} />
        <Stack.Screen name="credits" options={{ presentation: "modal" }} />
        <Stack.Screen name="wallet" options={{ presentation: "modal" }} />
        <Stack.Screen name="r/[code]" />
      </Stack.Protected>
    </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.surface }}>
        <QueryClientProvider client={queryClient}>
          <KeyboardProvider>
            <SubscriptionProvider>
              <AuthProvider>
                <ToastProvider>
                  <StatusBar style="light" />
                  <Gate />
                </ToastProvider>
              </AuthProvider>
            </SubscriptionProvider>
          </KeyboardProvider>
        </QueryClientProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
