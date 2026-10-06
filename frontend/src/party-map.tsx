import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import MapView, { Marker, PROVIDER_DEFAULT } from "react-native-maps";
import { Image } from "expo-image";

import { CITY_COORDS, fmtDistance, Party } from "@/src/api";
import type { Coords } from "@/src/location";
import { Btn, formatStart, Ionicons } from "@/src/ui";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

const DARK_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#16141c" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#a9a3b4" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#0b0a0f" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#221f2a" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0b0a0f" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
];

export function PartyMap({ parties, city, me, onOpen }: { parties: Party[]; city: string; me: Coords | null; onOpen: (p: Party) => void }) {
  const s = useStyles();
  const { colors } = useTheme();
  const map = useRef<MapView>(null);
  const [sel, setSel] = useState<Party | null>(null);
  const pins = useMemo(() => parties.filter((p) => p.lat != null && p.lng != null), [parties]);

  const region = useMemo(() => {
    if (me && city !== "All") return { latitude: me.lat, longitude: me.lng, latitudeDelta: 0.12, longitudeDelta: 0.12 };
    if (pins.length) {
      const lats = pins.map((p) => p.lat!), lngs = pins.map((p) => p.lng!);
      const pad = 0.02;
      return { latitude: (Math.min(...lats) + Math.max(...lats)) / 2, longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2,
        latitudeDelta: Math.max(0.05, Math.max(...lats) - Math.min(...lats) + pad), longitudeDelta: Math.max(0.05, Math.max(...lngs) - Math.min(...lngs) + pad) };
    }
    const c = CITY_COORDS[city] ?? CITY_COORDS.London;
    return { latitude: c[0], longitude: c[1], latitudeDelta: 0.12, longitudeDelta: 0.12 };
  }, [pins, me, city]);

  useEffect(() => { map.current?.animateToRegion(region, 500); }, [region]);

  return (
    <View style={{ flex: 1 }} testID="party-map">
      <MapView ref={map} style={{ flex: 1 }} provider={PROVIDER_DEFAULT} initialRegion={region} customMapStyle={DARK_STYLE} userInterfaceStyle="dark"
        showsUserLocation={!!me} showsMyLocationButton={false} onPress={() => setSel(null)}>
        {pins.map((p) => (
          <Marker key={p.party_id} coordinate={{ latitude: p.lat!, longitude: p.lng! }} onPress={() => setSel(p)} testID={`map-pin-${p.party_id}`} tracksViewChanges={false}>
            <View style={[s.pin, sel?.party_id === p.party_id && s.pinOn]}>
              <Ionicons name="flame" size={14} color={colors.onBrandPrimary} />
              <Text style={s.pinText}>{p.going_count}</Text>
            </View>
          </Marker>
        ))}
      </MapView>

      {me && (
        <Pressable testID="map-recenter-button" onPress={() => map.current?.animateToRegion({ latitude: me.lat, longitude: me.lng, latitudeDelta: 0.08, longitudeDelta: 0.08 }, 400)} style={s.recenter}>
          <Ionicons name="navigate" size={20} color={colors.onSurface} />
        </Pressable>
      )}

      {sel && (
        <Pressable style={s.card} testID="map-selected-card" onPress={() => onOpen(sel)}>
          <Image source={{ uri: sel.cover }} style={s.cover} contentFit="cover" />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={s.title} numberOfLines={1}>{sel.title}</Text>
            <Text style={s.sub}>{formatStart(sel.starts_at)} · {sel.area}</Text>
            <Text style={s.meta}>{sel.going_count}/{sel.capacity} going{sel.distance_km != null ? ` · ${fmtDistance(sel.distance_km)} away` : ""}</Text>
          </View>
          <Btn title="Open" onPress={() => onOpen(sel)} style={{ height: 40, paddingHorizontal: 16 }} testID="map-open-party-button" />
        </Pressable>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  pin: { flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: c.brandPrimary, paddingHorizontal: 8, paddingVertical: 5, borderRadius: radius.pill, borderWidth: 2, borderColor: c.surface },
  pinOn: { backgroundColor: c.brandSecondary, transform: [{ scale: 1.15 }] },
  pinText: { color: c.onBrandPrimary, fontWeight: "900", fontSize: 12 },
  recenter: { position: "absolute", right: 16, top: 16, width: 44, height: 44, borderRadius: 22, backgroundColor: c.scrim, alignItems: "center", justifyContent: "center" },
  card: { position: "absolute", left: spacing.md, right: spacing.md, bottom: 88, flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: radius.lg, backgroundColor: c.surfaceSecondary, borderWidth: 1, borderColor: c.border },
  cover: { width: 60, height: 60, borderRadius: radius.md },
  title: { color: c.onSurface, fontWeight: "900", fontSize: 16 },
  sub: { color: c.onSurfaceTertiary, fontSize: 13, fontWeight: "600" },
  meta: { color: c.brandSecondary, fontSize: 12, fontWeight: "800" },
}));
