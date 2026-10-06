import React from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { makeStyles, radius, spacing } from "@/src/theme";

// Bottom sheet used by the permission, safety and photo flows.
export function Sheet({ visible, onClose, title, sub, children, testID }: {
  visible: boolean; onClose: () => void; title: string; sub?: string; children: React.ReactNode; testID?: string;
}) {
  const s = useStyles();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.wrap} onPress={onClose}>
        <Pressable style={[s.sheet, { paddingBottom: insets.bottom + spacing.lg }]} testID={testID} onPress={() => {}}>
          <View style={s.handle} />
          <Text style={s.title}>{title}</Text>
          {!!sub && <Text style={s.sub}>{sub}</Text>}
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const useStyles = makeStyles((c) => ({
  wrap: { flex: 1, backgroundColor: c.scrim, justifyContent: "flex-end" },
  sheet: { backgroundColor: c.surfaceSecondary, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: spacing.lg, gap: 12 },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: c.borderStrong, marginBottom: 4 },
  title: { color: c.onSurface, fontSize: 22, fontWeight: "900" },
  sub: { color: c.onSurfaceTertiary, fontSize: 15, lineHeight: 21 },
}));
