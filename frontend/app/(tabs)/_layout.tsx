import { Platform } from "react-native";
import { Tabs } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";

import { usesNativeTabs } from "@/src/navigation";
import { Ionicons, IconName } from "@/src/ui";
import { colors } from "@/src/theme";

const TABS: { name: string; label: string; icon: IconName; sf: string }[] = [
  { name: "index", label: "Parties", icon: "flame", sf: "flame.fill" },
  { name: "swipe", label: "Match", icon: "heart", sf: "heart.fill" },
  { name: "chats", label: "Chats", icon: "chatbubbles", sf: "bubble.left.and.bubble.right.fill" },
  { name: "profile", label: "Profile", icon: "person", sf: "person.fill" },
];

export default function TabsLayout() {
  if (usesNativeTabs) {
    return (
      <NativeTabs tintColor={colors.brandPrimary}>
        {TABS.map((t) => (
          <NativeTabs.Trigger key={t.name} name={t.name}>
            <NativeTabs.Trigger.Icon sf={t.sf as any} />
            <NativeTabs.Trigger.Label>{t.label}</NativeTabs.Trigger.Label>
          </NativeTabs.Trigger>
        ))}
      </NativeTabs>
    );
  }
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brandPrimary,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.surfaceSecondary, borderTopColor: colors.border, ...(Platform.OS === "web" ? { height: 64 } : {}) },
        tabBarItemStyle: { alignSelf: "center" },
        tabBarLabelStyle: { fontWeight: "700" },
      }}
    >
      {TABS.map((t) => (
        <Tabs.Screen key={t.name} name={t.name} options={{
          title: t.label,
          tabBarButtonTestID: `tab-${t.name}`,
          tabBarIcon: ({ color, size }) => <Ionicons name={t.icon} color={color} size={size} />,
        }} />
      ))}
    </Tabs>
  );
}
