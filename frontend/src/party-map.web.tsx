import { FlatList, Pressable, Text, View } from "react-native";
import { Image } from "expo-image";

import { fmtDistance, Party } from "@/src/api";
import type { Coords } from "@/src/location";
import { formatStart, Ionicons } from "@/src/ui";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

// Web preview fallback: native maps aren't available in the browser, so show a "closest first" radar list.
export function PartyMap({ parties, me, onOpen }: { parties: Party[]; city: string; me: Coords | null; onOpen: (p: Party) => void }) {
  const s = useStyles();
  const { colors } = useTheme();
  const sorted = [...parties].sort((a, b) => (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9));
  return (
    <FlatList
      testID="party-map"
      data={sorted}
      keyExtractor={(p) => p.party_id}
      contentContainerStyle={{ padding: spacing.md, gap: 10, paddingBottom: 110 }}
      ListHeaderComponent={
        <View style={s.note}>
          <Ionicons name="map" size={18} color={colors.brandSecondary} />
          <Text style={s.noteText}>{me ? "Sorted by distance from you. The live pin map opens in the mobile app." : "Allow location to sort by distance. The live pin map opens in the mobile app."}</Text>
        </View>
      }
      renderItem={({ item: p }) => (
        <Pressable testID={`map-row-${p.party_id}`} onPress={() => onOpen(p)} style={s.row}>
          <Image source={{ uri: p.cover }} style={s.cover} contentFit="cover" />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={s.title} numberOfLines={1}>{p.title}</Text>
            <Text style={s.sub}>{formatStart(p.starts_at)} · {p.area}</Text>
          </View>
          <View style={{ alignItems: "flex-end", gap: 2 }}>
            {p.distance_km != null && <Text style={s.dist}>{fmtDistance(p.distance_km)}</Text>}
            <Text style={s.going}>{p.going_count}/{p.capacity}</Text>
          </View>
        </Pressable>
      )}
    />
  );
}

const useStyles = makeStyles((c) => ({
  note: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: radius.md, backgroundColor: c.surfaceTertiary, marginBottom: 6 },
  noteText: { color: c.onSurfaceSecondary, flex: 1, fontSize: 13, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: radius.lg, backgroundColor: c.surfaceSecondary, borderWidth: 1, borderColor: c.border },
  cover: { width: 56, height: 56, borderRadius: radius.md },
  title: { color: c.onSurface, fontWeight: "900", fontSize: 16 },
  sub: { color: c.onSurfaceTertiary, fontSize: 13, fontWeight: "600" },
  dist: { color: c.brandSecondary, fontWeight: "900" },
  going: { color: c.muted, fontSize: 12, fontWeight: "700" },
}));
