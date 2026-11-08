"use client";
// Task 2-d — SD-04/05 Orders + Task 14-a rebuild: tabbed list with tracking
// badges, full detail (items, money, address, shipment panel, timeline),
// ShipOrderDialog (platform booking + manual), DeliverDialog (POD proof),
// refund-request actions, printable packing slip.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import DeliverDialog from "./deliver-dialog";
import ShipOrderDialog from "./ship-order-dialog";
import ShipmentPanel from "./shipment-panel";
import {
  apiGet,
  apiGetPaged,
  apiSend,
  EmptyState,
  MoneyInput,
  RowsSkeleton,
  StatusChip,
  ageOf,
  fmtDateTime,
  formatMinor,
  holdAfterPayment,
  runMutation,
  useApi,
  useSellerTerms,
  type SellerNav,
} from "./ui-bits";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { FulfillData, RefundRequestData, SellerOrderDetailData, SellerOrderRow } from "@/lib/types/api-contract";
import {
  ArrowLeft,
  CircleDollarSign,
  ClipboardList,
  Loader2,
  MapPin,
  PackageCheck,
  Printer,
  RotateCcw,
  Search,
  Truck,
  Undo2,
} from "lucide-react";

// ---------------------------------------------------------------- types

/** GET /api/store/orders/[id] view: the contract types `shippingAddress` as a
 *  loose Record<string, unknown>; the detail view + packing slip render a
 *  known subset of optional string fields, so that one field is re-narrowed
 *  here (everything else is SellerOrderDetailData verbatim). */
type OrderDetail = Omit<SellerOrderDetailData, "shippingAddress"> & {
  shippingAddress: { line1?: string; line2?: string; city?: string; postcode?: string; state?: string; country?: string };
};

const TABS = [
  { key: "to_fulfill", label: "To fulfill" },
  { key: "shipped", label: "Shipped" },
  { key: "done", label: "Completed" },
  { key: "refunds", label: "Refunds" },
  { key: "all", label: "All" },
];

// ---------------------------------------------------------------- view

export default function SellerOrders({ focusOrderId, onNavigate }: { focusOrderId?: string; onNavigate: (n: SellerNav) => void }) {
  const [tab, setTab] = useState("to_fulfill");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<SellerOrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
    if (focusOrderId) setSelectedId(focusOrderId);
  }, [focusOrderId]);

  useEffect(() => {
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
    setLoading(true);
    apiGetPaged<SellerOrderRow[]>(`/api/store/orders?status=${tab}&search=${encodeURIComponent(search)}&page=${page}&size=12`)
      .then(({ rows: r, meta }) => {
        if (!alive) return;
        setRows(r);
        setTotal(meta?.total ?? r.length);
      })
      .catch(() => alive && setRows([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [tab, search, page, tick]);

  if (selectedId) {
    return (
      <OrderDetailView
        orderId={selectedId}
        onBack={() => {
          setSelectedId(null);
          setTick((t) => t + 1);
          onNavigate({ view: "orders" });
        }}
      />
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / 12));

  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={(v) => { setTab(v); setPage(1); }}>
        <TabsList className="flex w-full flex-wrap justify-start gap-1 sm:w-auto">
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key} className="min-h-[36px]">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search order number, customer, email…"
          className="pl-8 sm:max-w-sm"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />
      </div>

      {loading ? (
        <RowsSkeleton rows={5} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<ClipboardList className="h-8 w-8" />} title="No orders here" hint="Orders appear as shoppers check out on your storefront." />
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Items</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Paid</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((o) => (
                <TableRow key={o.id} className="cursor-pointer" onClick={() => setSelectedId(o.id)}>
                  <TableCell>
                    <p className="font-medium">{o.orderNumber}</p>
                    <p className="text-xs text-muted-foreground">{ageOf(o.createdAt)}</p>
                  </TableCell>
                  <TableCell>
                    <p className="max-w-40 truncate">{o.customerName}</p>
                    <p className="max-w-40 truncate text-xs text-muted-foreground">{o.customerEmail}</p>
                  </TableCell>
                  <TableCell>
                    <StatusChip status={o.status} />
                    {o.trackingNumber ? (
                      <span
                        className="mt-1 inline-flex max-w-36 items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                        title={`Courier tracking: ${o.trackingNumber}`}
                      >
                        <Truck className="h-3 w-3 shrink-0" />
                        <span className="truncate font-mono">{o.trackingNumber}</span>
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{o.itemCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMinor(o.totalMinor)}</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">{o.paidAt ? fmtDateTime(o.paidAt) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {rows.length > 0 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{total} order{total === 1 ? "" : "s"} · page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- detail

function OrderDetailView({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const { data: order, loading, error, refetch } = useApi<OrderDetail>(`/api/store/orders/${orderId}`);
  // ADDENDUM #8 — live hold window for the money-panel note (was "7 days").
  const { terms } = useSellerTerms();
  const [shipOpen, setShipOpen] = useState(false);
  const [deliverOpen, setDeliverOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [shipmentTick, setShipmentTick] = useState(0);

  // Refetch the order AND the shipment brief (quote endpoint) after a mutation.
  const refreshAll = () => {
    refetch();
    setShipmentTick((t) => t + 1);
  };

  if (loading) return <RowsSkeleton rows={6} />;
  if (error || !order) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" onClick={onBack} className="gap-1.5"><ArrowLeft className="h-4 w-4" /> Back to orders</Button>
        <Card><CardContent className="p-6 text-sm text-rose-600">Could not load order{error ? `: ${error}` : ""}</CardContent></Card>
      </div>
    );
  }

  const commission = order.items.reduce((s, i) => s + i.commissionMinor, 0);
  const net = order.totalMinor - commission;
  const canFulfill = order.status === "paid" || order.status === "processing";
  const canShip = order.status === "paid" || order.status === "processing";
  const canDeliver = order.status === "shipped";
  const canRefund = ["paid", "processing", "shipped", "delivered", "received", "completed"].includes(order.status);

  const fulfill = async () => {
    const ok = await runMutation(() => apiSend<FulfillData>("POST", `/api/store/orders/${order.id}/fulfill`), `Order ${order.orderNumber} marked fulfilled`);
    if (ok) refreshAll();
  };

  return (
    <div className="space-y-4">
      {/* print-only packing slip */}
      <PackingSlip order={order} />

      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Button variant="ghost" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="h-4 w-4" /> Orders
        </Button>
        <h2 className="text-lg font-semibold">{order.orderNumber}</h2>
        <StatusChip status={order.status} />
        <span className="text-xs text-muted-foreground">
          {order.channel} · created {fmtDateTime(order.createdAt)}
        </span>
        <Button variant="outline" size="sm" className="ml-auto gap-1.5" onClick={() => window.print()}>
          <Printer className="h-3.5 w-3.5" /> Print packing slip
        </Button>
      </div>

      {/* actions */}
      <div className="flex flex-wrap gap-2 print:hidden">
        {canFulfill ? (
          <Button onClick={fulfill} className="gap-2 min-h-[44px]">
            <PackageCheck className="h-4 w-4" /> Mark fulfilled
          </Button>
        ) : null}
        {canShip ? (
          <Button variant="outline" onClick={() => setShipOpen(true)} className="gap-2 min-h-[44px]">
            <Truck className="h-4 w-4" /> Ship order…
          </Button>
        ) : null}
        {canDeliver ? (
          <Button
            onClick={() => setDeliverOpen(true)}
            className="gap-2 min-h-[44px] bg-brand-gradient-deep text-white hover:opacity-90"
          >
            <PackageCheck className="h-4 w-4" /> Mark delivered
          </Button>
        ) : null}
        {canRefund ? (
          <Button variant="outline" onClick={() => setRefundOpen(true)} className="gap-2 min-h-[44px] text-rose-600">
            <Undo2 className="h-4 w-4" /> Request refund
          </Button>
        ) : null}
        {order.trackingNumber ? (
          <span className="flex items-center gap-1.5 rounded-lg border bg-muted/40 px-3 text-xs text-muted-foreground">
            <Truck className="h-3.5 w-3.5" /> {order.trackingProvider}: {order.trackingNumber}
          </span>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* items */}
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-sm">Items</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Unit</TableHead>
                  <TableHead className="text-right">Line total</TableHead>
                  <TableHead className="text-right">Commission</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.items.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>
                      <p className="font-medium">{i.title}</p>
                      {i.variantLabel ? <p className="text-xs text-muted-foreground">{i.variantLabel}</p> : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{i.qty}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMinor(i.unitPriceMinor)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMinor(i.lineSubtotalMinor - i.discountMinor)}</TableCell>
                    <TableCell className="text-right tabular-nums text-amber-600">{formatMinor(i.commissionMinor)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {order.customerNote ? (
              <Alert className="mt-3">
                <AlertDescription className="text-xs">Customer note: {order.customerNote}</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
        </Card>

        {/* money panel */}
        <Card className="print:hidden">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm"><CircleDollarSign className="h-4 w-4 text-primary" /> Money</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            <MoneyRow label="Subtotal" value={order.subtotalMinor} />
            {order.discountMinor > 0 ? <MoneyRow label={`Discount${order.couponCode ? ` (${order.couponCode})` : ""}`} value={-order.discountMinor} /> : null}
            {order.shippingMinor > 0 ? <MoneyRow label="Shipping" value={order.shippingMinor} /> : null}
            <Separator className="my-2" />
            <MoneyRow label="Order total" value={order.totalMinor} strong />
            <MoneyRow label="Platform commission" value={commission} tone="amber" />
            <MoneyRow label="Net to you" value={net} tone="green" strong />
            <Separator className="my-2" />
            <p className="text-xs text-muted-foreground">
              Paid via {order.paymentProvider ?? "—"}{order.latestPaymentRef ? ` · ref ${order.latestPaymentRef}` : ""}. Your net is
              held for {terms ? holdAfterPayment(terms) : "the clearing hold"} before it becomes available in your wallet.
            </p>
          </CardContent>
        </Card>

        {/* customer + address */}
        <Card className="print:hidden">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm"><MapPin className="h-4 w-4 text-primary" /> Customer & shipping</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p className="font-medium">{order.customerName}</p>
            <p className="text-muted-foreground">{order.customerEmail}</p>
            {order.customerPhone ? <p className="text-muted-foreground">{order.customerPhone}</p> : null}
            <Separator className="my-2" />
            <address className="not-italic leading-relaxed text-muted-foreground">
              {order.shippingAddress.line1 ? <span className="block">{order.shippingAddress.line1}</span> : null}
              {order.shippingAddress.line2 ? <span className="block">{order.shippingAddress.line2}</span> : null}
              <span className="block">
                {[order.shippingAddress.postcode, order.shippingAddress.city].filter(Boolean).join(" ")}
              </span>
              <span className="block">{[order.shippingAddress.state, order.shippingAddress.country || "Malaysia"].filter(Boolean).join(", ")}</span>
            </address>
          </CardContent>
        </Card>

        {/* shipment (platform booking brief or manual tracking) */}
        <ShipmentPanel
          orderId={order.id}
          trackingNumber={order.trackingNumber}
          trackingProvider={order.trackingProvider}
          deliveredAt={order.deliveredAt}
          refreshKey={shipmentTick}
        />

        {/* timeline */}
        <Card className="print:hidden">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm"><RotateCcw className="h-4 w-4 text-primary" /> Status timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="relative space-y-4 border-l pl-5">
              {order.history.map((h) => (
                <li key={h.id} className="relative">
                  <span className="absolute -left-[26px] top-1 h-3 w-3 rounded-full border-2 border-background bg-primary" aria-hidden />
                  <p className="text-sm font-medium capitalize">{h.toStatus.replace(/_/g, " ")}</p>
                  <p className="text-xs text-muted-foreground">{fmtDateTime(h.createdAt)} · by {h.actor}</p>
                  {h.note ? <p className="mt-0.5 text-xs text-muted-foreground">{h.note}</p> : null}
                </li>
              ))}
            </ol>
            {order.refunds.length > 0 ? (
              <>
                <Separator className="my-3" />
                <p className="text-sm font-medium">Refunds</p>
                <ul className="mt-1.5 space-y-1.5 text-xs">
                  {order.refunds.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-2">
                      <span>{formatMinor(r.amountMinor)} · {r.reason ?? "no reason"}</span>
                      <StatusChip status={r.status} />
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <ShipOrderDialog open={shipOpen} onOpenChange={setShipOpen} order={order} onDone={refreshAll} />
      <DeliverDialog open={deliverOpen} onOpenChange={setDeliverOpen} order={order} onDone={refreshAll} />
      <RefundDialog open={refundOpen} onOpenChange={setRefundOpen} order={order} onDone={refreshAll} />
    </div>
  );
}

function MoneyRow({ label, value, tone, strong }: { label: string; value: number; tone?: "amber" | "green"; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className={strong ? "font-medium" : "text-muted-foreground"}>{label}</span>
      <span
        className={
          "tabular-nums " +
          (tone === "amber" ? "text-amber-600" : tone === "green" ? "text-emerald-600" : "") +
          (strong ? " font-semibold" : "")
        }
      >
        {value < 0 ? `−${formatMinor(-value)}` : formatMinor(value)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- refund dialog

function RefundDialog({ open, onOpenChange, order, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; order: OrderDetail; onDone: () => void }) {
  const refunded = order.refunds.filter((r) => r.status !== "rejected").reduce((s, r) => s + r.amountMinor, 0);
  const refundable = Math.max(0, order.totalMinor - refunded);
  const [amount, setAmount] = useState<number>(refundable);
  const [reason, setReason] = useState("");
  const [restock, setRestock] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data-fetch reset
      setAmount(Math.max(0, order.totalMinor - order.refunds.filter((r) => r.status !== "rejected").reduce((s, r) => s + r.amountMinor, 0)));
      setReason("");
      setRestock(true);
    }
  }, [open, order]);

  const submit = async () => {
    if (amount <= 0 || amount > refundable) {
      toast.error(`Amount must be between RM 0 and ${formatMinor(refundable)}`);
      return;
    }
    setBusy(true);
    const ok = await runMutation(
      () => apiSend<RefundRequestData>("POST", `/api/store/orders/${order.id}/refund-request`, { amountMinor: amount, reason: reason || null, restock }),
      "Refund requested — an admin will review it"
    );
    setBusy(false);
    if (ok) {
      onOpenChange(false);
      onDone();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Request refund — {order.orderNumber}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3.5">
          <div className="space-y-1.5">
            <Label>Amount (RM)</Label>
            <MoneyInput valueMinor={amount} onChangeMinor={setAmount} />
            <p className="text-xs text-muted-foreground">Refundable balance: {formatMinor(refundable)}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="refund-reason">Reason</Label>
            <Textarea id="refund-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Damaged in transit, item out of stock…" />
          </div>
          <div className="flex items-center justify-between rounded-xl border p-3">
            <div>
              <p className="text-sm font-medium">Restock items</p>
              <p className="text-xs text-muted-foreground">Return the items to inventory when the refund is processed.</p>
            </div>
            <Switch checked={restock} onCheckedChange={setRestock} aria-label="Restock items" />
          </div>
          <p className="text-xs text-muted-foreground">Requests are reviewed by NOMOFEE admins; the ledger reversal happens on approval.</p>
          <Button onClick={submit} disabled={busy} className="w-full min-h-[44px] gap-2">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Submit request
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- packing slip

function PackingSlip({ order }: { order: OrderDetail }) {
  return (
    <div className="hidden print:block print:mb-6" aria-hidden>
      <div className="flex items-start justify-between border-b pb-3">
        <div>
          <p className="text-xl font-bold">PACKING SLIP</p>
          <p className="text-sm">{order.orderNumber} · {fmtDateTime(order.createdAt)}</p>
        </div>
        <p className="text-sm font-semibold">NOMOFEE fulfillment</p>
      </div>
      <div className="mt-3 text-sm">
        <p className="font-semibold">Ship to</p>
        <p>{order.customerName}</p>
        <p>{order.shippingAddress.line1}</p>
        <p>{[order.shippingAddress.postcode, order.shippingAddress.city].filter(Boolean).join(" ")}</p>
        <p>{[order.shippingAddress.state, order.shippingAddress.country || "Malaysia"].filter(Boolean).join(", ")}</p>
        <p>{order.customerPhone ?? ""}</p>
      </div>
      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="py-1">Item</th>
            <th className="py-1 text-right">Qty</th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((i) => (
            <tr key={i.id} className="border-b">
              <td className="py-1">{i.title}{i.variantLabel ? ` — ${i.variantLabel}` : ""}</td>
              <td className="py-1 text-right">{i.qty}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs">Thank you for shopping with us! · Total items: {order.items.reduce((s, i) => s + i.qty, 0)}</p>
    </div>
  );
}
