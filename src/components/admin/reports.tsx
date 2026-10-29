"use client";
// REP-01 Reports & Exports — sales / sellers / commission / payouts reports
// with a global window selector (7/30/90 days) and CSV export buttons.
import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatMinor } from "@/lib/money";
import { useApi } from "./use-api";
import { useAdminCaps } from "./use-admin-caps";
import {
  EmptyState,
  ErrorState,
  KpiCard,
  Money,
  PageHeader,
  StatusChip,
  TableSkeleton,
  fmtDT,
} from "./ui-bits";

type SalesReport = {
  series: { date: string; gmvMinor: number; orders: number; commissionMinor: number }[];
  totals: { gmvMinor: number; orders: number; commissionMinor: number; aovMinor: number };
  days: number;
};

type SellersReport = {
  rows: { storeName: string; gmvMinor: number; orders: number; commissionMinor: number; aovMinor: number }[];
  totals: { gmvMinor: number; orders: number; commissionMinor: number; stores: number };
  days: number;
};

type CommissionReport = {
  series: { date: string; gmvMinor: number; orders: number; commissionMinor: number }[];
  byCategory: { categoryName: string; commissionMinor: number }[];
  effectiveRate: number;
  totals: { commissionMinor: number; gmvMinor: number; items: number; itemsValueMinor: number };
  days: number;
};

type PayoutsReport = {
  batches: {
    id: string;
    runType: string;
    status: string;
    totalMinor: number;
    payoutCount: number;
    startedAt?: string;
    finishedAt?: string | null;
    payouts: { id: string; referenceNo: string; sellerName: string; amountMinor: number; status: string; method: string; paidAt?: string | null }[];
  }[];
  totals: { totalMinor: number; count: number; paidMinor: number; processingMinor: number; failedMinor: number; batchCount: number };
  days: number;
};

const CHART_MARGIN = { top: 8, right: 12, left: 4, bottom: 0 };

const tooltipStyle = { borderRadius: 10, fontSize: 12 };

export function ReportsView() {
  const [days, setDays] = useState("30");
  const { can } = useAdminCaps();

  const exportCsv = (entity: "orders" | "sellers" | "ledger") => {
    window.location.href = `/api/admin/export?entity=${entity}`;
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reports & Exports"
        description="Aggregated performance over a selectable window, plus CSV downloads."
        actions={
          <>
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger className="min-h-[44px] w-32" aria-label="Report window">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
            {can("reports.export") ? (
              <>
                <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0" onClick={() => exportCsv("orders")}>
                  <Download className="h-3.5 w-3.5" /> Orders CSV
                </Button>
                <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0" onClick={() => exportCsv("sellers")}>
                  <Download className="h-3.5 w-3.5" /> Sellers CSV
                </Button>
                <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0" onClick={() => exportCsv("ledger")}>
                  <Download className="h-3.5 w-3.5" /> Ledger CSV
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <Tabs defaultValue="sales">
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="sales" className="min-h-[44px]">Sales</TabsTrigger>
          <TabsTrigger value="sellers" className="min-h-[44px]">Sellers</TabsTrigger>
          <TabsTrigger value="commission" className="min-h-[44px]">Commission</TabsTrigger>
          <TabsTrigger value="payouts" className="min-h-[44px]">Payouts</TabsTrigger>
        </TabsList>

        <TabsContent value="sales" className="mt-4"><SalesTab days={days} /></TabsContent>
        <TabsContent value="sellers" className="mt-4"><SellersTab days={days} /></TabsContent>
        <TabsContent value="commission" className="mt-4"><CommissionTab days={days} /></TabsContent>
        <TabsContent value="payouts" className="mt-4"><PayoutsTab /></TabsContent>
      </Tabs>
    </div>
  );
}

/* ------------------------------------------------------------------- sales */

function SalesTab({ days }: { days: string }) {
  const { data, error, loading, refetch } = useApi<SalesReport>(`/api/admin/reports/sales?days=${days}`);
  const series = useMemo(() => (data?.series ?? []).map((p) => ({ ...p, gmvMinor: Number(p.gmvMinor) || 0, commissionMinor: Number(p.commissionMinor) || 0 })), [data]);
  const t = data?.totals;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="GMV" value={<Money minor={t?.gmvMinor} bold />} icon={undefined} sub={`${t?.orders ?? 0} paid orders`} />
        <KpiCard label="Commission" value={<Money minor={t?.commissionMinor} bold />} sub="platform earnings" />
        <KpiCard label="AOV" value={<Money minor={t?.aovMinor} bold />} sub="average order value" />
        <KpiCard label="Take rate" value={<span className="tabular-nums">{t?.gmvMinor ? `${((t.commissionMinor / t.gmvMinor) * 100).toFixed(1)}%` : "—"}</span>} sub="commission / GMV" />
      </div>

      <Card className="py-0">
        <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
          <CardTitle className="text-base">GMV & commission — last {days} days</CardTitle>
          <CardDescription>Daily paid-order totals across all storefronts</CardDescription>
        </CardHeader>
        <CardContent className="px-2 pb-4 sm:px-4">
          {error ? (
            <ErrorState message={error} onRetry={() => void refetch()} />
          ) : loading ? (
            <div className="h-[260px] animate-pulse rounded-lg bg-muted" />
          ) : series.length === 0 ? (
            <EmptyState title="No data in this window" hint="Paid orders will populate the chart." />
          ) : (
            <div className="h-[280px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={series} margin={CHART_MARGIN}>
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" vertical={false} />
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
                    formatter={(v, name) => [formatMinor(Number(v)), String(name)]}
                    labelFormatter={(l) => `Date: ${l}`}
                    contentStyle={tooltipStyle}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="gmvMinor" name="GMV" stroke="#0d9488" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="commissionMinor" name="Commission" stroke="#a16207" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
          <CardTitle className="text-base">Daily detail</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[420px] overflow-y-auto [scrollbar-width:thin]">
            {loading ? (
              <TableSkeleton rows={6} cols={4} />
            ) : series.length === 0 ? (
              <EmptyState title="No rows" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">GMV</TableHead>
                    <TableHead className="text-right">Commission</TableHead>
                    <TableHead className="text-right">Orders</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...series].reverse().map((p) => (
                    <TableRow key={p.date}>
                      <TableCell className="font-mono text-xs">{p.date}</TableCell>
                      <TableCell className="text-right"><Money minor={p.gmvMinor} /></TableCell>
                      <TableCell className="text-right"><Money minor={p.commissionMinor} muted /></TableCell>
                      <TableCell className="text-right tabular-nums">{p.orders}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ----------------------------------------------------------------- sellers */

function SellersTab({ days }: { days: string }) {
  const { data, error, loading, refetch } = useApi<SellersReport>(`/api/admin/reports/sellers?days=${days}`);
  const rows = data?.rows ?? [];
  const top8 = useMemo(() => rows.slice(0, 8), [rows]);
  const t = data?.totals;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="GMV" value={<Money minor={t?.gmvMinor} bold />} sub={`${t?.orders ?? 0} paid orders`} />
        <KpiCard label="Commission" value={<Money minor={t?.commissionMinor} bold />} sub="platform earnings" />
        <KpiCard label="Active stores" value={<span className="tabular-nums">{t?.stores ?? 0}</span>} sub="with paid orders" />
        <KpiCard
          label="Top store"
          value={<span className="truncate text-base font-semibold">{rows[0]?.storeName ?? "—"}</span>}
          sub={rows[0] ? `${formatMinor(rows[0].gmvMinor)} GMV` : "no data"}
        />
      </div>

      <Card className="py-0">
        <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
          <CardTitle className="text-base">Top 8 stores by GMV</CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-4 sm:px-4">
          {error ? (
            <ErrorState message={error} onRetry={() => void refetch()} />
          ) : loading ? (
            <div className="h-[260px] animate-pulse rounded-lg bg-muted" />
          ) : top8.length === 0 ? (
            <EmptyState title="No seller GMV in this window" />
          ) : (
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={top8} margin={CHART_MARGIN}>
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" vertical={false} />
                  <XAxis
                    dataKey="storeName"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    interval={0}
                    height={50}
                    angle={-20}
                    textAnchor="end"
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
                  <Tooltip formatter={(v) => formatMinor(Number(v))} contentStyle={tooltipStyle} cursor={{ fill: "rgba(13,148,136,0.08)" }} />
                  <Bar dataKey="gmvMinor" name="GMV" fill="#0d9488" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
          <CardTitle className="text-base">All sellers ({rows.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            {loading ? (
              <TableSkeleton rows={5} cols={5} />
            ) : rows.length === 0 ? (
              <EmptyState title="No seller activity" hint="No paid orders in this window." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Store</TableHead>
                    <TableHead className="text-right">Orders</TableHead>
                    <TableHead className="text-right">GMV</TableHead>
                    <TableHead className="text-right">Commission</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">AOV</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.storeName}>
                      <TableCell className="max-w-[220px] truncate font-medium">{r.storeName}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.orders}</TableCell>
                      <TableCell className="text-right"><Money minor={r.gmvMinor} /></TableCell>
                      <TableCell className="text-right"><Money minor={r.commissionMinor} muted /></TableCell>
                      <TableCell className="hidden text-right sm:table-cell"><Money minor={r.aovMinor} muted /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------- commission */

function CommissionTab({ days }: { days: string }) {
  const { data, error, loading, refetch } = useApi<CommissionReport>(`/api/admin/reports/commission?days=${days}`);
  const byCategory = data?.byCategory ?? [];
  const t = data?.totals;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Commission earned" value={<Money minor={t?.commissionMinor} bold />} sub={`over ${days} days`} />
        <KpiCard label="GMV base" value={<Money minor={t?.gmvMinor} bold />} sub="order totals" />
        <KpiCard label="Items sold" value={<span className="tabular-nums">{t?.items ?? 0}</span>} sub={t ? formatMinor(t.itemsValueMinor) : "—"} />
        <KpiCard label="Effective rate" value={<span className="tabular-nums">{data?.effectiveRate != null ? `${data.effectiveRate}%` : "—"}</span>} sub="commission / GMV" />
      </div>

      <Card className="py-0">
        <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
          <CardTitle className="text-base">Commission by category</CardTitle>
          <CardDescription>Where platform earnings come from (item category snapshot)</CardDescription>
        </CardHeader>
        <CardContent className="px-2 pb-4 sm:px-4">
          {error ? (
            <ErrorState message={error} onRetry={() => void refetch()} />
          ) : loading ? (
            <div className="h-[300px] animate-pulse rounded-lg bg-muted" />
          ) : byCategory.length === 0 ? (
            <EmptyState title="No commission recorded" hint="Paid orders will populate this breakdown." />
          ) : (
            <div className="w-full" style={{ height: Math.min(360, Math.max(160, byCategory.length * 44 + 40)) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byCategory} layout="vertical" margin={{ ...CHART_MARGIN, left: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" horizontal={false} />
                  <XAxis
                    type="number"
                    tickFormatter={(v) => `RM${Math.round(Number(v) / 100)}`}
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    stroke="currentColor"
                    className="text-muted-foreground"
                  />
                  <YAxis
                    type="category"
                    dataKey="categoryName"
                    width={130}
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    stroke="currentColor"
                    className="text-muted-foreground"
                  />
                  <Tooltip formatter={(v) => formatMinor(Number(v))} contentStyle={tooltipStyle} cursor={{ fill: "rgba(13,148,136,0.08)" }} />
                  <Bar dataKey="commissionMinor" name="Commission" fill="#0f766e" radius={[0, 6, 6, 0]} barSize={18} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ----------------------------------------------------------------- payouts */

function PayoutsTab() {
  const { data, error, loading, refetch } = useApi<PayoutsReport>("/api/admin/reports/payouts?days=365");
  const batches = data?.batches ?? [];
  const t = data?.totals;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Total paid out" value={<Money minor={t?.paidMinor} bold />} sub={`${t?.batchCount ?? 0} batches`} />
        <KpiCard label="Processing" value={<Money minor={t?.processingMinor} bold />} sub="in-flight payouts" />
        <KpiCard label="Failed" value={<Money minor={t?.failedMinor} bold />} sub="reversed to wallets" />
        <KpiCard label="All payouts" value={<Money minor={t?.totalMinor} bold />} sub={`${t?.count ?? 0} individual payouts`} />
      </div>

      <Card className="py-0">
        <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
          <CardTitle className="text-base">Batches</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            {error ? (
              <ErrorState message={error} onRetry={() => void refetch()} />
            ) : loading ? (
              <TableSkeleton rows={4} cols={6} />
            ) : batches.length === 0 ? (
              <EmptyState title="No payout batches yet" hint="Run one from Finance → Payout Batches." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Batch</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Payouts</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="hidden md:table-cell">Started</TableHead>
                    <TableHead className="hidden text-right lg:table-cell">Finished</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {batches.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell className="font-mono text-xs font-semibold">{b.id.slice(0, 8)}… <span className="ml-1 capitalize text-muted-foreground">{b.runType}</span></TableCell>
                      <TableCell><StatusChip status={b.status} /></TableCell>
                      <TableCell className="text-right tabular-nums">{b.payoutCount}</TableCell>
                      <TableCell className="text-right"><Money minor={b.totalMinor} bold /></TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground md:table-cell">{fmtDT(b.startedAt)}</TableCell>
                      <TableCell className="hidden text-right text-xs text-muted-foreground lg:table-cell">{b.finishedAt ? fmtDT(b.finishedAt) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
