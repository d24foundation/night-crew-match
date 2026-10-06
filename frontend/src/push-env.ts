import Constants from "expo-constants";
import { Platform } from "react-native";

// Remote push was removed from Expo Go (SDK 53+). Only load expo-notifications in real builds.
const isExpoGo = Constants.executionEnvironment === "storeClient";
export const pushEnabled = Platform.OS !== "web" && !isExpoGo;

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const Notifications: typeof import("expo-notifications") | null = pushEnabled ? require("expo-notifications") : null;
