"use client";
// Task 2-d — SD-01 seller dashboard: period cards, low stock with inline restock,
// latest orders, pending actions with jump links.
import { apiGet, apiSend, CardsSkeleton, RowsSkeleton, StatCard, StatusChip, ageOf, formatMinor, runMutation, useApi, useSellerTerms, fmtCommissionPercent, holdAfterPayment, type SellerNav, type StoreMe } from "./ui-bits";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  ArrowRight,
  BadgeDollarSign,
  Boxes,
  ClipboardCheck,
  ClipboardList,
  Package,
  ReceiptText,
  Timer,
  TrendingUp,
  Undo2,
  Wallet2,
} from "lucide-react";

type DashboardData = {
  cards: Record<"today" | "7d" | "30d", { orders: number; revenueMinor: number; commissionMinor: number; netMinor: number }>;
  // R2-UI — ledger-truth wallet snapshot (refreshWalletCache + cached read).
  wallet: { availableMinor: number; pendingMinor: number };
  lowStock: {
    id: string;
    name: string;
    optionValue: string | null;
    sku: string | null;
    stock: number;
    lowStockThreshold: number;
    productId: string;
    productTitle: string;
  }[];
  latestOrders: {
    id: string;
    orderNumber: string;
    customerName: string;
    status: string;
    totalMinor: number;
    itemCount: number;
    createdAt: string;
  }[];
  pendingActions: { unfulfilledPaidOrders: number; openRefundRequests: number; productsPendingReview: number };
};

export default function SellerDashboard({ onNavigate }: { onNavigate: (n: SellerNav) => void }) {
  const { data, loading, error, refetch } = useApi<DashboardData>("/api/store/dashboard");
  const { data: me } = useApi<StoreMe>("/api/store/me");
  // ADDENDUM #8 — live platform terms (commission %, hold) from the admin
  // settings via /api/store/terms; shared module cache means one fetch / 60 s.
  const { terms } = useSellerTerms();

  const restock = async (variantId: string, title: string) => {
    const ok = await runMutation(
      () => apiSend("POST", "/api/store/inventory/adjust", { variantId, delta: 10, reason: "restock" }),
      `Restocked +10 — ${title}`
    );
    if (ok) refetch();
  };

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-rose-600">Failed to load dashboard: {error}</CardContent>
      </Card>
    );
  }

  if (loading || !data) {
    return (
      <div className="space-y-5">
        <CardsSkeleton count={3} />
        <RowsSkeleton rows={3} />
      </div>
    );
  }

  // ---- Pending actions (ADDENDUM #8) — each action gets its own large,
  // urgency-colored card so counts cannot be missed. Tiers:
  //   urgent (rose):  unfulfilled ≥ 5 · refunds ≥ 3
  //   warn   (amber): unfulfilled 1–4 · refunds 1–2 · products in review ≥ 1
  //   ok     (emerald): zero — "All clear"
  // Products-in-review never goes rose: it is an expected admin-side flow.
  type Urgency = "ok" | "warn" | "urgent";
  const URGENCY: Record<
    Urgency,
    { chip: string; number: string; bar: string; iconBg: string; badge: string; chipLabel: string; short: string }
  > = {
    ok: {
      chip: "border-emerald-200 bg-emerald-100 text-emerald-800",
      number: "text-emerald-600",
      bar: "bg-emerald-500",
      iconBg: "bg-emerald-100 text-emerald-700",
      badge: "border-emerald-200 bg-emerald-100 text-emerald-800",
      chipLabel: "All clear",
      short: "All caught up",
    },
    warn: {
      chip: "border-amber-200 bg-amber-100 text-amber-800",
      number: "text-amber-600",
      bar: "bg-amber-400",
      iconBg: "bg-amber-100 text-amber-700",
      badge: "border-amber-200 bg-amber-100 text-amber-800",
      chipLabel: "Action needed",
      short: "open",
    },
    urgent: {
      chip: "border-rose-200 bg-rose-100 text-rose-800",
      number: "text-rose-600",
      bar: "bg-rose-500",
      iconBg: "bg-rose-100 text-rose-700",
      badge: "border-rose-200 bg-rose-100 text-rose-800",
      chipLabel: "Urgent",
      short: "needs urgent action",
    },
  };

  const actionCards = [
    {
      key: "unfulfilled",
      label: "Orders to fulfill",
      count: data.pendingActions.unfulfilledPaidOrders,
      hint: "Paid orders waiting for packing & shipping",
      icon: Package,
      urgency: (data.pendingActions.unfulfilledPaidOrders >= 5 ? "urgent" : data.pendingActions.unfulfilledPaidOrders > 0 ? "warn" : "ok") as Urgency,
      go: () => onNavigate({ view: "orders", orderId: undefined }),
    },
    {
      key: "refunds",
      label: "Refund requests",
      count: data.pendingActions.openRefundRequests,
      hint: "Customers waiting on a refund decision",
      icon: Undo2,
      urgency: (data.pendingActions.openRefundRequests >= 3 ? "urgent" : data.pendingActions.openRefundRequests > 0 ? "warn" : "ok") as Urgency,
      go: () => onNavigate({ view: "orders", orderId: undefined }),
    },
    {
      key: "products",
      label: "Products in review",
      count: data.pendingActions.productsPendingReview,
      hint: "Awaiting moderation before going live",
      icon: ClipboardCheck,
      urgency: (data.pendingActions.productsPendingReview > 0 ? "warn" : "ok") as Urgency,
      go: () => onNavigate({ view: "products", productId: undefined }),
    },
  ];

  const totalOpen = actionCards.reduce((s, a) => s + a.count, 0);
  const maxUrgency: Urgency = actionCards.some((a) => a.urgency === "urgent")
    ? "urgent"
    : actionCards.some((a) => a.urgency === "warn")
      ? "warn"
      : "ok";

  // Live commission copy — effective default rate for THIS seller (seller
  // override ?? admin global), with fixed-fee / minimum noted when configured.
  const commissionSub = (() => {
    if (!terms) return "Syncing with platform settings…";
    const bits: string[] = [terms.commissionSource === "seller_override" ? "Your negotiated rate" : "Default rate"];
    if (terms.hasFixedFee) bits.push(`+ ${formatMinor(terms.fixedFeeMinor)} fixed fee/order`);
    if (terms.hasMinCommission) bits.push(`min ${formatMinor(terms.minCommissionMinor)}/order`);
    return `${bits.join(" · ")} — deducted at payment`;
  })();

  return (
    <div className="space-y-6">
      {/* period cards */}
      <section aria-label="Performance">
        <div className="grid gap-4 md:grid-cols-3">
          {(["today", "7d"] as const).map((k) => {
            const c = data.cards[k];
            const labels: Record<string, string> = { today: "Today", "7d": "Last 7 days" };
            return (
              <Card key={k} className="gap-3">
                <CardHeader className="pb-0">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    {k === "today" ? <Timer className="h-4 w-4 text-primary" /> : <TrendingUp className="h-4 w-4 text-primary" />}
                    {labels[k]}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">Orders</p>
                      <p className="text-lg font-semibold tabular-nums">{c.orders}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Revenue</p>
                      <p className="text-lg font-semibold tabular-nums">{formatMinor(c.revenueMinor)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Commission</p>
                      <p className="text-sm font-medium tabular-nums text-amber-600">−{formatMinor(c.commissionMinor)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Net to you</p>
                      <p className="text-sm font-medium tabular-nums text-emerald-600">{formatMinor(c.netMinor)}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
          {/* R2-UI — "Available e-wallet" replaces the "Last 30 days" card in the
              grid (the API still returns 30d data; the UI simply stops showing it). */}
          <button
            type="button"
            onClick={() => onNavigate({ view: "wallet" })}
            aria-label="Available e-wallet — open wallet"
            className="flex flex-col rounded-xl border bg-card text-left shadow-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <div className="flex items-center gap-2 px-6 pt-6">
              <Wallet2 className="h-4 w-4 text-emerald-600" />
              <span className="text-sm font-semibold">Available e-wallet</span>
              <ArrowRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <div className="flex flex-1 flex-col justify-center gap-1 p-6 pt-3">
              <p className="text-2xl font-semibold tabular-nums text-emerald-600 sm:text-3xl">
                {formatMinor(data.wallet?.availableMinor ?? 0)}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatMinor(data.wallet?.pendingMinor ?? 0)} pending · released {terms ? holdAfterPayment(terms) : "after the clearing hold"}
              </p>
            </div>
          </button>
        </div>
      </section>

      {/* pending actions — ADDENDUM #8: one large urgency-colored card per
          action (big count, color-coded severity) so nothing gets missed. */}
      <section aria-label="Pending actions">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <ClipboardList className="h-4 w-4 text-primary" /> Pending actions
          </h2>
          <Badge variant="outline" className={cn("border font-medium", URGENCY[maxUrgency].badge)}>
            {totalOpen === 0 ? "All caught up" : `${totalOpen} open item${totalOpen === 1 ? "" : "s"}`}
          </Badge>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {actionCards.map((a) => {
            const s = URGENCY[a.urgency];
            const Icon = a.icon;
            const display = a.count > 99 ? "99+" : String(a.count);
            return (
              <button
                key={a.key}
                type="button"
                onClick={a.go}
                aria-label={`${a.label}: ${display} — ${s.chipLabel}`}
                className="group relative flex min-h-[44px] flex-col gap-3 overflow-hidden rounded-xl border bg-card p-5 text-left shadow-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <span aria-hidden className={cn("absolute inset-x-0 top-0 h-1", s.bar)} />
                <span className="flex items-center justify-between gap-2">
                  <span className={cn("flex h-10 w-10 items-center justify-center rounded-lg", s.iconBg)}>
                    <Icon className="h-5 w-5" />
                  </span>
                  <Badge variant="outline" className={cn("border font-medium", s.chip)}>
                    {a.urgency === "ok" ? "All clear" : s.chipLabel}
                  </Badge>
                </span>
                <span>
                  <span className={cn("block text-4xl font-bold leading-none tabular-nums sm:text-5xl", s.number)}>
                    {display}
                  </span>
                  <span className="mt-2.5 flex items-center gap-1 text-sm font-medium">
                    {a.label}
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{a.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* low stock */}
        <section aria-label="Low stock">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <AlertTriangle className="h-4 w-4 text-amber-500" /> Low stock
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.lowStock.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Everything is well stocked 🎉</p>
              ) : (
                <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {data.lowStock.map((v) => (
                    <li key={v.id} className="flex items-center gap-3 rounded-xl border p-2.5">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                        <Boxes className="h-4 w-4 text-muted-foreground" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {v.productTitle}
                          {v.optionValue ? <span className="text-muted-foreground"> · {v.optionValue}</span> : null}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {v.sku ? `${v.sku} · ` : ""}threshold {v.lowStockThreshold}
                        </p>
                      </div>
                      <span
                        className={
                          "rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums " +
                          (v.stock === 0 ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700")
                        }
                      >
                        {v.stock} left
                      </span>
                      <Button size="sm" variant="outline" className="h-8 shrink-0" onClick={() => restock(v.id, v.productTitle)}>
                        +10
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>

        {/* latest orders */}
        <section aria-label="Latest orders">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="flex items-center gap-2 text-sm">
                <ReceiptText className="h-4 w-4 text-primary" /> Latest orders
              </CardTitle>
              <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => onNavigate({ view: "orders" })}>
                View all <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </CardHeader>
            <CardContent>
              {data.latestOrders.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No orders yet — share your storefront link to get the first sale!
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Order</TableHead>
                        <TableHead>Customer</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.latestOrders.map((o) => (
                        <TableRow
                          key={o.id}
                          className="cursor-pointer"
                          onClick={() => onNavigate({ view: "orders", orderId: o.id })}
                        >
                          <TableCell>
                            <p className="font-medium">{o.orderNumber}</p>
                            <p className="text-xs text-muted-foreground">{ageOf(o.createdAt)} · {o.itemCount} item{o.itemCount === 1 ? "" : "s"}</p>
                          </TableCell>
                          <TableCell className="max-w-32 truncate">{o.customerName}</TableCell>
                          <TableCell><StatusChip status={o.status} /></TableCell>
                          <TableCell className="text-right tabular-nums">{formatMinor(o.totalMinor)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      </div>

      {/* quick stats strip */}
      <section aria-label="Quick summary" className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="All-time orders"
          value={String(me?.stats.ordersCount ?? "—")}
          sub={`${me?.stats.productCount ?? "—"} products in catalog`}
          icon={<Package className="h-4 w-4" />}
        />
        <StatCard
          label="Revenue (30d)"
          value={me ? formatMinor(me.stats.revenue30dMinor) : "—"}
          sub="Paid orders in the last 30 days"
          icon={<TrendingUp className="h-4 w-4" />}
        />
        <StatCard
          label="Platform commission"
          value={terms ? fmtCommissionPercent(terms.commissionPercent) : "—"}
          sub={commissionSub}
          icon={<BadgeDollarSign className="h-4 w-4" />}
        />
      </section>
    </div>
  );
}
