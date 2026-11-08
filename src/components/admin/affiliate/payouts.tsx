"use client";
// AFF-04 — Affiliate Payouts: the manual payout state machine queue
// (requested → approve → processing → mark-paid | fail; requested → reject).
// NO automated bank transfer exists — finance executes the transfer
// externally, then records the reference. Data:
// GET /api/admin/affiliate/payouts + POST …/payouts/[id]/process
// (cap: affiliate.finance).
import { Fragment, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  BadgeCheck,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Landmark,
  Wallet,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/utils";
import { apiSend, parseJsonSafe, useApi } from "../use-api";
import {
  EmptyState,
  ErrorState,
  Money,
  PageHeader,
  Pager,
  ReasonDialog,
  TableSkeleton,
  TONE_CLASS,
  fmtDT,
  statusTone,
  timeAgo,
} from "../ui-bits";
import type { PayoutStatement } from "./types";
import type {
  AdminAffProcessBody,
  AdminAffProcessData,
  AdminAffPayoutRow,
  AdminAffPayoutsData,
} from "@/lib/types/api-contract";

const PAYOUT_TABS = ["all", "requested", "processing", "paid", "failed", "rejected"] as const;

/** FIN-3b wording parity with the seller payout views. */
const PAYOUT_STATUS_LABELS: Record<string, string> = {
  requested: "Awaiting approval",
  processing: "Processing",
  paid: "Paid",
  failed: "Failed",
  rejected: "Rejected",
};

function PayoutStatusChip({ status, className }: { status: string; className?: string }) {
  const s = (status ?? "").toLowerCase();
  return (
    <Badge variant="outline" className={cn(TONE_CLASS[statusTone(s)], className)}>
      {PAYOUT_STATUS_LABELS[s] ?? s.replace(/_/g, " ")}
    </Badge>
  );
}

export function AffiliatePayoutsView() {
  const [status, setStatus] = useState<(typeof PAYOUT_TABS)[number]>("all");
  const [page, setPage] = useState(1);

  const url = useMemo(() => {
    const sp = new URLSearchParams({ page: String(page), size: "20" });
    if (status !== "all") sp.set("status", status);
    return `/api/admin/affiliate/payouts?${sp.toString()}`;
  }, [status, page]);

  const { data, error, loading, refetch } = useApi<AdminAffPayoutsData>(url);
  const rows = useMemo(() => data?.payouts ?? [], [data]);
  const total = data?.total ?? 0;
  const serverPage = data?.page ?? page;

  // Queue badges are global (the groupBy runs without the status filter).
  const queueCount = useMemo(() => {
    const map = new Map<string, { count: number; amountMinor: number }>();
    for (const q of data?.queue ?? []) map.set(q.status, { count: q.count, amountMinor: q.amountMinor });
    return map;
  }, [data]);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [markPaidTarget, setMarkPaidTarget] = useState<AdminAffPayoutRow | null>(null);
  const [failTarget, setFailTarget] = useState<AdminAffPayoutRow | null>(null);
  const [rejectTarget, setRejectTarget] = useState<AdminAffPayoutRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const process = async (
    row: AdminAffPayoutRow,
    action: "approve" | "mark-paid" | "fail" | "reject",
    extra?: { reference?: string; reason?: string }
  ): Promise<boolean> => {
    setBusyId(row.id);
    try {
      const body: AdminAffProcessBody = { action, ...extra };
      await apiSend<AdminAffProcessData>(`/api/admin/affiliate/payouts/${encodeURIComponent(row.id)}/process`, "POST", body);
      void refetch();
      return true;
    } catch (e) {
      toast.error(`Payout ${action} failed`, { description: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const approve = async (row: AdminAffPayoutRow) => {
    const ok = await process(row, "approve");
    if (ok) {
      toast.success(`${row.affiliate.displayName} payout approved`, {
        description: `${formatMinor(row.amountMinor)} moved to processing (T-A3). Execute the bank transfer externally, then record the transfer reference with “Mark paid”.`,
      });
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Affiliate Payouts"
        description="Manual bank transfer workflow — approve requests, execute the transfer externally, then record the reference. Payouts are never sent automatically."
      />

      <Card className="py-0">
        <CardContent className="p-4">
          {/* status tabs */}
          <Tabs
            value={status}
            onValueChange={(v) => {
              setStatus(v as (typeof PAYOUT_TABS)[number]);
              setPage(1);
              setExpanded(null);
            }}
          >
            <TabsList className="h-auto flex-wrap">
              {PAYOUT_TABS.map((t) => {
                const q = t === "all" ? null : queueCount.get(t);
                const count = t === "all" ? [...queueCount.values()].reduce((s, v) => s + v.count, 0) : (q?.count ?? 0);
                return (
                  <TabsTrigger key={t} value={t} className="gap-1.5 capitalize">
                    {t === "all" ? "All" : (PAYOUT_STATUS_LABELS[t] ?? t)}
                    {count > 0 ? (
                      <Badge
                        variant="outline"
                        className={cn(
                          "px-1 py-0 text-[10px]",
                          (t === "requested" || t === "processing") && "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300"
                        )}
                      >
                        {count}
                      </Badge>
                    ) : null}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>

          {/* table */}
          <div className="mt-4 overflow-x-auto">
            {error ? (
              <ErrorState message={error} onRetry={() => void refetch()} />
            ) : loading ? (
              <TableSkeleton rows={6} cols={7} />
            ) : rows.length === 0 ? (
              <EmptyState
                title={status === "all" ? "No affiliate payouts yet" : `No ${PAYOUT_STATUS_LABELS[status]?.toLowerCase() ?? status} payouts`}
                hint="Affiliates request payouts from their hub once their requestable balance clears the minimum."
              />
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8" />
                      <TableHead>Affiliate</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="hidden md:table-cell">Requested</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden lg:table-cell">Reference</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((p) => (
                      <Fragment key={p.id}>
                        <TableRow
                          className={cn("cursor-pointer", busyId === p.id && "opacity-60")}
                          onClick={() => setExpanded(expanded === p.id ? null : p.id)}
                        >
                          <TableCell>{expanded === p.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                          <TableCell>
                            <p className="font-medium">{p.affiliate.displayName}</p>
                            <p className="truncate text-xs text-muted-foreground">{p.affiliate.email}</p>
                          </TableCell>
                          <TableCell className="text-right">
                            <Money minor={p.amountMinor} bold />
                          </TableCell>
                          <TableCell className="hidden text-xs text-muted-foreground md:table-cell" title={fmtDT(p.requestedAt)}>
                            {timeAgo(p.requestedAt)}
                          </TableCell>
                          <TableCell>
                            <PayoutStatusChip status={p.status} />
                            {p.failReason ? (
                              <p className="mt-1 max-w-44 truncate text-[11px] text-red-600 dark:text-red-400" title={p.failReason}>
                                {p.failReason}
                              </p>
                            ) : null}
                          </TableCell>
                          <TableCell className="hidden font-mono text-xs lg:table-cell">{p.reference ?? <span className="text-muted-foreground">—</span>}</TableCell>
                          <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="flex justify-end gap-1.5">
                              {p.status === "requested" ? (
                                <>
                                  <Button size="sm" className="h-8 min-h-[36px] gap-1" disabled={busyId === p.id} onClick={() => void approve(p)}>
                                    <Check className="h-3.5 w-3.5" /> Approve
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-8 min-h-[36px] gap-1 border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-900 dark:hover:bg-red-950/40"
                                    disabled={busyId === p.id}
                                    onClick={() => setRejectTarget(p)}
                                  >
                                    <X className="h-3.5 w-3.5" /> Reject
                                  </Button>
                                </>
                              ) : p.status === "processing" ? (
                                <>
                                  <Button
                                    size="sm"
                                    className="h-8 min-h-[36px] gap-1 bg-emerald-600 hover:bg-emerald-700"
                                    disabled={busyId === p.id}
                                    onClick={() => setMarkPaidTarget(p)}
                                  >
                                    <BadgeCheck className="h-3.5 w-3.5" /> Mark paid
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-8 min-h-[36px] gap-1 border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-900 dark:hover:bg-red-950/40"
                                    disabled={busyId === p.id}
                                    onClick={() => setFailTarget(p)}
                                  >
                                    <Ban className="h-3.5 w-3.5" /> Fail
                                  </Button>
                                </>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                        {expanded === p.id ? (
                          <TableRow>
                            <TableCell colSpan={7} className="bg-muted/30">
                              <PayoutExpand payout={p} />
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </Fragment>
                    ))}
                  </TableBody>
                </Table>
                <div className="px-1 pb-1">
                  <Pager
                    page={serverPage}
                    size={20}
                    total={total}
                    onPrev={() => setPage((p) => Math.max(1, p - 1))}
                    onNext={() => setPage((p) => p + 1)}
                  />
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* mark paid — reference required; manual bank transfer happens OFFLINE */}
      <MarkPaidDialog
        payout={markPaidTarget}
        busy={markPaidTarget ? busyId === markPaidTarget.id : false}
        onClose={() => setMarkPaidTarget(null)}
        onConfirm={(reference) => {
          const target = markPaidTarget;
          if (!target) return;
          void process(target, "mark-paid", { reference }).then((ok) => {
            if (ok) {
              toast.success("Payout marked paid", {
                description: `${formatMinor(target.amountMinor)} to ${target.affiliate.displayName} · reference ${reference} recorded (T-A4) — covered entries are now paid.`,
              });
              setMarkPaidTarget(null);
            }
          });
        }}
      />

      {/* fail — processing payout; ledger reversal releases claimed entries */}
      <ReasonDialog
        open={failTarget !== null}
        onOpenChange={(o) => !o && setFailTarget(null)}
        title="Mark payout as failed"
        description={
          failTarget
            ? `${failTarget.affiliate.displayName} · ${formatMinor(failTarget.amountMinor)} — the debit is reversed (T-A4f) and the claimed entries return to the available pool. Reason (min 5 characters) is recorded.`
            : ""
        }
        placeholder="e.g. Bank rejected the transfer — account closed"
        submitLabel="Mark failed"
        destructive
        loading={failTarget ? busyId === failTarget.id : false}
        onSubmit={(reason) => {
          if (!failTarget) return;
          if (reason.trim().length < 5) {
            toast.error("Reason too short", { description: "A reason (min 5 characters) is required to fail a payout." });
            return;
          }
          const target = failTarget;
          void process(target, "fail", { reason }).then((ok) => {
            if (ok) {
              toast.success("Payout marked failed", { description: "Ledger reversal posted; entries returned to available." });
              setFailTarget(null);
            }
          });
        }}
      />

      {/* reject — a requested payout never moved money */}
      <ReasonDialog
        open={rejectTarget !== null}
        onOpenChange={(o) => !o && setRejectTarget(null)}
        title="Reject payout request"
        description={
          rejectTarget
            ? `${rejectTarget.affiliate.displayName} · ${formatMinor(rejectTarget.amountMinor)} — no money has moved; the claimed entries are released back to available. Reason (min 5 characters) is recorded.`
            : ""
        }
        placeholder="e.g. Request falls outside the review window — resubmit after clearance"
        submitLabel="Reject request"
        destructive
        loading={rejectTarget ? busyId === rejectTarget.id : false}
        onSubmit={(reason) => {
          if (!rejectTarget) return;
          if (reason.trim().length < 5) {
            toast.error("Reason too short", { description: "A reason (min 5 characters) is required to reject a payout." });
            return;
          }
          const target = rejectTarget;
          void process(target, "reject", { reason }).then((ok) => {
            if (ok) {
              toast.success("Payout request rejected", { description: "No ledger movement — claimed entries released." });
              setRejectTarget(null);
            }
          });
        }}
      />
    </div>
  );
}

/* --------------------------------------------------------- mark paid */

function MarkPaidDialog({
  payout,
  busy,
  onClose,
  onConfirm,
}: {
  payout: AdminAffPayoutRow | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reference: string) => void;
}) {
  // Mount the inner form fresh per payout (same pattern as ui-bits ReasonDialog)
  // so the reference field starts empty without a setState-in-effect reset.
  return (
    <Dialog open={payout !== null} onOpenChange={(o) => !o && onClose()}>
      {payout ? <MarkPaidInner payout={payout} busy={busy} onClose={onClose} onConfirm={onConfirm} /> : null}
    </Dialog>
  );
}

function MarkPaidInner({
  payout,
  busy,
  onClose,
  onConfirm,
}: {
  payout: AdminAffPayoutRow;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reference: string) => void;
}) {
  const [reference, setReference] = useState("");
  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Mark payout as paid</DialogTitle>
        <DialogDescription>
          {`${payout.affiliate.displayName} · ${formatMinor(payout.amountMinor)}${payout.affiliate.payoutRef ? ` · payout ref ${payout.affiliate.payoutRef}` : ""}.`}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-1.5">
        <Label htmlFor="aff-payout-reference">Transfer reference (required)</Label>
        <Input
          id="aff-payout-reference"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="e.g. MB-20260214-77421"
          className="min-h-[44px] font-mono"
          autoFocus
          autoComplete="off"
        />
        <p className="text-[11px] text-muted-foreground">
          <Landmark className="mr-1 inline h-3 w-3" aria-hidden />
          Manual bank transfer — execute the transfer externally (online banking / PSP), then record the transfer
          reference here. No automated transfer is performed by NOMOFEE.
        </p>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy} className="min-h-[44px] sm:min-h-0">
          Cancel
        </Button>
        <Button
          onClick={() => onConfirm(reference.trim())}
          disabled={busy || !reference.trim()}
          className="min-h-[44px] bg-emerald-600 hover:bg-emerald-700 sm:min-h-0"
        >
          Confirm paid
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/* ------------------------------------------------------------ expand */

function PayoutExpand({ payout }: { payout: AdminAffPayoutRow }) {
  const st = payout.statementJson ? parseJsonSafe<PayoutStatement>(payout.statementJson, {}) : null;
  const entries = st?.entries ?? [];

  return (
    <div className="grid grid-cols-1 gap-4 p-3 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payout statement</p>
        {st && entries.length > 0 ? (
          <div className="overflow-hidden rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Entry</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Reversed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.entryId}>
                    <TableCell className="font-mono text-xs">{e.orderNumber ?? "—"}</TableCell>
                    <TableCell className="font-mono text-[10px] text-muted-foreground">{e.entryId.slice(0, 12)}…</TableCell>
                    <TableCell className="text-right">
                      <Money minor={e.amountMinor} />
                    </TableCell>
                    <TableCell className="text-right">
                      {e.reversedMinor > 0 ? <Money minor={-e.reversedMinor} /> : <span className="text-xs text-muted-foreground">—</span>}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="border-t-2">
                  <TableCell colSpan={2} className="text-sm font-semibold">
                    Net payout{st.builtAt ? ` (snapshot ${fmtDT(st.builtAt)})` : ""}
                  </TableCell>
                  <TableCell className="text-right">
                    <Money minor={payout.amountMinor} bold />
                  </TableCell>
                  <TableCell />
                </TableRow>
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No payout statement available for this payout.</p>
        )}
        {payout.note ? <p className="mt-2 rounded-lg border bg-card p-2.5 text-xs text-muted-foreground">{payout.note}</p> : null}
      </div>

      <div className="space-y-3 text-sm">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Affiliate</p>
          <div className="mt-1.5 space-y-0.5 rounded-lg border bg-card p-3 text-sm">
            <p className="font-medium">{payout.affiliate.fullName || payout.affiliate.displayName}</p>
            <p className="text-muted-foreground">{payout.affiliate.email}</p>
            <p className="font-mono text-xs">
              {payout.affiliate.code} · /{payout.affiliate.slug}
            </p>
            {payout.affiliate.payoutRef ? (
              <p className="font-mono text-xs">
                <Wallet className="mr-1 inline h-3 w-3" aria-hidden />
                {payout.affiliate.payoutRef}
              </p>
            ) : null}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Method</p>
            <p className="capitalize">{payout.method?.replace(/_/g, " ") ?? "—"}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Requested</p>
            <p className="text-xs">{fmtDT(payout.requestedAt)}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Processed</p>
            <p className="text-xs">{payout.processedAt ? fmtDT(payout.processedAt) : "—"}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Reference</p>
            <p className="font-mono text-xs">{payout.reference ?? "—"}</p>
          </div>
        </div>
        {payout.failReason ? (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Fail / reject reason</p>
            <p className="text-xs text-red-600 dark:text-red-400">{payout.failReason}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
