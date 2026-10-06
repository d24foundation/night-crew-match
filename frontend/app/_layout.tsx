import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, LogBox, Platform, View } from "react-native";
import * as Notifications from "expo-notifications";
import { PushManager } from "@/src/push";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { ErrorBoundary } from "@/src/components/error-boundary";
import { queryClient } from "@/src/query-client";
import { AuthProvider, useAuth } from "@/src/auth";
import { initializeRevenueCat, SubscriptionProvider } from "@/src/revenuecat";
import { ToastProvider, Wordmark } from "@/src/ui";
import { colors } from "@/src/theme";

LogBox.ignoreAllLogs(true);

if (Platform.OS !== "web") {
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
if (Platform.OS === "android") {
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
    {user && <PushManager />}
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
