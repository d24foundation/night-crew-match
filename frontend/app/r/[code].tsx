import { ActivityIndicator, View } from "react-native";
import { Redirect } from "expo-router";

import { useAuth } from "@/src/auth";
import { useTheme } from "@/src/theme";

// Referral landing: the code is stashed by the root Gate (from the URL); logged-in users just go to the feed.
export default function ReferralLanding() {
  const { user } = useAuth();
  const { colors } = useTheme();
  if (user) return <Redirect href="/(tabs)" />;
  return <View style={{ flex: 1, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" }}><ActivityIndicator color={colors.brandPrimary} /></View>;
}
