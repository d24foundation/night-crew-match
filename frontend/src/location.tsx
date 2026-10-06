import { useCallback, useState } from "react";
import * as Location from "expo-location";
import * as Linking from "expo-linking";

import { Btn } from "@/src/ui";
import { Sheet } from "@/src/sheet";

export type Coords = { lat: number; lng: number };

// Contextual location permission: explain → ask → fall back to the city centre if denied,
// and point to Settings when the OS won't ask again.
export function useLocation() {
  const [coords, setCoords] = useState<Coords | null>(null);
  const [sheet, setSheet] = useState<"ask" | "settings" | null>(null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async () => {
    setBusy(true);
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const c = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      setCoords(c);
      return c;
    } catch {
      return null;
    } finally { setBusy(false); }
  }, []);

  // Called on clear user intent (opening the map / "near me"). Returns coords or null.
  const locate = useCallback(async () => {
    if (coords) return coords;
    const perm = await Location.getForegroundPermissionsAsync();
    if (perm.status === "granted") return read();
    if (perm.canAskAgain) { setSheet("ask"); return null; }
    setSheet("settings");
    return null;
  }, [coords, read]);

  const allow = async () => {
    setSheet(null);
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status === "granted") await read();
    else if (!perm.canAskAgain) setSheet("settings");
  };

  const ui = (
    <Sheet visible={!!sheet} onClose={() => setSheet(null)} testID="location-permission-sheet"
      title={sheet === "settings" ? "Location is off" : "Find the closest afters"}
      sub={sheet === "settings"
        ? "Turn on location in Settings to sort parties by distance. You can still browse the map by city."
        : "We use your location only while the app is open, to show how far each party is. Never shared with other users."}>
      {sheet === "settings"
        ? <Btn testID="location-open-settings-button" title="Open Settings" icon="settings" onPress={() => { setSheet(null); Linking.openSettings(); }} />
        : <Btn testID="location-allow-button" title="Use my location" icon="navigate" onPress={allow} />}
      <Btn testID="location-later-button" title="Not now" variant="ghost" onPress={() => setSheet(null)} />
    </Sheet>
  );

  return { coords, locate, busy, ui };
}
