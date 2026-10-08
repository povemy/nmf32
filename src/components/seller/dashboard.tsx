"use client";
// Task 2-d — SD-01 seller dashboard: period cards, low stock with inline restock,
// latest orders, pending actions with jump links.
import { apiGet, apiSend, CardsSkeleton, RowsSkeleton, StatCard, StatusChip, ageOf, formatMinor, runMutation, useApi, type SellerNav, type StoreMe } from "./ui-bits";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertTriangle,
  ArrowRight,
  BadgeDollarSign,
  Boxes,
  ClipboardList,
  Package,
  ReceiptText,
  Timer,
  TrendingUp,
} from "lucide-react";

type DashboardData = {
  cards: Record<"today" | "7d" | "30d", { orders: number; revenueMinor: number; commissionMinor: number; netMinor: number }>;
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

  const actions = [
    {
      key: "unfulfilled",
      label: "Orders to fulfill",
      count: data.pendingActions.unfulfilledPaidOrders,
      hint: "Paid orders waiting for packing/shipping",
      go: () => onNavigate({ view: "orders", orderId: undefined }),
    },
    {
      key: "refunds",
      label: "Open refund requests",
      count: data.pendingActions.openRefundRequests,
      hint: "Awaiting admin decision",
      go: () => onNavigate({ view: "orders", orderId: undefined }),
    },
    {
      key: "products",
      label: "Products in review",
      count: data.pendingActions.productsPendingReview,
      hint: "New or flagged products pending moderation",
      go: () => onNavigate({ view: "products", productId: undefined }),
    },
  ];

  return (
    <div className="space-y-6">
      {/* period cards */}
      <section aria-label="Performance">
        <div className="grid gap-4 md:grid-cols-3">
          {(["today", "7d", "30d"] as const).map((k) => {
            const c = data.cards[k];
            const labels: Record<string, string> = { today: "Today", "7d": "Last 7 days", "30d": "Last 30 days" };
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
        </div>
      </section>

      {/* pending actions */}
      <section aria-label="Pending actions">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <ClipboardList className="h-4 w-4 text-primary" /> Pending actions
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            {actions.map((a) => (
              <button
                key={a.key}
                onClick={a.go}
                className="flex items-start gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-muted/50"
              >
                <span
                  className={
                    "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold " +
                    (a.count > 0 ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground")
                  }
                >
                  {a.count}
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1 text-sm font-medium">
                    {a.label} <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                  </span>
                  <span className="block text-xs text-muted-foreground">{a.hint}</span>
                </span>
              </button>
            ))}
          </CardContent>
        </Card>
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
          value="8%"
          sub="Flat rate — deducted automatically at payment"
          icon={<BadgeDollarSign className="h-4 w-4" />}
        />
      </section>
    </div>
  );
}
