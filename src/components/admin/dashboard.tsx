"use client";
// DASH-01 — Admin dashboard: KPI cards, GMV 30d chart, top sellers, recent signups.
import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Banknote,
  CircleDollarSign,
  FileCheck2,
  HeartPulse,
  PackageSearch,
  RefreshCw,
  Scale,
  RotateCcw,
  ShieldCheck,
  ShoppingCart,
  Store,
  UserCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatMinor } from "@/lib/money";
import { useApi } from "./use-api";
import { EmptyState, ErrorState, HealthDot, KpiCard, Money, PageHeader, StatusChip, timeAgo } from "./ui-bits";
import type { AdminNav } from "./nav";
import type { AdminDashboardData, AdminHealthData } from "@/lib/types/api-contract";

/** DASH-01 health probe — the ledger block is derived from the contract
 *  AdminHealthData; `db` stays the legacy defensive union
 *  (boolean | {ok}) because the KPI card's typeof-narrowing below relies on
 *  it (the contract types `db` as the literal "up"). */
type HealthBody = {
  db?: { ok?: boolean } | boolean;
  ledger?: Partial<Pick<AdminHealthData["ledger"], "ok" | "problems" | "txnCount" | "walletCount">>;
};

export function DashboardView({ nav }: { nav: AdminNav }) {
  const dash = useApi<AdminDashboardData>("/api/admin/dashboard");
  const health = useApi<HealthBody>("/api/admin/system/health");

  const series = useMemo(() => (dash.data?.gmvSeries30d ?? []).map((p) => ({ ...p, gmvMinor: Number(p.gmvMinor) || 0 })), [dash.data]);
  const ledgerOk = health.data?.ledger?.ok ?? true;
  const dbOk = typeof health.data?.db === "boolean" ? health.data.db : (health.data?.db?.ok ?? true);

  const refreshAll = () => {
    void dash.refetch();
    void health.refetch();
  };

  const d = dash.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Platform pulse — sales, queues, finance and system health."
        actions={
          <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0" onClick={refreshAll} disabled={dash.loading}>
            <RefreshCw className={cn("h-3.5 w-3.5", dash.loading && "animate-spin")} /> Refresh
          </Button>
        }
      />

      {dash.error ? (
        <Card className="py-0">
          <CardContent className="p-4">
            <ErrorState message={dash.error} onRetry={() => void dash.refetch()} />
          </CardContent>
        </Card>
      ) : dash.loading || !d ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-slate-200/80 bg-card p-4 shadow-soft-card">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-3 h-7 w-24" />
              <Skeleton className="mt-2 h-3 w-16" />
            </div>
          ))}
        </div>
      ) : (
        <>
          {/* KPI grid — hero gradient GMV card + standard metric cards */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div className="relative overflow-hidden rounded-xl bg-brand-gradient p-4 text-white shadow-glow-cyan">
              <div aria-hidden="true" className="pointer-events-none absolute -right-8 -bottom-8 h-32 w-32 rounded-full bg-white/10 blur-2xl" />
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-teal-50/90">GMV today</p>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/20 text-white">
                  <CircleDollarSign className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-2 text-2xl font-extrabold tracking-tight tabular-nums lg:text-3xl">{formatMinor(d.gmvTodayMinor)}</p>
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px] font-medium text-teal-50/90">
                <span className="rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] font-bold">{d.ordersToday} orders today</span>
              </div>
            </div>
            <KpiCard icon={ShoppingCart} label="Orders today" value={<span className="tabular-nums">{d.ordersToday}</span>} sub={<Money minor={d.gmvTodayMinor} muted />} />
            <KpiCard icon={Banknote} label="Commission today" value={<Money minor={d.commissionTodayMinor} bold />} tone="teal" />
            <KpiCard icon={Store} label="Active stores" value={<span className="tabular-nums">{d.activeStores}</span>} sub="live storefronts" />

            <KpiCard icon={UserCheck} label="Pending KYC" value={<span className="tabular-nums">{d.pendingKyc}</span>} tone={d.pendingKyc > 0 ? "amber" : "emerald"} onClick={() => nav.navigate("kyc-queue")} sub="KYC queue" />
            <KpiCard icon={PackageSearch} label="To moderate" value={<span className="tabular-nums">{d.productsToModerate}</span>} tone={d.productsToModerate > 0 ? "amber" : "emerald"} onClick={() => nav.navigate("moderation")} sub="product queue" />
            <KpiCard icon={RotateCcw} label="Refunds queue" value={<span className="tabular-nums">{d.refundsQueue}</span>} tone={d.refundsQueue > 0 ? "amber" : "emerald"} onClick={() => nav.navigate("refunds")} sub="awaiting action" />
            <KpiCard icon={Scale} label="Disputes open" value={<span className="tabular-nums">{d.disputesOpen}</span>} tone={d.disputesOpen > 0 ? "red" : "emerald"} onClick={() => nav.navigate("disputes")} sub="buyer disputes" />

            <KpiCard icon={Banknote} label="Payouts due" value={<Money minor={d.payoutsDueMinor} bold />} tone={d.payoutsDueMinor > 0 ? "amber" : "emerald"} onClick={() => nav.navigate("payouts")} sub={`across ${d.payoutsDueSellers} seller${d.payoutsDueSellers === 1 ? "" : "s"}`} />
            <KpiCard
              icon={HeartPulse}
              label="Ledger health"
              value={<HealthDot ok={ledgerOk} label="Ledger invariant" />}
              tone={ledgerOk ? "emerald" : "red"}
              onClick={() => nav.navigate("health")}
              sub={`${health.data?.ledger?.txnCount ?? "—"} txns · ${health.data?.ledger?.walletCount ?? "—"} wallets`}
            />
            <KpiCard
              icon={FileCheck2}
              label="Error-free"
              value={<HealthDot ok={dbOk && ledgerOk} label="Error-free" />}
              tone={dbOk && ledgerOk ? "emerald" : "red"}
              onClick={() => nav.navigate("health")}
              sub="db + ledger checks"
            />
            <KpiCard icon={ShieldCheck} label="Admin" value={<span className="text-sm font-medium">Command centre</span>} sub="PART 4 wireframes" onClick={() => nav.navigate("health")} />
          </div>

          {/* GMV chart + top sellers */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
            <Card className="py-0 xl:col-span-3">
              <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
                <CardTitle className="text-sm font-extrabold tracking-tight text-slate-900">GMV — last 30 days</CardTitle>
                <CardDescription>Gross merchandise value across all storefronts</CardDescription>
              </CardHeader>
              <CardContent className="px-2 pb-4 sm:px-4">
                {series.length === 0 ? (
                  <EmptyState title="No GMV data yet" hint="Paid orders will populate this chart." />
                ) : (
                  <div className="h-[260px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={series} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
                        <defs>
                          <linearGradient id="gmvFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#00c4b4" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#00c4b4" stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                        <XAxis
                          dataKey="date"
                          tickFormatter={(v) => String(v).slice(5)}
                          fontSize={11}
                          tickLine={false}
                          axisLine={false}
                          minTickGap={24}
                          stroke="currentColor"
                          className="text-muted-foreground"
                        />
                        <YAxis
                          tickFormatter={(v) => `RM${Math.round(Number(v) / 100)}`}
                          fontSize={11}
                          tickLine={false}
                          axisLine={false}
                          width={58}
                          stroke="currentColor"
                          className="text-muted-foreground"
                        />
                        <Tooltip
                          formatter={(v) => formatMinor(Number(v))}
                          labelFormatter={(l) => `Date: ${l}`}
                          contentStyle={{ borderRadius: 14, fontSize: 12, border: "1px solid #e2e8f0" }}
                        />
                        <Area type="monotone" dataKey="gmvMinor" stroke="#00c4b4" strokeWidth={2} fill="url(#gmvFill)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="py-0 xl:col-span-2">
              <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
                <CardTitle className="text-sm font-extrabold tracking-tight text-slate-900">Featured stores — 30d</CardTitle>
                <CardDescription>Ranked by GMV</CardDescription>
              </CardHeader>
              <CardContent className="px-0 pb-2">
                {(d.topStores ?? []).length === 0 ? (
                  <EmptyState title="No seller GMV yet" />
                ) : (
                  <div className="max-h-[300px] overflow-y-auto [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-teal-600/30 [&::-webkit-scrollbar]:w-1.5">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Store</TableHead>
                          <TableHead className="text-right">GMV 30d</TableHead>
                          <TableHead className="text-right">Orders</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(d.topStores ?? []).map((s, i) => (
                          <TableRow key={`${s.storeName}-${i}`} className="cursor-pointer hover:bg-teal-50/50" onClick={() => nav.navigate("sellers")}>
                            <TableCell className="max-w-[180px] truncate font-medium">{i + 1}. {s.storeName}</TableCell>
                            <TableCell className="text-right"><Money minor={s.gmv30dMinor} /></TableCell>
                            <TableCell className="text-right tabular-nums">{s.orders30d}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Recent signups */}
          <Card className="py-0">
            <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
              <CardTitle className="text-sm font-extrabold tracking-tight text-slate-900">Recent seller signups</CardTitle>
              <CardDescription>Newest sellers joining the marketplace</CardDescription>
            </CardHeader>
            <CardContent className="px-0 pb-2">
              {(d.recentSellers ?? []).length === 0 ? (
                <EmptyState title="No signups yet" />
              ) : (
                <Table>
                  <TableBody>
                    {(d.recentSellers ?? []).map((s) => (
                      <TableRow key={s.id} className="cursor-pointer hover:bg-teal-50/50" onClick={() => nav.navigate("seller-detail", { sellerId: s.id })}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-teal-100/70 text-sm font-semibold text-teal-800 dark:bg-teal-900/40 dark:text-teal-300">
                              {(s.displayName || "?").slice(0, 1).toUpperCase()}
                            </span>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{s.displayName}</p>
                              <p className="truncate text-xs text-muted-foreground">{s.storeName ?? "No store yet"}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell"><StatusChip status={s.status} /></TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">{timeAgo(s.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
