// Design tokens for After Party — a dark, neon nightlife palette (same values in light & dark).
import { useMemo } from "react";
import { Appearance, StyleSheet, useColorScheme } from "react-native";

export type ColorScheme = "light" | "dark";

const palette = {
  surface: "#0B0A0F",
  onSurface: "#F5F3F7",
  surfaceSecondary: "#16141C",
  onSurfaceSecondary: "#E4E0EA",
  surfaceTertiary: "#221F2A",
  onSurfaceTertiary: "#A9A3B4",
  surfaceInverse: "#F5F3F7",
  onSurfaceInverse: "#0B0A0F",
  muted: "#8A8496",

  brand: "#FF2E63",
  onBrand: "#FFFFFF",
  brandPrimary: "#FF2E63",
  onBrandPrimary: "#FFFFFF",
  brandSecondary: "#D4FF3A",
  onBrandSecondary: "#0B0A0F",
  brandTertiary: "#2A1520",
  onBrandTertiary: "#FF7A9C",

  gold: "#FFC83D",
  onGold: "#0B0A0F",
  scrim: "rgba(11,10,15,0.85)",

  success: "#3DDC84",
  onSuccess: "#0B0A0F",
  warning: "#FFB020",
  onWarning: "#0B0A0F",
  error: "#FF4D4D",
  onError: "#FFFFFF",
  info: "#3AB8FF",
  onInfo: "#0B0A0F",

  border: "#2A2632",
  borderStrong: "#3D3847",
  divider: "#1F1C26",
};

export type ThemeColors = typeof palette;
export const colors = palette;
export const defaultScheme = "dark" satisfies ColorScheme;
export const themes: { light: ThemeColors; dark?: ThemeColors } = { light: palette, dark: palette };

export function setColorScheme(scheme: ColorScheme | null) {
  Appearance.setColorScheme?.(scheme ?? "unspecified");
}
setColorScheme?.("dark");

export function useTheme(): { scheme: ColorScheme; colors: ThemeColors } {
  const system = useColorScheme();
  const scheme: ColorScheme = system && themes[system] ? system : defaultScheme;
  return { scheme, colors: themes[scheme] ?? palette };
}

export function makeStyles<T extends StyleSheet.NamedStyles<T> | StyleSheet.NamedStyles<any>>(
  factory: (colors: ThemeColors) => T & StyleSheet.NamedStyles<any>,
): () => T {
  return function useStyles(): T {
    const { colors } = useTheme();
    return useMemo(() => StyleSheet.create(factory(colors)), [colors]);
  };
}

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };
export const radius = { sm: 8, md: 14, lg: 22, pill: 999 };
