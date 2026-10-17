"use client";
// FIN-07 Payout Batches (run + preview + history) and Payout Batch Detail
// (per-payout statement trace, mark paid / mark failed with ledger T4 posts).
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ChevronDown, ChevronRight, Landmark, PlayCircle, PlusCircle, ShieldCheck } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/utils";
import { apiSend, parseJsonSafe, useApi } from "./use-api";
import type { AdminNav } from "./nav";
import {
  EmptyState,
  ErrorState,
  Money,
  PageHeader,
  ReasonDialog,
  StatusChip,
  TableSkeleton,
  fmtDT,
  timeAgo,
} from "./ui-bits";

/* ------------------------------------------------------------------ types */

type PayoutRow = {
  id: string;
  batchId: string;
  referenceNo: string;
  amountMinor: number;
  status: string;
  method: string;
  providerRef?: string | null;
  failReason?: string | null;
  paidAt?: string | null;
  statementJson?: string | null;
  createdAt?: string;
  sellerName?: string | null;
  sellerEmail?: string | null;
  bankAccount?: { id: string; bankName: string; holderName: string; accountNumberMasked: string } | null;
};

type PayoutBatch = {
  id: string;
  runType: string;
  status: string;
  currency: string;
  totalMinor: number;
  payoutCount: number;
  startedAt?: string;
  finishedAt?: string | null;
  payouts?: PayoutRow[];
};

type Statement = {
  sellerName?: string;
  periodFrom?: string;
  periodTo?: string;
  salesMinor?: number;
  commissionMinor?: number;
  refundsMinor?: number;
  adjustmentsMinor?: number;
  negativeCarryMinor?: number;
  orderCount?: number;
  reconciled?: boolean;
  lines?: { label: string; amountMinor: number }[];
};

type DryRunBody = {
  dryRun: boolean;
  minMinor: number;
  mode: string;
  eligibleCount: number;
  eligibleTotalMinor: number;
  eligible: {
    walletId: string;
    sellerId: string;
    sellerName: string;
    storeName: string | null;
    availableMinor: number;
    bank: { id: string; bankName: string; holderName: string; accountNumberMasked: string; verified: boolean } | null;
  }[];
};

/* ------------------------------------------------------------ PayoutsView */

export function PayoutsView({ nav }: { nav: AdminNav }) {
  const { data, error, loading, refetch } = useApi<PayoutBatch[]>("/api/admin/payout-batches");
  const rows = useMemo(() => data ?? [], [data]);

  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<DryRunBody | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const loadPreview = useCallback(async () => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const body = await apiSend<DryRunBody>("/api/admin/payout-batches", "POST", { dryRun: true });
      setPreview(body);
    } catch (e) {
      setPreview(null);
      setPreviewError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void loadPreview();
  }, [open, loadPreview]);

  const runBatch = async () => {
    setRunning(true);
    try {
      const body = await apiSend<{ batch?: PayoutBatch; payouts?: PayoutRow[] }>("/api/admin/payout-batches", "POST", { dryRun: false });
      const count = body?.payouts?.length ?? body?.batch?.payoutCount ?? 0;
      toast.success("Payout batch created", {
        description: `${count} payout${count === 1 ? "" : "s"} queued · ${formatMinor(body?.batch?.totalMinor ?? 0)} — ledger T3 posted per wallet.`,
      });
      setOpen(false);
      void refetch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("Batch not created", { description: msg });
      // A 409 NO_ELIGIBLE_WALLETS leaves the dialog open with a fresh preview.
      void loadPreview();
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Payout Batches"
        description="Weekly settlement runs — wallets above the minimum are swept to seller banks (T3 → T4)."
        actions={
          <Button size="sm" className="min-h-[44px]" onClick={() => setOpen(true)}>
            <PlusCircle className="h-4 w-4" /> New Payout Batch
          </Button>
        }
      />

      <Card className="py-0">
        <CardContent className="p-4">
          <div className="overflow-x-auto">
            {error ? (
              <ErrorState message={error} onRetry={() => void refetch()} />
            ) : loading ? (
              <TableSkeleton rows={5} cols={6} />
            ) : rows.length === 0 ? (
              <EmptyState title="No payout batches yet" hint="Run your first batch — eligible wallets are previewed before anything is written." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Batch</TableHead>
                    <TableHead>Run type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Payouts</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="hidden md:table-cell">Started</TableHead>
                    <TableHead className="hidden text-right lg:table-cell">Finished</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((b) => (
                    <TableRow
                      key={b.id}
                      className="cursor-pointer"
                      onClick={() => nav.navigate("payout-detail", { batchId: b.id })}
                    >
                      <TableCell className="font-mono text-xs font-semibold">{b.id.slice(0, 8)}…</TableCell>
                      <TableCell className="capitalize">{b.runType ?? "—"}</TableCell>
                      <TableCell><StatusChip status={b.status} /></TableCell>
                      <TableCell className="text-right tabular-nums">{b.payoutCount ?? b.payouts?.length ?? 0}</TableCell>
                      <TableCell className="text-right"><Money minor={b.totalMinor} bold /></TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground md:table-cell">{b.startedAt ? fmtDT(b.startedAt) : "—"}</TableCell>
                      <TableCell className="hidden text-right text-xs text-muted-foreground lg:table-cell">{b.finishedAt ? fmtDT(b.finishedAt) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>

      {/* new batch dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PlayCircle className="h-5 w-5 text-teal-600 dark:text-teal-400" /> New payout batch
            </DialogTitle>
            <DialogDescription>
              Dry-run preview first — nothing is written until you confirm. Eligibility: wallet available ≥ minimum payout setting.
            </DialogDescription>
          </DialogHeader>

          {previewLoading ? (
            <div className="space-y-2 py-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          ) : previewError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              {previewError}
            </div>
          ) : preview ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>min payout <Money minor={preview.minMinor} muted /></span>
                <span>mode <Badge variant="outline" className="ml-1">{preview.mode}</Badge></span>
                <span>{preview.eligibleCount} eligible wallet{preview.eligibleCount === 1 ? "" : "s"}</span>
                <span>total <Money minor={preview.eligibleTotalMinor} muted bold /></span>
              </div>
              {preview.eligible.length === 0 ? (
                <EmptyState
                  title="No eligible wallets"
                  hint={`No wallet currently meets the ${formatMinor(preview.minMinor)} minimum — the live run would return 409 NO_ELIGIBLE_WALLETS.`}
                />
              ) : (
                <div className="max-h-[320px] overflow-y-auto rounded-lg border [scrollbar-width:thin]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Seller / Store</TableHead>
                        <TableHead className="text-right">Available</TableHead>
                        <TableHead className="text-right">Will pay</TableHead>
                        <TableHead className="hidden sm:table-cell">Bank</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.eligible.map((e) => (
                        <TableRow key={e.walletId}>
                          <TableCell>
                            <p className="font-medium">{e.sellerName}</p>
                            <p className="text-xs text-muted-foreground">{e.storeName ?? "—"}</p>
                          </TableCell>
                          <TableCell className="text-right"><Money minor={e.availableMinor} muted /></TableCell>
                          <TableCell className="text-right"><Money minor={e.availableMinor} bold /></TableCell>
                          <TableCell className="hidden sm:table-cell">
                            {e.bank ? (
                              <span className="text-xs">
                                {e.bank.bankName} · <span className="font-mono">{e.bank.accountNumberMasked}</span>
                                {!e.bank.verified ? <Badge variant="outline" className="ml-1.5 border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300">unverified</Badge> : null}
                              </span>
                            ) : (
                              <span className="text-xs text-red-600 dark:text-red-400">no bank on file</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={running} className="min-h-[44px] sm:min-h-0">
              Cancel
            </Button>
            <Button onClick={() => void runBatch()} disabled={running || previewLoading || !preview || preview.eligibleCount === 0} className="min-h-[44px] sm:min-h-0">
              {running ? "Running…" : `Confirm run (${preview?.eligibleCount ?? 0})`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* -------------------------------------------------------- PayoutDetailView */

export function PayoutDetailView({ nav, batchId }: { nav: AdminNav; batchId: string }) {
  const batches = useApi<PayoutBatch[]>("/api/admin/payout-batches");
  const payoutsReq = useApi<PayoutRow[]>(`/api/admin/payouts?batchId=${encodeURIComponent(batchId)}`);
  const batch = useMemo(
    () => (batches.data ?? []).find((b) => b.id === batchId) ?? null,
    [batches.data, batchId]
  );
  const payouts = payoutsReq.data ?? [];

  const [expanded, setExpanded] = useState<string | null>(null);
  const [payTarget, setPayTarget] = useState<PayoutRow | null>(null);
  const [failTarget, setFailTarget] = useState<PayoutRow | null>(null);

  const done = () => {
    void payoutsReq.refetch();
    void batches.refetch();
  };

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" className="-ml-2 min-h-[44px] sm:min-h-0" onClick={() => nav.navigate("payouts")}>
        ← All payout batches
      </Button>

      {batches.error ? (
        <Card className="py-0"><CardContent className="p-4"><ErrorState message={batches.error} onRetry={() => void batches.refetch()} /></CardContent></Card>
      ) : batches.loading ? (
        <div className="h-10 w-64 animate-pulse rounded bg-muted" />
      ) : batch ? (
        <Card className="py-0">
          <CardContent className="p-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Batch</p>
                <p className="font-mono text-xs font-semibold">{batch.id}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Status</p>
                <StatusChip status={batch.status} />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Total</p>
                <Money minor={batch.totalMinor} bold />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Payouts</p>
                <p className="tabular-nums">{batch.payoutCount ?? payouts.length}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Started</p>
                <p className="text-xs">{fmtDT(batch.startedAt)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Finished</p>
                <p className="text-xs">{batch.finishedAt ? fmtDT(batch.finishedAt) : "—"}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="py-0">
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Batch not found — it may have been removed.</p>
          </CardContent>
        </Card>
      )}

      <Card className="py-0">
        <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
          <CardTitle className="text-base">Payouts in this batch</CardTitle>
          <CardDescription>Click a payout to inspect its settlement statement, then mark it paid or failed.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            {payoutsReq.error ? (
              <ErrorState message={payoutsReq.error} onRetry={() => void payoutsReq.refetch()} />
            ) : payoutsReq.loading ? (
              <TableSkeleton rows={4} cols={6} />
            ) : payouts.length === 0 ? (
              <EmptyState title="No payouts in this batch" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Reference</TableHead>
                    <TableHead>Seller</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">Method</TableHead>
                    <TableHead className="hidden text-right lg:table-cell">Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payouts.map((p) => (
                    <Fragment key={p.id}>
                      <TableRow className="cursor-pointer" onClick={() => setExpanded(expanded === p.id ? null : p.id)}>
                        <TableCell>{expanded === p.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                        <TableCell className="font-mono text-xs font-semibold">{p.referenceNo}</TableCell>
                        <TableCell>
                          <p className="font-medium">{p.sellerName ?? "—"}</p>
                          <p className="text-xs text-muted-foreground">{p.sellerEmail ?? ""}</p>
                        </TableCell>
                        <TableCell className="text-right"><Money minor={p.amountMinor} bold /></TableCell>
                        <TableCell>
                          <StatusChip status={p.status} />
                          {p.failReason ? <p className="mt-1 max-w-[180px] truncate text-[11px] text-red-600 dark:text-red-400">{p.failReason}</p> : null}
                        </TableCell>
                        <TableCell className="hidden text-sm capitalize md:table-cell">{p.method?.replace(/_/g, " ") ?? "—"}</TableCell>
                        <TableCell className="hidden text-right text-xs text-muted-foreground lg:table-cell">{timeAgo(p.paidAt ?? p.createdAt)}</TableCell>
                      </TableRow>
                      {expanded === p.id ? (
                        <TableRow>
                          <TableCell colSpan={7} className="bg-muted/30">
                            <PayoutExpand
                              payout={p}
                              onMarkPaid={() => setPayTarget(p)}
                              onMarkFailed={() => setFailTarget(p)}
                            />
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>

      {/* mark paid */}
      <MarkPaidDialog
        payout={payTarget}
        onClose={() => setPayTarget(null)}
        onDone={() => {
          setPayTarget(null);
          done();
        }}
      />

      {/* mark failed */}
      <ReasonDialog
        open={failTarget !== null}
        onOpenChange={(o) => !o && setFailTarget(null)}
        title="Mark payout as failed"
        description={
          failTarget
            ? `${failTarget.referenceNo} · ${formatMinor(failTarget.amountMinor)} — the debit is reversed in the ledger (T4f) and funds return to the seller wallet.`
            : ""
        }
        placeholder="Reason (e.g. bank account closed)…"
        submitLabel="Mark failed"
        destructive
        onSubmit={(reason) => {
          if (!failTarget) return;
          apiSend(`/api/admin/payouts/${failTarget.id}/fail`, "POST", { reason })
            .then(() => {
              toast.success("Payout marked failed", { description: "Ledger reversal posted; funds returned to wallet." });
              setFailTarget(null);
              done();
            })
            .catch((e: unknown) => toast.error("Failed to update payout", { description: e instanceof Error ? e.message : String(e) }));
        }}
      />
    </div>
  );
}

function PayoutExpand({
  payout,
  onMarkPaid,
  onMarkFailed,
}: {
  payout: PayoutRow;
  onMarkPaid: () => void;
  onMarkFailed: () => void;
}) {
  const st = parseJsonSafe<Statement>(payout.statementJson, {});
  const lines = st.lines ?? [];
  // Reconciliation audit: statement lines must sum EXACTLY to the net payout.
  // Ledger-truth statements (reconciled: true) always do; legacy demo snapshots
  // with decorated numbers fail this check and are flagged honestly.
  const linesSum = lines.reduce((s, l) => s + l.amountMinor, 0);
  const reconciles = lines.length > 0 && linesSum === payout.amountMinor;
  return (
    <div className="grid grid-cols-1 gap-4 p-3 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Settlement statement{st.sellerName ? ` — ${st.sellerName}` : ""}
        </p>
        {lines.length === 0 ? (
          <p className="text-xs text-muted-foreground">No statement lines recorded for this payout.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border bg-card">
            <div className={cn("flex items-center gap-1.5 border-b px-3 py-2 text-[11px] font-semibold", reconciles ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300" : "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300")}>
              {reconciles ? (
                <>
                  <ShieldCheck className="h-3.5 w-3.5" /> Ledger-reconciled — every figure is aggregated from ledger lines and Σ(lines) = net payout
                </>
              ) : (
                <>
                  <AlertTriangle className="h-3.5 w-3.5" /> Not reconciled — Σ(lines) {formatMinor(linesSum)} ≠ payout {formatMinor(payout.amountMinor)} (legacy demo snapshot)
                </>
              )}
            </div>
            <Table>
              <TableBody>
                {lines.map((l, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-sm">{l.label}</TableCell>
                    <TableCell className="w-32 text-right"><Money minor={l.amountMinor} /></TableCell>
                  </TableRow>
                ))}
                <TableRow className="border-t-2">
                  <TableCell className="text-sm font-semibold">Net payout</TableCell>
                  <TableCell className="w-32 text-right"><Money minor={payout.amountMinor} bold /></TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
        {st.orderCount != null || st.periodTo ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            {st.orderCount != null ? `${st.orderCount} paid order${st.orderCount === 1 ? "" : "s"}` : ""}
            {st.periodFrom && st.periodTo ? ` · ${fmtDT(st.periodFrom)} → ${fmtDT(st.periodTo)}` : ""}
          </p>
        ) : null}
      </div>

      <div className="space-y-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Bank</p>
          {payout.bankAccount ? (
            <div className="mt-1.5 space-y-1 rounded-lg border bg-card p-3 text-sm">
              <p className="flex items-center gap-1.5 font-medium">
                <Landmark className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" /> {payout.bankAccount.bankName}
              </p>
              <p className="text-muted-foreground">{payout.bankAccount.holderName}</p>
              <p className="font-mono text-xs">{payout.bankAccount.accountNumberMasked}</p>
            </div>
          ) : (
            <p className="mt-1.5 text-xs text-muted-foreground">No bank account linked</p>
          )}
        </div>
        {payout.providerRef ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Bank reference</p>
            <p className="mt-1 font-mono text-xs">{payout.providerRef}</p>
          </div>
        ) : null}
        {payout.status === "processing" ? (
          <div className="flex flex-col gap-2">
            <Button size="sm" className="min-h-[44px] bg-emerald-600 hover:bg-emerald-700" onClick={onMarkPaid}>
              Mark paid…
            </Button>
            <Button size="sm" variant="outline" className="min-h-[44px] border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950/40" onClick={onMarkFailed}>
              Mark failed…
            </Button>
          </div>
        ) : (
          <p className={cn("text-xs", payout.status === "paid" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")}>
            {payout.status === "paid" ? `Paid ${fmtDT(payout.paidAt)}` : "No actions available"}
          </p>
        )}
      </div>
    </div>
  );
}

function MarkPaidDialog({
  payout,
  onClose,
  onDone,
}: {
  payout: PayoutRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [refNo, setRefNo] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (payout) setRefNo("");
  }, [payout]);

  const submit = async () => {
    if (!payout || !refNo.trim()) return;
    setSaving(true);
    try {
      await apiSend(`/api/admin/payouts/${payout.id}/mark-paid`, "POST", { referenceNo: refNo.trim() });
      toast.success("Payout marked paid", {
        description: `${payout.referenceNo} · bank ref ${refNo.trim()} — ledger T4 posted.`,
      });
      onDone();
    } catch (e) {
      toast.error("Mark paid failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={payout !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark payout as paid</DialogTitle>
          <DialogDescription>
            {payout ? `${payout.referenceNo} · ${formatMinor(payout.amountMinor)} to ${payout.sellerName ?? "seller"}.` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="payout-ref">Bank reference number (required)</Label>
          <Input
            id="payout-ref"
            value={refNo}
            onChange={(e) => setRefNo(e.target.value)}
            placeholder="e.g. BK-20261008-8817"
            className="min-h-[44px]"
            autoFocus
          />
          <p className="text-[11px] text-muted-foreground">Recorded on the payout and posted to the ledger as payout_confirmed (T4).</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving} className="min-h-[44px] sm:min-h-0">Cancel</Button>
          <Button onClick={() => void submit()} disabled={saving || !refNo.trim()} className="min-h-[44px] bg-emerald-600 hover:bg-emerald-700 sm:min-h-0">
            {saving ? "Posting…" : "Confirm paid"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
