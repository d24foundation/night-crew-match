import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, Share, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";

import { api, ApiError, fmtDistance, inviteLink, Party, partyLink } from "@/src/api";
import { useAuth } from "@/src/auth";
import { JoinWall, PromoSheet } from "@/src/marketing";
import { openDirections } from "@/src/reminders";
import { SafetySheet } from "@/src/safety";
import { DoorPass, RateCard, Rating } from "@/src/party-extras";
import { Avatar, Btn, formatStart, IconBtn, Ionicons, TierBadge, useToast } from "@/src/ui";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Role = "drinks" | "chipin" | "house";

export default function PartyDetail() {
  const { id, invite, stripe_session } = useLocalSearchParams<{ id: string; invite?: string; stripe_session?: string }>();
  const s = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["party", id], queryFn: () => api<Party>(`/parties/${id}`) });
  const [role, setRole] = useState<Role>("chipin");
  const [busy, setBusy] = useState(false);
  const [safety, setSafety] = useState<{ user_id: string; name: string } | null>(null);
  const [pass, setPass] = useState(false);
  const [wall, setWall] = useState(false);
  const [promo, setPromo] = useState(false);
  const { refresh } = useAuth();
  const p = q.data;
  const [paying, setPaying] = useState(false);

  // Back from Stripe after paying the chip-in: confirm and refresh the party
  const polled = useRef(false);
  useEffect(() => {
    if (!stripe_session || polled.current) return;
    polled.current = true;
    (async () => {
      for (let i = 0; i < 6; i++) {
        try {
          const r = await api<{ payment_status: string }>(`/payments/status/${stripe_session}`);
          if (r.payment_status === "paid") { toast("Chip-in paid — host notified 🎉"); q.refetch(); return; }
          if (r.payment_status === "expired") break;
        } catch { break; }
        await new Promise((res) => setTimeout(res, 2000));
      }
    })();
  }, [stripe_session, q, toast]);

  const payChipIn = async () => {
    if (!p) return;
    setPaying(true);
    try {
      const origin = Platform.OS === "web" && typeof window !== "undefined" ? window.location.origin : process.env.EXPO_PUBLIC_BACKEND_URL!;
      const r = await api<{ url: string; session_id: string }>("/payments/checkout", { body: { party_id: p.party_id, origin_url: origin } });
      if (Platform.OS === "web") { window.location.href = r.url; return; }
      await WebBrowser.openBrowserAsync(r.url);
      for (let i = 0; i < 8; i++) {
        const st = await api<{ payment_status: string }>(`/payments/status/${r.session_id}`);
        if (st.payment_status === "paid") { toast("Chip-in paid — host notified 🎉"); q.refetch(); break; }
        await new Promise((res) => setTimeout(res, 2000));
      }
    } catch (e) { toast((e as Error).message, "err"); } finally { setPaying(false); }
  };

  // Arrived via an invite link: auto-join once (invites bypass the free daily join limit).
  const inviteTried = useRef(false);
  useEffect(() => {
    if (!invite || !p || p.attending || p.is_host || inviteTried.current) return;
    inviteTried.current = true;
    (async () => {
      try {
        const r = await api<Party>(`/invites/${invite}/accept`, { body: { role: "chipin" } });
        qc.setQueryData(["party", id], r);
        qc.invalidateQueries({ queryKey: ["parties"] });
        qc.invalidateQueries({ queryKey: ["chats"] });
        toast("You're in via invite — address unlocked");
      } catch (e) { toast((e as Error).message, "err"); }
    })();
  }, [invite, p, id, qc, toast]);

  const share = async () => {
    if (!p) return;
    try {
      const { invite_code } = await api<{ invite_code: string }>(`/parties/${id}/invite`);
      const url = inviteLink(invite_code);
      const message = `You're invited to ${p.title} — ${p.area}, ${p.city}. Tap to join the afters + group chat: ${url}`;
      if (Platform.OS === "web") {
        await Clipboard.setStringAsync(url);
        toast("Invite link copied — paste it anywhere");
        return;
      }
      const r = await Share.share(Platform.OS === "ios" ? { message, url } : { message });
      if (r.action === Share.sharedAction) toast("Invite sent");
    } catch (e) { toast((e as Error).message, "err"); }
  };

  const openMaps = () => { if (p) openDirections(p); };

  const act = async (path: string, body?: object) => {
    setBusy(true);
    try {
      const r = await api<Party>(`/parties/${id}/${path}`, { method: "POST", body });
      qc.setQueryData(["party", id], r);
      qc.invalidateQueries({ queryKey: ["parties"] });
      qc.invalidateQueries({ queryKey: ["chats"] });
      if (body && (body as any).use_credits) refresh();
      toast(path === "join" ? "You're in! Address unlocked" : "You left the party");
    } catch (e) {
      if (e instanceof ApiError && e.status === 402 && path === "join") { setWall(true); return; }
      toast((e as Error).message, "err");
      if (e instanceof ApiError && e.status === 402) router.push("/premium");
    } finally { setBusy(false); }
  };

  const shareParty = async () => {
    if (!p) return;
    const url = partyLink(p.party_id);
    const message = `Afters tonight: ${p.title} — ${p.area}, ${p.city} 🔥 I'm going, come through: ${url}`;
    try {
      if (Platform.OS === "web") { await Clipboard.setStringAsync(url); toast("Party link copied"); return; }
      await Share.share(Platform.OS === "ios" ? { message, url } : { message });
    } catch (e) { toast((e as Error).message, "err"); }
  };

  if (!p) return <View style={[s.root, { justifyContent: "center" }]}><ActivityIndicator color={colors.brandPrimary} /></View>;

  const roles: { key: Role; icon: any; title: string; sub: string }[] = [
    { key: "chipin", icon: "cash", title: `Chip in £${p.chip_in}`, sub: "Split the costs" },
    { key: "drinks", icon: "wine", title: "Bring drinks", sub: `${p.drinks_count}/${p.drinks_needed} covered` },
    ...(!p.house_provided ? [{ key: "house" as Role, icon: "home", title: "Offer my place", sub: "Be the house" }] : []),
  ];

  return (
    <View style={s.root}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 120 }}>
        <View>
          <Image source={{ uri: p.cover }} style={s.hero} contentFit="cover" />
          <LinearGradient colors={["transparent", colors.surface]} style={s.heroShade} />
          <View style={[s.topBar, { top: insets.top + 8 }]}>
            <IconBtn testID="party-back-button" icon="chevron-back" onPress={() => router.back()} />
            <View style={{ flex: 1 }} />
            {p.is_host && <IconBtn testID="share-invite-button" icon="share-social" onPress={share} />}
            {p.is_host && <IconBtn testID="promo-button" icon="megaphone" onPress={() => setPromo(true)} />}
            {!p.is_host && <IconBtn testID="share-party-button" icon="share-social" onPress={shareParty} />}
            {!p.is_host && p.host && <IconBtn testID="party-safety-button" icon="ellipsis-horizontal" onPress={() => setSafety({ user_id: p.host!.user_id, name: p.host!.name })} />}
          </View>
          <View style={s.heroText}>
            <View style={s.timePill}><Ionicons name="time" size={12} color={colors.onBrandSecondary} /><Text style={s.timeText}>{formatStart(p.starts_at)}</Text></View>
            <Text style={s.title} testID="party-title">{p.title}</Text>
            <Text style={s.area}>{p.vibe} · {p.area}, {p.city}{p.distance_km != null ? ` · ${fmtDistance(p.distance_km)} away` : ""}</Text>
          </View>
        </View>

        <View style={s.body}>
          <View style={s.hostCard}>
            <Avatar uri={p.host?.picture} name={p.host?.name} size={44} />
            <View style={{ flex: 1 }}>
              <Text style={s.muted}>Hosted by</Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <Text style={s.hostName}>{p.host?.name}</Text>
                {p.host?.host_verified && <Ionicons name="shield-checkmark" size={16} color={colors.brandSecondary} testID="host-verified-badge" />}
                {p.host && <TierBadge tier={p.host.tier} />}
                <Rating avg={p.host?.rating_avg} count={p.host?.rating_count} testID="host-rating" />
              </View>
            </View>
            <Text style={s.count} testID="party-going-count">{p.going_count}/{p.capacity}</Text>
          </View>

          {p.attending && p.started && <RateCard partyId={p.party_id} hostName={p.host?.name} onRated={() => { q.refetch(); qc.invalidateQueries({ queryKey: ["ratings-pending"] }); }} />}

          {p.attending && p.chip_in > 0 && (
            <View style={[s.invite, p.my_paid ? { backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.brandSecondary } : { backgroundColor: colors.gold }]} testID="chipin-card">
              <Ionicons name={p.my_paid ? "checkmark-circle" : "cash"} size={22} color={p.my_paid ? colors.brandSecondary : colors.onGold} />
              <View style={{ flex: 1 }}>
                <Text style={[s.inviteTitle, { color: p.my_paid ? colors.onSurface : colors.onGold }]}>{p.my_paid ? "Chip-in paid ✓" : `Chip in £${p.chip_in.toFixed(2)} now`}</Text>
                <Text style={[s.inviteSub, { color: p.my_paid ? colors.onSurfaceTertiary : colors.onGold }]}>{p.my_paid ? "Thanks — the host has your share." : "Pay in-app, skip the awkward cash chat. Goes straight to the host."}</Text>
              </View>
              {!p.my_paid && <Btn testID="pay-chipin-button" title="Pay" variant="primary" loading={paying} onPress={payChipIn} style={{ height: 40, paddingHorizontal: 16 }} />}
            </View>
          )}
          {p.is_host && p.chip_in > 0 && (
            <Pressable testID="collected-card" onPress={() => router.push("/wallet")} style={[s.invite, { backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border }]}>
              <Ionicons name="wallet" size={22} color={colors.brandSecondary} />
              <View style={{ flex: 1 }}>
                <Text style={[s.inviteTitle, { color: colors.onSurface }]}>£{(p.collected ?? 0).toFixed(2)} collected · {p.paid_count} paid</Text>
                <Text style={[s.inviteSub, { color: colors.onSurfaceTertiary }]}>Chip-ins land in your wallet automatically. Tap to withdraw.</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.muted} />
            </Pressable>
          )}

          <View style={s.stats}>
            <Stat icon="home" label={p.house_provided ? "House sorted" : "Need a house"} ok={p.house_provided} />
            <Stat icon="wine" label={`${p.drinks_count}/${p.drinks_needed} drinks`} ok={p.drinks_count >= p.drinks_needed} />
            <Stat icon="cash" label={`£${p.chip_in} each`} ok />
          </View>

          {!!p.description && <Text style={s.desc}>{p.description}</Text>}

          {p.is_host && (
            <>
              <Pressable testID="invite-card" onPress={share} style={s.invite}>
                <Ionicons name="link" size={22} color={colors.onBrandSecondary} />
                <View style={{ flex: 1 }}>
                  <Text style={s.inviteTitle}>Invite your people</Text>
                  <Text style={s.inviteSub}>Share a link that drops friends straight into the party + chat</Text>
                </View>
                <Ionicons name="share-social" size={20} color={colors.onBrandSecondary} />
              </Pressable>
              <Pressable testID="promo-card" onPress={() => setPromo(true)} style={[s.invite, { backgroundColor: colors.surfaceSecondary, borderWidth: 1.5, borderColor: colors.gold }]}>
                <Ionicons name="megaphone" size={22} color={colors.gold} />
                <View style={{ flex: 1 }}>
                  <Text style={[s.inviteTitle, { color: colors.onSurface }]}>{p.promoted ? "Promoted — top of the feed" : "Promote this afters"}</Text>
                  <Text style={[s.inviteSub, { color: colors.onSurfaceTertiary }]}>AI caption for your story + pin to the top of the feed</Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color={colors.gold} />
              </Pressable>
            </>
          )}

          <Pressable style={s.addr} testID="party-address" onPress={openMaps} disabled={!p.address}>
            <Ionicons name={p.address ? "location" : "lock-closed"} size={18} color={p.address ? colors.brandSecondary : colors.muted} />
            <Text style={[s.addrText, !p.address && { color: colors.muted }]}>{p.address ?? "Exact address unlocks when you join"}</Text>
            {!!p.address && <Ionicons name="navigate" size={18} color={colors.brandSecondary} />}
          </Pressable>

          <Text style={s.section}>Who's going{p.is_host && p.checked_in_count > 0 ? ` · ${p.checked_in_count} checked in` : ""}</Text>
          {p.can_see_attendees ? (
            <View style={{ gap: 10 }} testID="attendee-list">
              {p.attendees.length === 0 && <Text style={s.muted}>No one yet — be first.</Text>}
              {p.attendees.map((a) => (
                <Pressable key={a.user_id} style={s.att} testID={`attendee-${a.user_id}`} onLongPress={() => setSafety({ user_id: a.user_id, name: a.name })}>
                  <Avatar uri={a.picture} name={a.name} size={36} />
                  <Text style={s.attName}>{a.name}</Text>
                  <TierBadge tier={a.tier} />
                  {a.checked_in && <Ionicons name="checkmark-circle" size={16} color={colors.brandSecondary} testID={`checked-in-${a.user_id}`} />}
                  {a.paid && <Ionicons name="cash" size={16} color={colors.gold} testID={`paid-${a.user_id}`} />}
                  <View style={{ flex: 1 }} />
                  <Text style={s.attRole}>{a.role === "drinks" ? "Drinks" : a.role === "house" ? "House" : "Chip-in"}</Text>
                </Pressable>
              ))}
            </View>
          ) : (
            <Pressable testID="unlock-attendees-button" onPress={() => router.push("/premium")} style={s.locked}>
              <View style={{ flexDirection: "row" }}>
                {p.attendee_pics.map((u, i) => (
                  <View key={i} style={{ marginLeft: i ? -12 : 0, opacity: 0.35 }}><Avatar uri={u} size={36} ring /></View>
                ))}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.lockedTitle}>{p.going_count - 1} people going</Text>
                <Text style={s.muted}>Super Premium shows you exactly who</Text>
              </View>
              <Ionicons name="lock-closed" size={18} color={colors.gold} />
            </Pressable>
          )}

          {!p.attending && !p.is_host && (
            <>
              <Text style={s.section}>How are you contributing?</Text>
              <View style={{ gap: 10 }}>
                {roles.map((r) => (
                  <Pressable key={r.key} testID={`role-option-${r.key}`} onPress={() => setRole(r.key)} style={[s.roleOpt, role === r.key && s.roleOn]}>
                    <Ionicons name={r.icon} size={22} color={role === r.key ? colors.brandPrimary : colors.onSurfaceTertiary} />
                    <View style={{ flex: 1 }}>
                      <Text style={s.roleTitle}>{r.title}</Text>
                      <Text style={s.muted}>{r.sub}</Text>
                    </View>
                    <Ionicons name={role === r.key ? "radio-button-on" : "radio-button-off"} size={22} color={role === r.key ? colors.brandPrimary : colors.muted} />
                  </Pressable>
                ))}
              </View>
            </>
          )}
        </View>
      </ScrollView>

      <View style={[s.bar, { paddingBottom: insets.bottom + 12 }]}>
        {p.is_host || p.attending ? (
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Btn testID="open-party-chat-button" title="Group chat" icon="chatbubbles" style={{ flex: 1 }} onPress={() => router.push(`/chat/${p.party_id}`)} />
            {p.is_host && <Btn testID="scan-door-button" title="Door" icon="qr-code" variant="lime" onPress={() => router.push(`/party/scan/${p.party_id}`)} />}
            {p.attending && <Btn testID="door-pass-button" title="Pass" icon="qr-code" variant="lime" onPress={() => setPass(true)} />}
            {p.attending && <Btn testID="leave-party-button" title="Leave" variant="ghost" loading={busy} onPress={() => act("leave")} />}
          </View>
        ) : (
          <Btn testID="join-party-button" title={p.going_count >= p.capacity ? "Party is full" : "I'm down — join"} icon="flame" loading={busy} disabled={p.going_count >= p.capacity} onPress={() => act("join", { role })} />
        )}
      </View>
      <SafetySheet target={safety} context={p.party_id} onClose={() => setSafety(null)} onBlocked={(uid) => { if (uid === p.host_id) router.back(); else q.refetch(); }} />
      <DoorPass partyId={p.party_id} visible={pass} onClose={() => setPass(false)} />
      <JoinWall visible={wall} cost={2} onClose={() => setWall(false)} onUseCredits={() => { setWall(false); act("join", { role, use_credits: true }); }} />
      {p.is_host && <PromoSheet party={p} visible={promo} onClose={() => setPromo(false)} onPromoted={() => { q.refetch(); qc.invalidateQueries({ queryKey: ["parties"] }); }} />}
    </View>
  );
}

function Stat({ icon, label, ok }: { icon: any; label: string; ok: boolean }) {
  const s = useStyles();
  const { colors } = useTheme();
  return (
    <View style={s.stat}>
      <Ionicons name={icon} size={20} color={ok ? colors.brandSecondary : colors.warning} />
      <Text style={s.statText}>{label}</Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  hero: { width: "100%", height: 320 },
  heroShade: { position: "absolute", left: 0, right: 0, bottom: 0, height: 200 },
  topBar: { position: "absolute", left: 16, right: 16, flexDirection: "row", alignItems: "center", gap: 8 },
  heroText: { position: "absolute", left: 16, right: 16, bottom: 8, gap: 6 },
  timePill: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: c.brandSecondary, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  timeText: { color: c.onBrandSecondary, fontWeight: "800", fontSize: 12 },
  title: { color: c.onSurface, fontSize: 32, fontWeight: "900", letterSpacing: -1 },
  area: { color: c.onSurfaceTertiary, fontWeight: "600" },
  body: { padding: spacing.md, gap: spacing.md },
  hostCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: c.surfaceSecondary, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: c.border },
  hostName: { color: c.onSurface, fontWeight: "800", fontSize: 16 },
  count: { color: c.brandSecondary, fontWeight: "900", fontSize: 18 },
  muted: { color: c.muted, fontSize: 13 },
  stats: { flexDirection: "row", gap: 8 },
  stat: { flex: 1, alignItems: "center", gap: 6, backgroundColor: c.surfaceSecondary, paddingVertical: 14, borderRadius: radius.md, borderWidth: 1, borderColor: c.border },
  statText: { color: c.onSurfaceSecondary, fontWeight: "700", fontSize: 12 },
  desc: { color: c.onSurfaceSecondary, fontSize: 15, lineHeight: 22 },
  addr: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderRadius: radius.md, backgroundColor: c.surfaceTertiary },
  addrText: { color: c.onSurface, fontWeight: "700", flex: 1 },
  invite: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.md, backgroundColor: c.brandSecondary },
  inviteTitle: { color: c.onBrandSecondary, fontWeight: "900", fontSize: 16 },
  inviteSub: { color: c.onBrandSecondary, opacity: 0.75, fontSize: 13, fontWeight: "600" },
  section: { color: c.onSurface, fontSize: 18, fontWeight: "900", marginTop: 4 },
  att: { flexDirection: "row", alignItems: "center", gap: 10 },
  attName: { color: c.onSurface, fontWeight: "700" },
  attRole: { color: c.brandSecondary, fontWeight: "700", fontSize: 12 },
  locked: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.md, borderWidth: 1, borderColor: c.gold, backgroundColor: c.surfaceSecondary },
  lockedTitle: { color: c.onSurface, fontWeight: "800" },
  roleOpt: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.md, backgroundColor: c.surfaceSecondary, borderWidth: 1.5, borderColor: c.border },
  roleOn: { borderColor: c.brandPrimary },
  roleTitle: { color: c.onSurface, fontWeight: "800", fontSize: 15 },
  bar: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: spacing.md, paddingTop: 12, backgroundColor: c.surface, borderTopWidth: 1, borderTopColor: c.divider },
}));
