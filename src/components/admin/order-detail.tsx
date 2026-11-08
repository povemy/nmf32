"use client";
// ORD-02 Order Detail — money panel, items w/ commission trace, timeline, intents, refunds, dispute.
import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, Copy, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatMinor } from "@/lib/money";
import { parseJsonSafe, useApi } from "./use-api";
import type { AdminNav } from "./nav";
import type { AdminOrderDetailData } from "@/lib/types/api-contract";
import {
  BreakdownChips,
  CopyButton,
  EmptyState,
  ErrorState,
  Money,
  PageHeader,
  StatusChip,
  TableSkeleton,
  fmtDT,
} from "./ui-bits";

export function OrderDetailView({ nav, orderId }: { nav: AdminNav; orderId: string }) {
  const { data, error, loading, refetch } = useApi<AdminOrderDetailData>(`/api/admin/orders/${orderId}`);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (error) {
    return <Card className="py-0"><CardContent className="p-4"><ErrorState message={error} onRetry={() => void refetch()} /></CardContent></Card>;
  }
  if (loading || !data?.order) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-56 animate-pulse rounded bg-muted" />
        <Card className="py-0"><CardContent className="p-4"><TableSkeleton rows={5} cols={6} /></CardContent></Card>
      </div>
    );
  }

  const { order, items, history, paymentIntents, refunds, dispute } = data;
  const commission = items.reduce((s, i) => s + (i.commissionMinor ?? 0), 0);
  const sellerNet = items.reduce((s, i) => s + (i.sellerNetMinor ?? 0), 0);
  const address = parseJsonSafe<Record<string, string>>(order.shippingAddressJson, {});
  const addressLines = [
    [address.line1, address.line2].filter(Boolean).join(" "),
    [address.city, address.postcode].filter(Boolean).join(" "),
    [address.state, address.country].filter(Boolean).join(" "),
  ].filter(Boolean);

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" className="-ml-2 min-h-[44px] sm:min-h-0" onClick={() => nav.navigate("orders")}>
        ← All orders
      </Button>

      <PageHeader
        title={
          <span className="flex items-center gap-2 font-mono">
            {order.orderNumber}
            <CopyButton text={order.orderNumber} label="Copy order number" />
          </span>
        }
        description={`${order.store?.name ?? "Store"} · ${order.customerName} · placed ${fmtDT(order.createdAt)}`}
        actions={<StatusChip status={order.status} className="text-sm" />}
      />

      {order.disputedFlag || dispute ? (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          <Badge variant="outline" className="mt-0.5 border-red-300 bg-white text-red-700 dark:border-red-800 dark:bg-transparent dark:text-red-300">disputed</Badge>
          <div>
            <p className="font-medium">{dispute?.reason ?? "Dispute open on this order"}</p>
            {dispute?.resolution ? <p className="mt-0.5 text-xs">Resolution: {dispute.resolution}</p> : null}
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* left: money + items */}
        <div className="space-y-4 xl:col-span-2">
          <Card className="py-0">
            <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
              <CardTitle className="text-base">Money</CardTitle>
              <CardDescription>Read-only snapshot — commission was computed at checkout and never recomputed.</CardDescription>
            </CardHeader>
            <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                <MoneyRow label="Subtotal" minor={order.subtotalMinor} />
                <MoneyRow label="Discount" minor={-order.discountMinor} />
                <MoneyRow label="Shipping" minor={order.shippingMinor} />
                {order.taxMinor ? <MoneyRow label="Tax" minor={order.taxMinor} /> : null}
                <MoneyRow label="Total" minor={order.totalMinor} bold />
                <MoneyRow label="Commission" minor={commission} bold accent="teal" />
                <MoneyRow label="Seller net" minor={sellerNet} bold accent="emerald" />
              </dl>
              {order.couponCode ? (
                <p className="mt-2 text-xs text-muted-foreground">Coupon applied: <span className="font-mono font-medium">{order.couponCode}</span></p>
              ) : null}
            </CardContent>
          </Card>

          <Card className="py-0">
            <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
              <CardTitle className="text-base">Items ({items.length})</CardTitle>
              <CardDescription>Click a row to inspect its commission breakdown trace.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8" />
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">Unit</TableHead>
                      <TableHead className="text-right">Line total</TableHead>
                      <TableHead className="text-right">Commission</TableHead>
                      <TableHead className="hidden text-right md:table-cell">Seller net</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((it) => (
                      <Fragment key={it.id}>
                        <TableRow
                          className="cursor-pointer"
                          onClick={() => setExpanded(expanded === it.id ? null : it.id)}
                        >
                          <TableCell>
                            {expanded === it.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </TableCell>
                          <TableCell>
                            <p className="max-w-[240px] truncate font-medium">{it.title}</p>
                            {it.variantLabel ? <p className="text-xs text-muted-foreground">{it.variantLabel}</p> : null}
                            {it.refundedMinor > 0 ? (
                              <Badge variant="outline" className="mt-1 border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300">
                                refunded {formatMinor(it.refundedMinor)}
                              </Badge>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{it.qty}</TableCell>
                          <TableCell className="hidden text-right sm:table-cell"><Money minor={it.unitPriceMinor} /></TableCell>
                          <TableCell className="text-right"><Money minor={it.lineSubtotalMinor} /></TableCell>
                          <TableCell className="text-right">
                            <Money minor={it.commissionMinor} />
                            <p className="text-[11px] text-muted-foreground">{it.commissionPercent}%</p>
                          </TableCell>
                          <TableCell className="hidden text-right md:table-cell"><Money minor={it.sellerNetMinor} muted /></TableCell>
                        </TableRow>
                        {expanded === it.id ? (
                          <TableRow key={`${it.id}-x`}>
                            <TableCell colSpan={7} className="bg-muted/30">
                              <div className="grid grid-cols-1 gap-3 py-1 sm:grid-cols-3">
                                <div className="space-y-1 text-xs">
                                  <p className="font-semibold text-muted-foreground">Per-line money</p>
                                  <p>discount {formatMinor(it.discountMinor)} · shipping {formatMinor(it.shippingMinor)}</p>
                                  <p>fixed fee {formatMinor(it.fixedFeeMinor)}</p>
                                  <p>percent part {formatMinor(it.commissionMinor - it.fixedFeeMinor)}</p>
                                </div>
                                <div className="sm:col-span-2">
                                  <p className="text-xs font-semibold text-muted-foreground">Breakdown trace (breakdownJson)</p>
                                  <BreakdownChips json={it.breakdownJson} className="mt-1.5" />
                                </div>
                              </div>
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </Fragment>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card className="py-0">
            <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
              <CardTitle className="text-base">Refunds on this order</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {refunds.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground sm:px-6">No refunds requested.</p>
              ) : (
                <Table>
                  <TableBody>
                    {refunds.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell><Money minor={r.amountMinor} bold /></TableCell>
                        <TableCell className="hidden max-w-[280px] truncate text-sm sm:table-cell">{r.reason ?? "—"}</TableCell>
                        <TableCell><StatusChip status={r.status} /></TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">{fmtDT(r.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        {/* right: timeline + payments + shipping */}
        <div className="space-y-4">
          <Card className="py-0">
            <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
              <CardTitle className="text-base">Status timeline</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
              {history.length === 0 ? (
                <p className="text-sm text-muted-foreground">No transitions recorded.</p>
              ) : (
                <ol className="relative space-y-4 border-l border-border pl-4">
                  {[...history].reverse().map((h) => (
                    <li key={h.id} className="relative">
                      <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full bg-teal-500 ring-4 ring-teal-500/15" />
                      <p className="text-sm font-medium capitalize">
                        {h.fromStatus ? `${h.fromStatus.replace(/_/g, " ")} → ` : ""}
                        {h.toStatus.replace(/_/g, " ")}
                      </p>
                      <p className="text-xs text-muted-foreground">{fmtDT(h.createdAt)} · by {h.actor}</p>
                      {h.note ? <p className="mt-0.5 text-xs">{h.note}</p> : null}
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>

          <Card className="py-0">
            <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
              <CardTitle className="text-base">Payment intents</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 p-4 pt-0 sm:p-6 sm:pt-0">
              {paymentIntents.length === 0 ? (
                <p className="text-sm text-muted-foreground">None.</p>
              ) : (
                paymentIntents.map((pi) => (
                  <div key={pi.id} className="rounded-lg border p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium capitalize">{pi.provider.replace(/_/g, " ")}</span>
                      <StatusChip status={pi.status} />
                    </div>
                    <p className="mt-1 flex items-center gap-1 font-mono text-xs text-muted-foreground">
                      {pi.providerRef}
                      <CopyButton text={pi.providerRef} label="Copy provider ref" />
                    </p>
                    <p className="mt-0.5 text-xs"><Money minor={pi.amountMinor} /> · expires {fmtDT(pi.expiresAt)}</p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card className="py-0">
            <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
              <CardTitle className="text-base">Shipping & customer</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-0 text-sm sm:p-6 sm:pt-0">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Ship to</p>
                <p className="mt-0.5">{order.customerName}</p>
                {addressLines.length > 0 ? (
                  addressLines.map((l, i) => <p key={i} className="text-muted-foreground">{l}</p>)
                ) : (
                  <p className="text-muted-foreground">No address recorded</p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">{order.customerEmail}{order.customerPhone ? ` · ${order.customerPhone}` : ""}</p>
              </div>
              {order.trackingNumber ? (
                <div className="flex items-center gap-2">
                  <Truck className="h-4 w-4 text-teal-600" />
                  <span className="text-sm">{order.trackingProvider ?? "Courier"} · <span className="font-mono">{order.trackingNumber}</span></span>
                </div>
              ) : null}
              {order.customerNote ? (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Customer note</p>
                  <p className="mt-0.5 rounded-lg border bg-muted/40 p-2 text-sm">{order.customerNote}</p>
                </div>
              ) : null}
              <div className="flex items-center gap-2 border-t pt-2">
                <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-mono text-xs text-muted-foreground">{order.orderNumber}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function MoneyRow({
  label,
  minor,
  bold,
  accent,
}: {
  label: string;
  minor: number;
  bold?: boolean;
  accent?: "teal" | "emerald";
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-dashed border-border/60 pb-1.5 sm:block sm:border-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "tabular-nums",
          bold && "font-semibold text-base",
          accent === "teal" && "text-teal-700 dark:text-teal-400",
          accent === "emerald" && "text-emerald-700 dark:text-emerald-400"
        )}
      >
        {formatMinor(minor)}
      </dd>
    </div>
  );
}
