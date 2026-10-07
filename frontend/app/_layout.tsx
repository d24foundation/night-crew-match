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
  // Invite links opened while logged out: remember the code and land on it after login.
  const url = Linking.useURL();
  const pendingInvite = useRef<string | null>(null);
  useEffect(() => {
    const m = url?.match(/\/invite\/([A-Za-z0-9_-]+)/);
    if (m) pendingInvite.current = m[1];
  }, [url]);
  useEffect(() => {
    if (user && pendingInvite.current) {
      const code = pendingInvite.current;
      pendingInvite.current = null;
      setTimeout(() => router.replace(`/invite/${code}`), 0);
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
