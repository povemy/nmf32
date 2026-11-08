"use client";
// ORD-01 All Orders list + ORD-03 Refunds queue + ORD-04 Disputes.
import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { apiSend, useApi } from "./use-api";
import { qs } from "./nav";
import type { AdminNav } from "./nav";
import type {
  AdminDisputePatchBody,
  AdminDisputeRow,
  AdminDisputesData,
  AdminOrdersData,
  AdminRefundProcessData,
  AdminRefundRejectBody,
  AdminRefundRow,
  AdminRefundsData,
  AdminStoresData,
} from "@/lib/types/api-contract";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Money,
  PageHeader,
  Pager,
  ReasonDialog,
  StatusChip,
  TableSkeleton,
  fmtDT,
  timeAgo,
} from "./ui-bits";

const ORDER_STATUSES = [
  "payment_pending", "paid", "processing", "shipped", "delivered", "received", "completed",
  "cancelled", "refunding", "partially_refunded", "refunded", "closed",
];

/* ---------------------------------------------------------------- ORD-01 */

/** Orders-table row — the contract list element (AdminOrdersData) plus the
 *  legacy `storeName` fallback the table reads. */
type OrderListRow = AdminOrdersData & { storeName?: string | null };

export function OrdersView({ nav }: { nav: AdminNav }) {
  const [status, setStatus] = useState("all");
  const [storeId, setStoreId] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const stores = useApi<AdminStoresData[]>("/api/admin/stores");

  const url = useMemo(
    () => `/api/admin/orders${qs({ status: status === "all" ? "" : status, storeId: storeId === "all" ? "" : storeId, search, page, size: 20 })}`,
    [status, storeId, search, page]
  );
  const { data, meta, error, loading, refetch } = useApi<OrderListRow[]>(url);
  const rows = data ?? [];

  const activeFilters = status !== "all" || storeId !== "all" || search !== "";

  return (
    <div className="space-y-4">
      <PageHeader title="All Orders" description="Every order across storefronts and the marketplace." />

      <Card className="py-0">
        <CardContent className="p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <form
              className="relative flex-1"
              onSubmit={(e) => {
                e.preventDefault();
                setPage(1);
                setSearch(searchInput.trim());
              }}
            >
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search order number or customer…"
                className="min-h-[44px] pl-9"
                aria-label="Search orders"
              />
            </form>
            <div className="flex gap-2">
              <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
                <SelectTrigger className="min-h-[44px] w-full lg:w-44" aria-label="Order status filter"><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {ORDER_STATUSES.map((s) => (
                    <SelectItem key={s} value={s} className="capitalize">{s.replace(/_/g, " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={storeId} onValueChange={(v) => { setStoreId(v); setPage(1); }}>
                <SelectTrigger className="min-h-[44px] w-full lg:w-48" aria-label="Store filter"><SelectValue placeholder="Store" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All stores</SelectItem>
                  {(stores.data ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {activeFilters ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="min-h-[44px] w-11 sm:min-h-0"
                  aria-label="Clear filters"
                  onClick={() => { setStatus("all"); setStoreId("all"); setSearch(""); setSearchInput(""); setPage(1); }}
                >
                  <X className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
          </div>

          <div className="mt-4 overflow-x-auto">
            {error ? (
              <ErrorState message={error} onRetry={() => void refetch()} />
            ) : loading ? (
              <TableSkeleton rows={8} cols={7} />
            ) : rows.length === 0 ? (
              <EmptyState title="No orders match" hint="Adjust the filters above." />
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order</TableHead>
                      <TableHead className="hidden md:table-cell">Store</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">Commission</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden lg:table-cell">Paid at</TableHead>
                      <TableHead className="text-right">Age</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((o) => (
                      <TableRow key={o.id} className="cursor-pointer" onClick={() => nav.navigate("order-detail", { orderId: o.id })}>
                        <TableCell className="font-mono text-xs font-semibold">{o.orderNumber}</TableCell>
                        <TableCell className="hidden max-w-[160px] truncate md:table-cell">{o.store?.name ?? o.storeName ?? "—"}</TableCell>
                        <TableCell>
                          <p className="max-w-[160px] truncate font-medium">{o.customerName}</p>
                          <p className="max-w-[160px] truncate text-xs text-muted-foreground">{o.customerEmail}</p>
                        </TableCell>
                        <TableCell className="text-right"><Money minor={o.totalMinor} /></TableCell>
                        <TableCell className="hidden text-right sm:table-cell">
                          {o.commissionMinor != null ? <Money minor={o.commissionMinor} muted /> : <span className="text-xs text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell><StatusChip status={o.status} /></TableCell>
                        <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">{o.paidAt ? fmtDT(o.paidAt) : "—"}</TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">{timeAgo(o.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="px-1 pb-1">
                  <Pager page={meta?.page ?? page} size={meta?.size ?? 20} total={meta?.total ?? rows.length} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} />
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------- ORD-03 */

export function RefundsView({ nav }: { nav: AdminNav }) {
  const [status, setStatus] = useState("all");
  const url = useMemo(() => `/api/admin/refunds${qs({ status: status === "all" ? "" : status })}`, [status]);
  const { data, error, loading, refetch } = useApi<AdminRefundsData[]>(url);
  const rows = data ?? [];

  const [busy, setBusy] = useState<string | null>(null);
  const [processTarget, setProcessTarget] = useState<AdminRefundsData | null>(null);
  const [rejectTarget, setRejectTarget] = useState<AdminRefundsData | null>(null);

  const approve = async (r: AdminRefundsData): Promise<boolean> => {
    try {
      await apiSend<AdminRefundRow>(`/api/admin/refunds/${r.id}/approve`, "POST");
      return true;
    } catch (e) {
      toast.error("Approve failed", { description: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };

  const quickApprove = async (r: AdminRefundsData) => {
    setBusy(r.id);
    const ok = await approve(r);
    setBusy(null);
    if (ok) {
      toast.success("Refund approved", { description: "Ready to process (posts ledger refund)." });
      void refetch();
    }
  };

  const process = async (r: AdminRefundsData) => {
    setBusy(r.id);
    try {
      if (r.status === "requested") {
        const ok = await approve(r);
        if (!ok) return;
      }
      await apiSend<AdminRefundProcessData>(`/api/admin/refunds/${r.id}/process`, "POST");
      toast.success("Refund processed", { description: "Ledger T5 posted and wallet adjusted." });
      setProcessTarget(null);
      void refetch();
    } catch (e) {
      toast.error("Process failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const reject = async (r: AdminRefundsData, reason: string) => {
    setBusy(r.id);
    try {
      await apiSend<AdminRefundRow>(`/api/admin/refunds/${r.id}/reject`, "POST", { reason } satisfies AdminRefundRejectBody);
      toast.success("Refund rejected");
      setRejectTarget(null);
      void refetch();
    } catch (e) {
      toast.error("Reject failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Refunds"
        description="Approve, then process — processing posts the ledger refund and reverses commission."
        actions={
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="min-h-[44px] w-44" aria-label="Refund status filter"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="requested">requested</SelectItem>
              <SelectItem value="approved">approved</SelectItem>
              <SelectItem value="processed">processed</SelectItem>
              <SelectItem value="rejected">rejected</SelectItem>
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
              <TableSkeleton rows={6} cols={6} />
            ) : rows.length === 0 ? (
              <EmptyState title="No refunds here" hint="Seller refund requests will queue up in this view." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="hidden md:table-cell">Reason</TableHead>
                    <TableHead>Requested by</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden lg:table-cell">Created</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <button
                          className="font-mono text-xs font-semibold text-teal-700 underline-offset-2 hover:underline dark:text-teal-400"
                          onClick={() => r.order?.id && nav.navigate("order-detail", { orderId: r.order.id })}
                        >
                          {r.order?.orderNumber ?? "view order"}
                        </button>
                      </TableCell>
                      <TableCell className="text-right"><Money minor={r.amountMinor} bold /></TableCell>
                      <TableCell className="hidden max-w-[220px] truncate text-sm md:table-cell">{r.reason ?? "—"}</TableCell>
                      <TableCell className="text-sm capitalize">{r.requestedBy}</TableCell>
                      <TableCell><StatusChip status={r.status} /></TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">{timeAgo(r.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1.5">
                          {r.status === "requested" ? (
                            <>
                              <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" disabled={busy !== null} onClick={() => setRejectTarget(r)}>
                                Reject
                              </Button>
                              <Button size="sm" variant="outline" className="min-h-[44px] bg-emerald-600 text-white hover:bg-emerald-700 sm:min-h-0" disabled={busy !== null} onClick={() => void quickApprove(r)}>
                                Approve
                              </Button>
                            </>
                          ) : null}
                          {r.status === "requested" || r.status === "approved" ? (
                            <Button size="sm" className="min-h-[44px] sm:min-h-0" disabled={busy !== null} onClick={() => setProcessTarget(r)}>
                              Process
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">{r.processedAt ? timeAgo(r.processedAt) : "—"}</span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={processTarget !== null}
        onOpenChange={(o) => !o && setProcessTarget(null)}
        title="Process refund?"
        description={
          processTarget
            ? `Posts ledger refund for ${processTarget.order?.orderNumber ?? "this order"}, reverses commission and adjusts the seller wallet${processTarget.restock === false ? ". No restock" : "; variants are restocked"}.`
            : ""
        }
        confirmLabel="Process refund"
        loading={busy !== null}
        onConfirm={() => processTarget && void process(processTarget)}
      />

      <ReasonDialog
        open={rejectTarget !== null}
        onOpenChange={(o) => !o && setRejectTarget(null)}
        title="Reject refund"
        description="The seller/shopper will be notified with the reason."
        submitLabel="Reject refund"
        destructive
        loading={busy !== null}
        onSubmit={(reason) => rejectTarget && void reject(rejectTarget, reason)}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- ORD-04 */

export function DisputesView({ nav }: { nav: AdminNav }) {
  const { data, error, loading, refetch } = useApi<AdminDisputesData[]>("/api/admin/disputes");
  const rows = data ?? [];
  const [detail, setDetail] = useState<AdminDisputesData | null>(null);
  const [nextStatus, setNextStatus] = useState("under_review");
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (detail) {
      setNextStatus(detail.status === "open" ? "under_review" : detail.status);
      setResolution(detail.resolution ?? "");
    }
  }, [detail]);

  const patch = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await apiSend<AdminDisputeRow>(`/api/admin/disputes/${detail.id}`, "PATCH", {
        status: nextStatus as AdminDisputePatchBody["status"],
        resolution: nextStatus === "resolved" || nextStatus === "rejected" ? resolution.trim() : undefined,
      } satisfies AdminDisputePatchBody);
      toast.success(`Dispute ${nextStatus.replace(/_/g, " ")}`);
      setDetail(null);
      void refetch();
    } catch (e) {
      toast.error("Update failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Disputes" description="Buyer disputes raised on orders across the platform." />

      <Card className="py-0">
        <CardContent className="p-4">
          <div className="overflow-x-auto">
            {error ? (
              <ErrorState message={error} onRetry={() => void refetch()} />
            ) : loading ? (
              <TableSkeleton rows={5} cols={5} />
            ) : rows.length === 0 ? (
              <EmptyState title="No disputes" hint="You are all caught up." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead className="hidden md:table-cell">Reason</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden sm:table-cell">Opened by</TableHead>
                    <TableHead className="hidden lg:table-cell">Created</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell>
                        <button
                          className="font-mono text-xs font-semibold text-teal-700 underline-offset-2 hover:underline dark:text-teal-400"
                          onClick={() => d.order?.id && nav.navigate("order-detail", { orderId: d.order.id })}
                        >
                          {d.order?.orderNumber ?? "—"}
                        </button>
                      </TableCell>
                      <TableCell className="hidden max-w-[260px] truncate text-sm md:table-cell">{d.reason}</TableCell>
                      <TableCell><StatusChip status={d.status} /></TableCell>
                      <TableCell className="hidden text-sm capitalize sm:table-cell">{d.openedBy}</TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">{fmtDT(d.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" onClick={() => setDetail(d)}>
                          Review
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

      <Dialog open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Dispute — {detail?.order?.orderNumber ?? "order"}</DialogTitle>
            <DialogDescription>
              {detail ? `Opened by ${detail.openedBy} · ${fmtDT(detail.createdAt)}` : ""}
            </DialogDescription>
          </DialogHeader>
          {detail ? (
            <div className="space-y-4">
              <div className="rounded-lg border p-3 text-sm">
                <p className="text-xs text-muted-foreground">Order</p>
                <button className="font-mono text-xs font-semibold text-teal-700 hover:underline dark:text-teal-400" onClick={() => { const id = detail.order?.id; setDetail(null); if (id) nav.navigate("order-detail", { orderId: id }); }}>
                  {detail.order?.orderNumber ?? "—"} · <Money minor={detail.order?.totalMinor} />
                </button>
                <p className="mt-1 text-sm">{detail.order?.customerName ?? ""}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Reason</p>
                <p className="mt-1 rounded-lg border bg-muted/40 p-3 text-sm">{detail.reason}</p>
              </div>
              {detail.resolution ? (
                <div>
                  <p className="text-xs text-muted-foreground">Current resolution note</p>
                  <p className="mt-1 text-sm">{detail.resolution}</p>
                </div>
              ) : null}
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Set status</p>
                <Select value={nextStatus} onValueChange={setNextStatus}>
                  <SelectTrigger className="min-h-[44px]" aria-label="Dispute status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="under_review">under review</SelectItem>
                    <SelectItem value="resolved">resolved</SelectItem>
                    <SelectItem value="rejected">rejected</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {(nextStatus === "resolved" || nextStatus === "rejected") ? (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">Resolution note</p>
                  <Textarea value={resolution} onChange={(e) => setResolution(e.target.value)} rows={3} placeholder="Outcome shared with buyer and seller…" className="resize-none" />
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetail(null)} className="min-h-[44px] sm:min-h-0">Close</Button>
            <Button onClick={() => void patch()} disabled={busy} className="min-h-[44px] sm:min-h-0">
              {busy ? "Saving…" : "Update dispute"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
