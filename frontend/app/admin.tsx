import { useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api, getApiToken, User } from "@/src/api";
import { useAuth } from "@/src/auth";
import { Sheet } from "@/src/sheet";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { Avatar, Btn, Chip, IconBtn, Ionicons, useToast } from "@/src/ui";

type Stats = {
  users: number; new_users_7d: number; parties_upcoming: number; parties_7d: number; subscribers: number;
  revenue_total: number; revenue_7d: number; revenue_by_kind: Record<string, number>; pending_verifications: number; open_reports: number; suspended: number;
};
type Pending = { user_id: string; name: string; email: string; picture?: string | null; city: string; age?: number | null; host_verification: { status: string; submitted_at: string } };
type Report = {
  report_id: string; reason: string; details: string; context?: string | null; status: string; created_at: string; action?: string;
  reporter: User | null; target: User | null; target_report_count: number;
};
type Tab = "overview" | "verify" | "reports";

// In-app admin panel (admins only): KPIs, host ID review, report moderation.
export default function Admin() {
  const s = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");

  if (!user?.is_admin) {
    return (
      <View style={[s.root, { alignItems: "center", justifyContent: "center", padding: spacing.lg, gap: 12 }]} testID="admin-forbidden">
        <Ionicons name="lock-closed" size={40} color={colors.muted} />
        <Text style={s.title}>Admins only</Text>
        <Btn title="Back" variant="ghost" onPress={() => router.back()} />
      </View>
    );
  }

  return (
    <View style={s.root}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <IconBtn testID="admin-back-button" icon="chevron-back" onPress={() => router.back()} />
        <Text style={s.title}>Admin</Text>
        <View style={{ width: 44 }} />
      </View>
      <View style={s.tabs}>
        <Chip testID="admin-tab-overview" label="Overview" selected={tab === "overview"} onPress={() => setTab("overview")} />
        <Chip testID="admin-tab-verify" label="Host IDs" selected={tab === "verify"} onPress={() => setTab("verify")} />
        <Chip testID="admin-tab-reports" label="Reports" selected={tab === "reports"} onPress={() => setTab("reports")} />
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: insets.bottom + 24 }}>
        {tab === "overview" && <Overview />}
        {tab === "verify" && <Verifications />}
        {tab === "reports" && <Reports />}
      </ScrollView>
    </View>
  );
}

function Overview() {
  const s = useStyles();
  const q = useQuery({ queryKey: ["admin-stats"], queryFn: () => api<Stats>("/admin/stats"), refetchInterval: 30000 });
  const d = q.data;
  if (!d) return <ActivityIndicator />;
  const Tile = ({ label, value, testID }: { label: string; value: string | number; testID?: string }) => (
    <View style={s.tile} testID={testID}><Text style={s.tileValue}>{value}</Text><Text style={s.tileLabel}>{label}</Text></View>
  );
  return (
    <View style={{ gap: 12 }} testID="admin-overview">
      <View style={s.grid}>
        <Tile label="Revenue (all time)" value={`£${d.revenue_total.toFixed(2)}`} testID="stat-revenue" />
        <Tile label="Revenue (7 days)" value={`£${d.revenue_7d.toFixed(2)}`} />
        <Tile label="Users" value={d.users} testID="stat-users" />
        <Tile label="New this week" value={d.new_users_7d} />
        <Tile label="Active subscribers" value={d.subscribers} />
        <Tile label="Upcoming parties" value={d.parties_upcoming} />
        <Tile label="Pending host IDs" value={d.pending_verifications} testID="stat-pending" />
        <Tile label="Open reports" value={d.open_reports} testID="stat-reports" />
      </View>
      <View style={s.card}>
        <Text style={s.cardTitle}>Revenue by source</Text>
        {Object.entries(d.revenue_by_kind).map(([k, v]) => (
          <View key={k} style={s.row}><Text style={s.rowText}>{{ plan: "Subscriptions (card)", credits: "Credit packs", chipin: "Chip-ins", bill: "Bill splits" }[k] ?? k}</Text><Text style={s.rowVal}>£{v.toFixed(2)}</Text></View>
        ))}
        <Text style={s.hint}>In-app (App Store / Play) subscriptions are tracked in RevenueCat.</Text>
      </View>
      {d.suspended > 0 && <Text style={s.hint}>{d.suspended} suspended account{d.suspended === 1 ? "" : "s"}.</Text>}
    </View>
  );
}

function Verifications() {
  const s = useStyles();
  const { colors } = useTheme();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin-pending"], queryFn: () => api<Pending[]>("/admin/host-verifications") });
  const [open, setOpen] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const token = getApiToken();
  const img = (uid: string, label: string) => ({ uri: `${process.env.EXPO_PUBLIC_BACKEND_URL}/api/admin/host-verifications/${uid}/${label}`, headers: { Authorization: `Bearer ${token}` } });

  const review = async (approve: boolean) => {
    if (!open) return;
    setBusy(true);
    try {
      await api(`/admin/host-verifications/${open.user_id}`, { body: { approve, note: approve ? "" : "Photos unclear or details didn't match. Please resubmit." } });
      toast(approve ? `${open.name} is now a verified host` : "Rejected — user asked to resubmit");
      setOpen(null);
      qc.invalidateQueries({ queryKey: ["admin-pending"] });
      qc.invalidateQueries({ queryKey: ["admin-stats"] });
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  };

  if (q.isLoading) return <ActivityIndicator />;
  const list = q.data ?? [];
  return (
    <View style={{ gap: 10 }} testID="admin-verifications">
      {list.length === 0 && <Text style={s.hint} testID="verify-empty">No host IDs waiting for review. 🎉</Text>}
      {list.map((p) => (
        <Pressable key={p.user_id} testID={`pending-${p.user_id}`} onPress={() => setOpen(p)} style={s.card}>
          <View style={s.row}>
            <Avatar uri={p.picture} name={p.name} size={40} />
            <View style={{ flex: 1 }}>
              <Text style={s.rowText}>{p.name}{p.age ? `, ${p.age}` : ""} · {p.city}</Text>
              <Text style={s.hint}>{p.email} · submitted {new Date(p.host_verification.submitted_at).toLocaleString()}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </View>
        </Pressable>
      ))}
      <Sheet visible={!!open} onClose={() => setOpen(null)} title={open ? `Review ${open.name}` : ""} sub="Does the ID photo match the selfie, and the name match the account?" testID="review-sheet">
        {open && (
          <>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1, gap: 4 }}><Text style={s.hint}>Photo ID</Text><Image source={img(open.user_id, "id_document")} style={s.kyc} resizeMode="contain" testID="kyc-id" /></View>
              <View style={{ flex: 1, gap: 4 }}><Text style={s.hint}>Selfie</Text><Image source={img(open.user_id, "selfie")} style={s.kyc} resizeMode="contain" testID="kyc-selfie" /></View>
            </View>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Btn testID="review-approve-button" title="Approve" icon="checkmark-circle" variant="lime" loading={busy} onPress={() => review(true)} style={{ flex: 1 }} />
              <Btn testID="review-reject-button" title="Reject" icon="close-circle" variant="ghost" disabled={busy} onPress={() => review(false)} style={{ flex: 1 }} />
            </View>
          </>
        )}
      </Sheet>
    </View>
  );
}

function Reports() {
  const s = useStyles();
  const { colors } = useTheme();
  const toast = useToast();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const q = useQuery({ queryKey: ["admin-reports", filter], queryFn: () => api<Report[]>(`/admin/reports?status=${filter}`) });
  const [busy, setBusy] = useState<string | null>(null);
  const LABEL: Record<string, string> = { harassment: "Harassment", fake: "Fake profile", unsafe: "Unsafe behaviour", spam: "Spam", other: "Other" };

  const resolve = async (r: Report, action: "dismiss" | "warn" | "suspend") => {
    setBusy(r.report_id + action);
    try {
      await api(`/admin/reports/${r.report_id}/resolve`, { body: { action } });
      toast(action === "dismiss" ? "Report dismissed" : action === "warn" ? `${r.target?.name ?? "User"} warned` : `${r.target?.name ?? "User"} suspended`);
      qc.invalidateQueries({ queryKey: ["admin-reports"] });
      qc.invalidateQueries({ queryKey: ["admin-stats"] });
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(null); }
  };

  return (
    <View style={{ gap: 10 }} testID="admin-reports">
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Chip testID="reports-open" label="Open" selected={filter === "open"} onPress={() => setFilter("open")} />
        <Chip testID="reports-resolved" label="Resolved" selected={filter === "resolved"} onPress={() => setFilter("resolved")} />
      </View>
      {q.isLoading ? <ActivityIndicator /> : (q.data ?? []).length === 0 ? <Text style={s.hint} testID="reports-empty">Nothing here.</Text> : (q.data ?? []).map((r) => (
        <View key={r.report_id} style={s.card} testID={`report-${r.report_id}`}>
          <View style={s.row}>
            <Avatar uri={r.target?.picture} name={r.target?.name} size={40} />
            <View style={{ flex: 1 }}>
              <Text style={s.rowText}>{r.target?.name ?? "Unknown"} <Text style={{ color: colors.error }}>· {LABEL[r.reason] ?? r.reason}</Text></Text>
              <Text style={s.hint}>by {r.reporter?.name ?? "?"} · {new Date(r.created_at).toLocaleString()} · {r.target_report_count} report{r.target_report_count === 1 ? "" : "s"} total</Text>
            </View>
          </View>
          {!!r.details && <Text style={s.details}>“{r.details}”</Text>}
          {r.status === "open" ? (
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Btn testID={`report-dismiss-${r.report_id}`} title="Dismiss" variant="ghost" loading={busy === r.report_id + "dismiss"} onPress={() => resolve(r, "dismiss")} style={{ flex: 1, height: 40 }} />
              <Btn testID={`report-warn-${r.report_id}`} title="Warn" variant="primary" loading={busy === r.report_id + "warn"} onPress={() => resolve(r, "warn")} style={{ flex: 1, height: 40 }} />
              <Btn testID={`report-suspend-${r.report_id}`} title="Suspend" variant="gold" loading={busy === r.report_id + "suspend"} onPress={() => resolve(r, "suspend")} style={{ flex: 1, height: 40 }} />
            </View>
          ) : (
            <Text style={s.hint}>Resolved · {r.action}</Text>
          )}
        </View>
      ))}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, paddingBottom: 8 },
  title: { color: c.onSurface, fontSize: 18, fontWeight: "900" },
  tabs: { flexDirection: "row", gap: 8, paddingHorizontal: spacing.md, paddingBottom: 8 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  tile: { width: "47%", flexGrow: 1, padding: 14, borderRadius: radius.md, backgroundColor: c.surfaceSecondary, borderWidth: 1, borderColor: c.border, gap: 2 },
  tileValue: { color: c.onSurface, fontSize: 22, fontWeight: "900" },
  tileLabel: { color: c.muted, fontSize: 12, fontWeight: "700" },
  card: { gap: 10, padding: 12, borderRadius: radius.md, backgroundColor: c.surfaceSecondary, borderWidth: 1, borderColor: c.border },
  cardTitle: { color: c.onSurface, fontWeight: "900", fontSize: 15 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowText: { color: c.onSurface, fontWeight: "700", flex: 1 },
  rowVal: { color: c.gold, fontWeight: "900" },
  hint: { color: c.muted, fontSize: 12 },
  details: { color: c.onSurfaceSecondary, fontStyle: "italic" },
  kyc: { width: "100%", aspectRatio: 1, borderRadius: radius.md, backgroundColor: c.surfaceTertiary },
}));
