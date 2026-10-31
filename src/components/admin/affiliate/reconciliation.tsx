"use client";
// AFF-05 — Affiliate Reconciliation: the 7-point financial report (spec §9)
// with the ledger cross-check against PLATFORM:AFFILIATE_LIABILITY, the
// green/red invariant badge, per-status breakdowns and a client-side
// JSON/CSV export (copy to clipboard). Data:
// GET /api/admin/affiliate/reconciliation (cap: affiliate.finance).
import { useMemo } from "react";
import { toast } from "sonner";
import { ClipboardList, FileSpreadsheet, Scale, ShieldAlert, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/utils";
import { useApi } from "../use-api";
import { EmptyState, ErrorState, Money, PageHeader, StatusChip, TableSkeleton, CheckRow } from "../ui-bits";
import type { ReconciliationReport } from "./types";

async function copyText(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`Copied ${label}`, { description: "Paste into a ticket or spreadsheet — figures are exact minor units." });
  } catch {
    toast.error("Could not copy", { description: "Clipboard access was denied by the browser." });
  }
}

export function AffiliateReconciliationView() {
  const { data, error, loading, refetch } = useApi<ReconciliationReport>("/api/admin/affiliate/reconciliation");

  const points = data?.points;

  const exportJson = useMemo(() => (data ? JSON.stringify({ exportedAt: new Date().toISOString(), ...data }, null, 2) : ""), [data]);

  const exportCsv = useMemo(() => {
    if (!data) return "";
    const lines: string[] = ["section,item,value_minor,value_myr"];
    const row = (section: string, item: string, minor: number) =>
      lines.push(`${section},${JSON.stringify(item)},${minor},${JSON.stringify(formatMinor(minor))}`);
    row("points", "1 expected pool", data.points.expectedPoolMinor);
    row("points", "2 allocated (direct + sponsor)", data.points.allocatedMinor);
    row("points", "3 held", data.points.heldMinor);
    row("points", "4 available (incl. approved)", data.points.availableMinor);
    row("points", "5 paid out", data.points.paidOutMinor);
    row("points", "6 reversals", data.points.reversalsMinor);
    row("points", "7 remaining liability", data.points.remainingLiabilityMinor);
    row("ledger", "PLATFORM:AFFILIATE_LIABILITY balance", data.ledgerBalanceMinor);
    for (const e of data.entriesByStatus) row("entries_by_status", e.status, e.amountMinor);
    for (const p of data.payoutsByStatus) row("payouts_by_status", p.status, p.amountMinor);
    return lines.join("\n");
  }, [data]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Affiliate Reconciliation"
        description="Seven-point financial integrity report — expected pool vs allocations, holds, availability, payouts, reversals and the ledger liability."
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="min-h-[44px] gap-1.5 sm:min-h-0"
              disabled={!exportCsv}
              onClick={() => void copyText(exportCsv, "CSV")}
            >
              <FileSpreadsheet className="h-3.5 w-3.5" /> Copy CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="min-h-[44px] gap-1.5 sm:min-h-0"
              disabled={!exportJson}
              onClick={() => void copyText(exportJson, "JSON")}
            >
              <ClipboardList className="h-3.5 w-3.5" /> Copy JSON
            </Button>
          </div>
        }
      />

      {error ? (
        <Card className="py-0">
          <CardContent className="p-4">
            <ErrorState message={error} onRetry={() => void refetch()} />
          </CardContent>
        </Card>
      ) : loading ? (
        <TableSkeleton rows={8} cols={4} />
      ) : !data || !points ? null : (
        <>
          {/* invariant banner */}
          {data.invariantOk ? (
            <div
              className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/40"
              role="status"
            >
              <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <div>
                <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">Ledger invariant OK</p>
                <p className="text-xs text-emerald-700/90 dark:text-emerald-400/90">
                  Allocations never exceed the funded pool and the liability account never went negative
                  (over-payment impossible by construction).
                </p>
              </div>
            </div>
          ) : (
            <VariancePanel report={data} />
          )}

          {/* 7-point report */}
          <Card className="py-0">
            <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <Scale className="h-4 w-4 text-teal-600 dark:text-teal-400" aria-hidden />
                Seven-point report
              </CardTitle>
              <CardDescription>
                {data.commissionCount} commission{data.commissionCount === 1 ? "" : "s"} · {data.pendingEntryCount} entr
                {data.pendingEntryCount === 1 ? "y" : "ies"} awaiting maturity.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0 pb-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">#</TableHead>
                    <TableHead>Point</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="hidden lg:table-cell">Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <PointRow n={1} label="Expected pool" minor={points.expectedPoolMinor} notes="Σ AffiliateCommission.poolMinor — the seller-funded liability origin." />
                  <PointRow
                    n={2}
                    label="Allocated (direct + sponsor)"
                    minor={points.allocatedMinor}
                    notes={
                      points.allocatedMinor === points.expectedPoolMinor
                        ? "equals the pool — by construction"
                        : `Δ ${formatMinor(points.allocatedMinor - points.expectedPoolMinor)} vs pool — any excess is corruption`
                    }
                    alert={points.allocatedMinor > points.expectedPoolMinor}
                  />
                  <PointRow n={3} label="Held" minor={points.heldMinor} notes="fraud/review holds + suspended-beneficiary sponsor shares." />
                  <PointRow n={4} label="Available (incl. approved)" minor={points.availableMinor} notes="approved entries mature by clock (review window)." />
                  <PointRow n={5} label="Paid out" minor={points.paidOutMinor} notes="Σ payouts with status paid." />
                  <PointRow n={6} label="Reversals" minor={points.reversalsMinor} notes="refunds clawed back across every entry." />
                  <PointRow
                    n={7}
                    label="Remaining liability"
                    minor={points.remainingLiabilityMinor}
                    notes={
                      points.remainingLiabilityMinor === data.ledgerBalanceMinor
                        ? "cross-check: equals PLATFORM:AFFILIATE_LIABILITY ledger balance"
                        : `cross-check MISMATCH — ledger balance is ${formatMinor(data.ledgerBalanceMinor)}`
                    }
                    alert={points.remainingLiabilityMinor !== data.ledgerBalanceMinor || data.ledgerBalanceMinor < 0}
                  />
                </TableBody>
              </Table>
              <div className="flex flex-wrap items-center gap-4 px-4 pb-3 pt-2 sm:px-6">
                <CheckRow ok={points.allocatedMinor <= points.expectedPoolMinor}>
                  allocated ≤ expected pool ({formatMinor(points.allocatedMinor)} / {formatMinor(points.expectedPoolMinor)})
                </CheckRow>
                <CheckRow ok={data.ledgerBalanceMinor >= 0}>
                  liability ledger balance ≥ 0 ({formatMinor(data.ledgerBalanceMinor)})
                </CheckRow>
              </div>
            </CardContent>
          </Card>

          {/* breakdowns */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="py-0">
              <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
                <CardTitle className="text-base">Entries by status</CardTitle>
                <CardDescription>Commission entry lifecycle buckets with reversal offsets.</CardDescription>
              </CardHeader>
              <CardContent className="px-0 pb-2">
                {data.entriesByStatus.length === 0 ? (
                  <EmptyState title="No entries yet" />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Count</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead className="text-right">Reversed</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.entriesByStatus.map((e) => (
                        <TableRow key={e.status}>
                          <TableCell>
                            <StatusChip status={e.status} />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{e.count}</TableCell>
                          <TableCell className="text-right">
                            <Money minor={e.amountMinor} />
                          </TableCell>
                          <TableCell className="text-right">
                            {e.reversedMinor > 0 ? <Money minor={-e.reversedMinor} /> : <span className="text-xs text-muted-foreground">—</span>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card className="py-0">
              <CardHeader className="px-4 pt-4 sm:px-6 sm:pt-5">
                <CardTitle className="text-base">Payouts by status</CardTitle>
                <CardDescription>The manual payout queue across the requested → paid state machine.</CardDescription>
              </CardHeader>
              <CardContent className="px-0 pb-2">
                {data.payoutsByStatus.length === 0 ? (
                  <EmptyState title="No payouts yet" />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Count</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.payoutsByStatus.map((p) => (
                        <TableRow key={p.status}>
                          <TableCell>
                            <StatusChip status={p.status} />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{p.count}</TableCell>
                          <TableCell className="text-right">
                            <Money minor={p.amountMinor} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------- variance */

function VariancePanel({ report }: { report: ReconciliationReport }) {
  const overAllocated = report.points.allocatedMinor > report.points.expectedPoolMinor;
  const negativeLedger = report.ledgerBalanceMinor < 0;
  const ledgerMismatch = report.points.remainingLiabilityMinor !== report.ledgerBalanceMinor;
  return (
    <div
      className="rounded-xl border border-red-300 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40"
      role="alert"
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-red-800 dark:text-red-300">
        <ShieldAlert className="h-5 w-5" /> Ledger variance detected — investigate before paying out
      </p>
      <ul className="mt-2 space-y-1 text-xs text-red-700 dark:text-red-400/90">
        {overAllocated ? (
          <li>
            Allocated ({formatMinor(report.points.allocatedMinor)}) EXCEEDS the expected pool (
            {formatMinor(report.points.expectedPoolMinor)}) by {formatMinor(report.points.allocatedMinor - report.points.expectedPoolMinor)} —
            possible data corruption.
          </li>
        ) : null}
        {negativeLedger ? (
          <li>
            PLATFORM:AFFILIATE_LIABILITY balance is {formatMinor(report.ledgerBalanceMinor)} — negative, meaning an
            over-payment or missing pool credit.
          </li>
        ) : null}
        {ledgerMismatch ? (
          <li>
            Point 7 ({formatMinor(report.points.remainingLiabilityMinor)}) does not match the ledger balance (
            {formatMinor(report.ledgerBalanceMinor)}).
          </li>
        ) : null}
        {!overAllocated && !negativeLedger && !ledgerMismatch ? (
          <li>The invariant flag was raised server-side without a detected condition — re-run the report.</li>
        ) : null}
      </ul>
    </div>
  );
}

function PointRow({
  n,
  label,
  minor,
  notes,
  alert,
}: {
  n: number;
  label: string;
  minor: number;
  notes?: string;
  alert?: boolean;
}) {
  return (
    <TableRow className={cn(alert && "bg-red-50/60 dark:bg-red-950/20")}>
      <TableCell className="text-xs font-bold text-muted-foreground">{n}</TableCell>
      <TableCell className="text-sm font-medium">{label}</TableCell>
      <TableCell className="text-right">
        <Money minor={minor} bold={n === 7} />
      </TableCell>
      <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
        {alert ? <Badge variant="outline" className="mr-1 border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300">check</Badge> : null}
        {notes}
      </TableCell>
    </TableRow>
  );
}
