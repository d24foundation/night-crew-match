import { useState } from "react";
import { Platform, Share, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";

import { api, ApiError, Party, partyLink } from "@/src/api";
import { useAuth } from "@/src/auth";
import { Sheet } from "@/src/sheet";
import { Btn, useToast } from "@/src/ui";
import { makeStyles, radius, spacing } from "@/src/theme";

// Host marketing kit: AI caption to post, one-tap share, and paid promotion to the top of the feed.
export function PromoSheet({ party, visible, onClose, onPromoted }: { party: Party; visible: boolean; onClose: () => void; onPromoted: () => void }) {
  const s = useStyles();
  const toast = useToast();
  const router = useRouter();
  const { refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ["promo", party.party_id], queryFn: () => api<{ caption: string }>(`/parties/${party.party_id}/promo`), enabled: visible, staleTime: Infinity });
  const link = partyLink(party.party_id);
  const caption = q.data?.caption ?? "";

  const copy = async () => { await Clipboard.setStringAsync(`${caption}\n${link}`); toast("Caption copied — paste it on your story"); };
  const share = async () => {
    const message = `${caption}\n${link}`;
    try {
      if (Platform.OS === "web") { await copy(); return; }
      await Share.share(Platform.OS === "ios" ? { message, url: link } : { message });
    } catch (e) { toast((e as Error).message, "err"); }
  };
  const promote = async () => {
    setBusy(true);
    try {
      await api(`/parties/${party.party_id}/promote`, { method: "POST" });
      await refresh();
      toast("Promoted! Pinned to the top of the feed for 24h");
      onPromoted();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 402) { toast(e.message, "err"); onClose(); router.push("/credits"); }
      else toast((e as Error).message, "err");
    } finally { setBusy(false); }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Promote your afters" sub="Fill the house: post the caption, share the link, or pin it to the top of the feed." testID="promo-sheet">
      <View style={s.caption}>
        <Text style={s.captionText} testID="promo-caption">{q.isLoading ? "Writing your caption…" : caption}</Text>
      </View>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Btn testID="promo-copy-button" title="Copy" icon="copy" variant="ghost" style={{ flex: 1 }} onPress={copy} disabled={!caption} />
        <Btn testID="promo-share-button" title="Share" icon="share-social" style={{ flex: 1 }} onPress={share} disabled={!caption} />
      </View>
      {party.promoted ? (
        <Text style={s.pinned} testID="promo-pinned">Pinned to the top of the feed right now.</Text>
      ) : (
        <Btn testID="promo-pin-button" title="Pin to top of feed — 10 credits" icon="rocket" variant="lime" loading={busy} onPress={promote} />
      )}
      <Btn title="Done" variant="ghost" onPress={onClose} />
    </Sheet>
  );
}

// Shown to free members when they hit the daily join limit: upgrade or spend credits.
export function JoinWall({ visible, onClose, onUseCredits, cost }: { visible: boolean; onClose: () => void; onUseCredits: () => void; cost: number }) {
  const router = useRouter();
  const { user } = useAuth();
  const balance = user?.credits ?? 0;
  return (
    <Sheet visible={visible} onClose={onClose} title="You're on a roll" sub={`Free members get 3 joins a day. Keep going with Premium, or use ${cost} credits (you have ${balance}).`} testID="join-wall">
      <Btn testID="join-wall-premium-button" title="Go Premium — unlimited joins" icon="flash" onPress={() => { onClose(); router.push("/premium"); }} />
      {balance >= cost ? (
        <Btn testID="join-wall-credits-button" title={`Use ${cost} credits to join`} icon="ticket" variant="lime" onPress={onUseCredits} />
      ) : (
        <Btn testID="join-wall-topup-button" title="Top up credits from £1" icon="card" variant="ghost" onPress={() => { onClose(); router.push("/credits"); }} />
      )}
      <Btn title="Not now" variant="ghost" onPress={onClose} />
    </Sheet>
  );
}

const useStyles = makeStyles((c) => ({
  caption: { padding: spacing.md, borderRadius: radius.md, backgroundColor: c.surfaceTertiary, borderWidth: 1, borderColor: c.border },
  captionText: { color: c.onSurface, fontSize: 15, lineHeight: 22 },
  pinned: { color: c.brandSecondary, fontWeight: "800", textAlign: "center" },
}));
