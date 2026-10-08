"use client";
// SYS-01 Settings · SYS-02 Feature Flags · SYS-03 Audit Log (with diff viewer)
// SYS-04 Activity Log · SYS-05 Notifications · SYS-06 System Health.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Activity as ActivityIcon,
  CheckCircle2,
  Flag,
  HeartPulse,
  Mail,
  MessageCircle,
  RefreshCw,
  ScrollText,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { apiSend, useApi } from "./use-api";
import { qs } from "./nav";
import {
  DiffViewer,
  EmptyState,
  ErrorState,
  HealthDot,
  KpiCard,
  PageHeader,
  Pager,
  StatusChip,
  TableSkeleton,
  fmtDT,
  timeAgo,
} from "./ui-bits";

/* ------------------------------------------------------------- SettingsView */

type SettingRow = { key: string; valueJson: string; description?: string | null; updatedAt?: string };

function prettyValue(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 0);
  } catch {
    return raw;
  }
}

export function SettingsView() {
  const { data, error, loading, refetch } = useApi<SettingRow[]>("/api/admin/settings");
  const rows = data ?? [];

  const [editing, setEditing] = useState<SettingRow | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const openEdit = (r: SettingRow) => {
    setEditing(r);
    setDraft(r.valueJson ?? "");
  };

  const save = async () => {
    if (!editing) return;
    try {
      JSON.parse(draft);
    } catch {
      toast.error("Invalid JSON", {
        description: "Use quoted strings, numbers, booleans or objects — e.g. \"friday\" or 1000.",
      });
      return;
    }
    setSaving(true);
    try {
      await apiSend("/api/admin/settings", "PUT", { settings: [{ key: editing.key, valueJson: draft }] });
      toast.success("Setting saved", { description: editing.key });
      setEditing(null);
      void refetch();
    } catch (e) {
      toast.error("Save failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Settings"
        description="Platform configuration — JSON values consumed across commission, payouts, moderation and payments."
      />

      <Card className="py-0">
        <CardContent className="p-4">
          <div className="overflow-x-auto">
            {error ? (
              <ErrorState message={error} onRetry={() => void refetch()} />
            ) : loading ? (
              <TableSkeleton rows={6} cols={3} />
            ) : rows.length === 0 ? (
              <EmptyState title="No settings" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Key</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead className="hidden md:table-cell">Description</TableHead>
                    <TableHead className="hidden text-right lg:table-cell">Updated</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.key}>
                      <TableCell className="font-mono text-xs font-semibold">{r.key}</TableCell>
                      <TableCell>
                        <code className="block max-w-[240px] truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs" title={prettyValue(r.valueJson)}>
                          {prettyValue(r.valueJson)}
                        </code>
                      </TableCell>
                      <TableCell className="hidden max-w-[280px] text-sm text-muted-foreground md:table-cell">{r.description ?? "—"}</TableCell>
                      <TableCell className="hidden text-right text-xs text-muted-foreground lg:table-cell">{timeAgo(r.updatedAt)}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" onClick={() => openEdit(r)}>
                          Edit
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{editing?.key}</DialogTitle>
            <DialogDescription>{editing?.description ?? "Edit the JSON value for this setting."}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={5}
              className="resize-none font-mono text-xs"
              aria-label="Setting value (JSON)"
              placeholder='e.g. "friday" or 1000 or {"weights":{}}'
            />
            <p className="text-[11px] text-muted-foreground">Must be valid JSON — strings need quotes, numbers/booleans stay bare.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={saving} className="min-h-[44px] sm:min-h-0">Cancel</Button>
            <Button onClick={() => void save()} disabled={saving} className="min-h-[44px] sm:min-h-0">
              {saving ? "Saving…" : "Save setting"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ---------------------------------------------------------------- FlagsView */

type FlagRow = { key: string; description?: string | null; isEnabled: boolean; rolloutPercent: number };

export function FlagsView() {
  const { data, error, loading, refetch } = useApi<FlagRow[]>("/api/admin/feature-flags");
  const rows = data ?? [];
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const toggle = async (f: FlagRow) => {
    setBusyKey(f.key);
    try {
      await apiSend("/api/admin/feature-flags", "PATCH", { key: f.key, isEnabled: !f.isEnabled });
      toast.success(`Flag ${f.isEnabled ? "disabled" : "enabled"}`, { description: f.key });
      void refetch();
    } catch (e) {
      toast.error("Toggle failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Feature Flags" description="Runtime switches for progressive delivery — changes are audited." />

      <Card className="py-0">
        <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
          <CardTitle className="flex items-center gap-2 text-base">
            <Flag className="h-4 w-4 text-teal-600 dark:text-teal-400" /> Flags ({rows.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            <ErrorState message={error} onRetry={() => void refetch()} />
          ) : loading ? (
            <TableSkeleton rows={5} cols={4} />
          ) : rows.length === 0 ? (
            <EmptyState title="No feature flags" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Flag</TableHead>
                  <TableHead className="hidden md:table-cell">Description</TableHead>
                  <TableHead>Rollout</TableHead>
                  <TableHead className="text-center">Enabled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((f) => (
                  <TableRow key={f.key}>
                    <TableCell className="font-mono text-xs font-semibold">{f.key}</TableCell>
                    <TableCell className="hidden max-w-[320px] text-sm text-muted-foreground md:table-cell">{f.description ?? "—"}</TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn(
                          f.rolloutPercent >= 100
                            ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300"
                            : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300"
                        )}
                      >
                        {f.rolloutPercent}% rollout
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch checked={f.isEnabled} disabled={busyKey === f.key} onCheckedChange={() => void toggle(f)} aria-label={`Toggle ${f.key}`} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------- AuditView */

type AuditRow = {
  id: string;
  adminEmail: string;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  createdAt: string;
};

/** Audit rows deliver parsed objects; DiffViewer expects JSON strings. */
function asJsonStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

export function AuditView() {
  const [adminEmail, setAdminEmail] = useState("");
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [page, setPage] = useState(1);

  const url = useMemo(
    () => `/api/admin/audit-logs${qs({ adminEmail, action, entityType, page, size: 20 })}`,
    [adminEmail, action, entityType, page]
  );
  const { data, meta, error, loading, refetch } = useApi<AuditRow[]>(url);
  const rows = data ?? [];

  const [detail, setDetail] = useState<AuditRow | null>(null);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Audit Log"
        description="Every privileged admin action with a before/after snapshot."
        actions={
          <Input
            value={adminEmail}
            onChange={(e) => {
              setAdminEmail(e.target.value);
              setPage(1);
            }}
            placeholder="Filter by admin email…"
            className="min-h-[44px] w-full sm:w-56"
            aria-label="Filter by admin email"
          />
        }
      />

      <Card className="py-0">
        <CardContent className="p-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setPage(1);
              }}
              placeholder="Action contains… e.g. payout"
              className="min-h-[44px]"
              aria-label="Filter by action"
            />
            <Input
              value={entityType}
              onChange={(e) => {
                setEntityType(e.target.value);
                setPage(1);
              }}
              placeholder="Entity type… e.g. payout"
              className="min-h-[44px]"
              aria-label="Filter by entity type"
            />
          </div>

          <div className="mt-4 overflow-x-auto">
            {error ? (
              <ErrorState message={error} onRetry={() => void refetch()} />
            ) : loading ? (
              <TableSkeleton rows={8} cols={6} />
            ) : rows.length === 0 ? (
              <EmptyState title="No audit entries" hint="Adjust the filters above." />
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Admin</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead className="hidden md:table-cell">Entity</TableHead>
                      <TableHead className="hidden lg:table-cell">Entity ID</TableHead>
                      <TableHead className="text-right">When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.id} className="cursor-pointer" onClick={() => setDetail(r)}>
                        <TableCell className="max-w-[180px] truncate text-sm">{r.adminEmail}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="font-mono text-[11px]">{r.action}</Badge>
                        </TableCell>
                        <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{r.entityType ?? "—"}</TableCell>
                        <TableCell className="hidden font-mono text-xs text-muted-foreground lg:table-cell">
                          {r.entityId ? `${r.entityId.slice(0, 10)}…` : "—"}
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">{timeAgo(r.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Pager
                  page={meta?.page ?? page}
                  size={meta?.size ?? 20}
                  total={meta?.total ?? rows.length}
                  onPrev={() => setPage((p) => Math.max(1, p - 1))}
                  onNext={() => setPage((p) => p + 1)}
                />
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl [scrollbar-width:thin]">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2 font-mono text-sm">
              {detail?.action}
              <Badge variant="outline">{detail?.entityType ?? "—"}</Badge>
            </DialogTitle>
            <DialogDescription>
              {detail ? `${detail.adminEmail} · ${fmtDT(detail.createdAt)} · entity ${detail.entityId?.slice(0, 12) ?? "—"}` : ""}
            </DialogDescription>
          </DialogHeader>
          {detail ? <DiffViewer beforeJson={asJsonStr(detail.before)} afterJson={asJsonStr(detail.after)} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------- ActivityView */

type ActivityRow = {
  id: string;
  actorType: string;
  actorLabel?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  meta?: unknown;
  createdAt: string;
};

const ACTOR_TYPES = ["all", "admin", "seller", "customer", "system"];

export function ActivityView() {
  const [actorType, setActorType] = useState("all");
  const [page, setPage] = useState(1);
  const url = useMemo(() => `/api/admin/activity-logs${qs({ actorType: actorType === "all" ? "" : actorType, page, size: 25 })}`, [actorType, page]);
  const { data, meta, error, loading, refetch } = useApi<ActivityRow[]>(url);
  const rows = data ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Activity Log"
        description="Who did what across the platform — logins, exports, webhooks and more."
        actions={
          <Select
            value={actorType}
            onValueChange={(v) => {
              setActorType(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="min-h-[44px] w-40" aria-label="Actor type filter">
              <SelectValue placeholder="Actor" />
            </SelectTrigger>
            <SelectContent>
              {ACTOR_TYPES.map((t) => (
                <SelectItem key={t} value={t} className="capitalize">{t === "all" ? "All actors" : t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      <Card className="py-0">
        <CardContent className="p-4">
          <div className="overflow-x-auto">
            {error ? (
              <ErrorState message={error} onRetry={() => void refetch()} />
            ) : loading ? (
              <TableSkeleton rows={8} cols={5} />
            ) : rows.length === 0 ? (
              <EmptyState title="No activity" hint="Nothing recorded for this filter yet." />
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Actor</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead className="hidden md:table-cell">Entity</TableHead>
                      <TableHead className="hidden xl:table-cell">Meta</TableHead>
                      <TableHead className="text-right">When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell>
                          <p className="max-w-[200px] truncate text-sm font-medium">{r.actorLabel ?? "—"}</p>
                          <p className="text-xs capitalize text-muted-foreground">{r.actorType}</p>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="font-mono text-[11px]">{r.action}</Badge>
                        </TableCell>
                        <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                          {r.entityType ? `${r.entityType}${r.entityId ? ` · ${r.entityId.slice(0, 8)}…` : ""}` : "—"}
                        </TableCell>
                        <TableCell className="hidden max-w-[220px] truncate font-mono text-[11px] text-muted-foreground xl:table-cell">
                          {r.meta ? (typeof r.meta === "string" ? r.meta : JSON.stringify(r.meta)) : "—"}
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">{timeAgo(r.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Pager
                  page={meta?.page ?? page}
                  size={meta?.size ?? 25}
                  total={meta?.total ?? rows.length}
                  onPrev={() => setPage((p) => Math.max(1, p - 1))}
                  onNext={() => setPage((p) => p + 1)}
                />
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------- NotificationsView */

type NotificationRow = {
  id: string;
  event: string;
  channel: string;
  recipient: string;
  subject?: string | null;
  status: string;
  error?: string | null;
  createdAt: string;
};

export function NotificationsView() {
  const { data, error, loading, refetch } = useApi<NotificationRow[]>("/api/admin/notifications");
  const rows = data ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Notifications"
        description="Outbound notification log (email + in-app) — deliveries are simulated in this sandbox."
        actions={
          <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0" onClick={() => void refetch()} disabled={loading}>
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
          </Button>
        }
      />

      <Card className="py-0">
        <CardContent className="p-4">
          <div className="overflow-x-auto">
            {error ? (
              <ErrorState message={error} onRetry={() => void refetch()} />
            ) : loading ? (
              <TableSkeleton rows={8} cols={5} />
            ) : rows.length === 0 ? (
              <EmptyState title="No notifications yet" hint="Order and payout events will appear here." />
            ) : (
              <div className="max-h-[560px] overflow-y-auto [scrollbar-width:thin]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Event</TableHead>
                      <TableHead className="w-10">Channel</TableHead>
                      <TableHead>Recipient</TableHead>
                      <TableHead className="hidden md:table-cell">Subject</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((n) => (
                      <TableRow key={n.id}>
                        <TableCell>
                          <Badge variant="outline" className="font-mono text-[11px]">{n.event}</Badge>
                        </TableCell>
                        <TableCell>
                          {n.channel === "email" ? (
                            <Mail className="h-4 w-4 text-teal-600 dark:text-teal-400" aria-label="email" />
                          ) : (
                            <MessageCircle className="h-4 w-4 text-violet-600 dark:text-violet-400" aria-label={n.channel} />
                          )}
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate text-sm">{n.recipient}</TableCell>
                        <TableCell className="hidden max-w-[280px] truncate text-sm text-muted-foreground md:table-cell">
                          {n.subject ?? "—"}
                          {n.error ? <span className="block text-[11px] text-red-600 dark:text-red-400">{n.error}</span> : null}
                        </TableCell>
                        <TableCell><StatusChip status={n.status} /></TableCell>
                        <TableCell className="hidden text-right text-xs text-muted-foreground sm:table-cell">{timeAgo(n.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- HealthView */

type HealthAuditRow = {
  id: string;
  adminEmail?: string;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  beforeJson?: string | null;
  afterJson?: string | null;
  createdAt: string;
};

type HealthBody = {
  status?: string;
  db?: string | boolean | { ok?: boolean };
  counts?: { sellers?: number; stores?: number; products?: number; orders?: number };
  ledger?: { ok?: boolean; problems?: string[]; txnCount?: number; walletCount?: number };
  recentAudit?: HealthAuditRow[];
};

export function HealthView() {
  const { data, error, loading, refetch } = useApi<HealthBody>("/api/admin/system/health");
  const [detail, setDetail] = useState<HealthAuditRow | null>(null);

  // light polling keeps the health board fresh (30s)
  useEffect(() => {
    const t = setInterval(() => void refetch(), 30000);
    return () => clearInterval(t);
  }, [refetch]);

  const dbOk = data?.db === "up" || data?.db === true || (typeof data?.db === "object" && data?.db?.ok === true);
  const ledgerOk = data?.ledger?.ok ?? true;
  const problems = data?.ledger?.problems ?? [];
  const counts = data?.counts ?? {};
  const recent = data?.recentAudit ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="System Health"
        description="Database, ledger invariants and platform counters — auto-refreshes every 30s."
        actions={
          <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0" onClick={() => void refetch()} disabled={loading}>
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
          </Button>
        }
      />

      {error ? (
        <Card className="py-0"><CardContent className="p-4"><ErrorState message={error} onRetry={() => void refetch()} /></CardContent></Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Card className="py-0">
              <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
                <CardTitle className="flex items-center gap-2 text-base">
                  <HeartPulse className="h-4 w-4 text-teal-600 dark:text-teal-400" /> Database
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 sm:px-6 sm:pb-5">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Connection</span>
                  <HealthDot ok={dbOk} label="Database" />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">Overall status: <span className="font-medium capitalize">{data?.status ?? "unknown"}</span></p>
              </CardContent>
            </Card>

            <Card className="py-0">
              <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
                <CardTitle className="text-base">Ledger invariant</CardTitle>
                <CardDescription>Double-entry integrity across {data?.ledger?.txnCount ?? "—"} txns · {data?.ledger?.walletCount ?? "—"} wallets</CardDescription>
              </CardHeader>
              <CardContent className="px-4 pb-4 sm:px-6 sm:pb-5">
                <HealthDot ok={ledgerOk} label="Ledger invariant" />
                {problems.length > 0 ? (
                  <ul className="mt-3 space-y-1.5 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                    {problems.map((p, i) => (
                      <li key={i} className="flex items-start gap-1.5">
                        <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
                        <span className="font-mono">{p}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" /> No drift detected — debits equal credits.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCard label="Sellers" value={<span className="tabular-nums">{counts.sellers ?? 0}</span>} />
            <KpiCard label="Stores" value={<span className="tabular-nums">{counts.stores ?? 0}</span>} />
            <KpiCard label="Products" value={<span className="tabular-nums">{counts.products ?? 0}</span>} />
            <KpiCard label="Orders" value={<span className="tabular-nums">{counts.orders ?? 0}</span>} />
          </div>

          <Card className="py-0">
            <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
              <CardTitle className="flex items-center gap-2 text-base">
                <ScrollText className="h-4 w-4 text-muted-foreground" /> Recent admin audit
              </CardTitle>
              <CardDescription>Click a row to inspect the before/after snapshot.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {recent.length === 0 ? (
                <EmptyState title="No audit entries yet" />
              ) : (
                <Table>
                  <TableBody>
                    {recent.map((r) => (
                      <TableRow key={r.id} className="cursor-pointer" onClick={() => setDetail(r)}>
                        <TableCell>
                          <Badge variant="outline" className="font-mono text-[11px]">{r.action}</Badge>
                        </TableCell>
                        <TableCell className="hidden max-w-[180px] truncate text-sm text-muted-foreground sm:table-cell">{r.adminEmail ?? "—"}</TableCell>
                        <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{r.entityType ?? "—"}</TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">{timeAgo(r.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ActivityIcon className="h-3 w-3" /> Polling active — latest check {fmtDT(new Date())}
          </p>
        </>
      )}

      <Dialog open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl [scrollbar-width:thin]">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{detail?.action}</DialogTitle>
            <DialogDescription>{detail ? `${detail.adminEmail ?? ""} · ${fmtDT(detail.createdAt)}` : ""}</DialogDescription>
          </DialogHeader>
          {detail ? <DiffViewer beforeJson={detail.beforeJson} afterJson={detail.afterJson} /> : null}
        </DialogContent>
      </Dialog>

    </div>
  );
}
