"use client";
// AFF-03 — Affiliate Commissions inspector: filterable allocation list with a
// per-row entry breakdown (role/amount/status/hold) and the audited manual
// hold/release controls. Data: GET /api/admin/affiliate/commissions
// (cap: affiliate.manage OR affiliate.finance; hold/release: affiliate.manage).
import { Fragment, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Lock, LockOpen, Search, ScrollText, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { AdminNav } from "../nav";
import { useAdminCaps } from "../use-admin-caps";
import { apiSend, useApi } from "../use-api";
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
} from "../ui-bits";
import { bpsLabel, type CommissionsBody, type CommissionRow } from "./types";

const COMMISSION_STATUSES = ["pending", "approved", "available", "paid", "reversed", "held"];

export function AffiliateCommissionsView({ nav }: { nav: AdminNav }) {
  const { can } = useAdminCaps();
  // Deep-link support: accounts detail navigates here with { affiliateId }.
  const [affiliateFilter, setAffiliateFilter] = useState<string | null>(nav.params.affiliateId ?? null);
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  // Server search is not offered by the commissions route — an order-number
  // filter narrows the CURRENT PAGE client-side (labelled as such below).
  const [orderFilter, setOrderFilter] = useState("");

  const url = useMemo(() => {
    const sp = new URLSearchParams({ page: String(page), size: "20" });
    if (status !== "all") sp.set("status", status);
    if (affiliateFilter) sp.set("affiliateId", affiliateFilter);
    return `/api/admin/affiliate/commissions?${sp.toString()}`;
  }, [status, affiliateFilter, page]);

  const { data, error, loading, refetch } = useApi<CommissionsBody>(url);
  const rows = useMemo(() => {
    const base = data?.rows ?? [];
    const q = orderFilter.trim().toLowerCase();
    return q ? base.filter((r) => r.orderNumber.toLowerCase().includes(q)) : base;
  }, [data, orderFilter]);
  const total = data?.total ?? 0;
  const serverPage = data?.page ?? page;

  const [expanded, setExpanded] = useState<string | null>(null);
  const [holdTarget, setHoldTarget] = useState<CommissionRow | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<CommissionRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    // Clear stale expansion when the page/filter changes underneath it.
    setExpanded(null);
  }, [url]);

  const runHold = async (row: CommissionRow, action: "hold" | "release", reason?: string) => {
    setBusyId(row.id);
    try {
      const res = await apiSend<{ status: string }>(`/api/admin/affiliate/commissions/${encodeURIComponent(row.id)}/hold`, "POST", {
        action,
        ...(reason ? { reason } : {}),
      });
      toast.success(`Commission ${action === "hold" ? "held" : "released"}`, {
        description: `${row.orderNumber} is now “${res.status}” — the action was written to the audit log.`,
      });
      void refetch();
      return true;
    } catch (e) {
      toast.error(`${action === "hold" ? "Hold" : "Release"} failed`, {
        description: e instanceof Error ? e.message : String(e),
      });
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const canHold = (row: CommissionRow): boolean =>
    row.status !== "held" && row.entries.some((e) => ["pending", "approved", "available"].includes(e.status));
  const canRelease = (row: CommissionRow): boolean => row.entries.some((e) => e.status === "held");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Affiliate Commissions"
        description="Every posted allocation with its direct/sponsor split — hold or release entries during fraud review."
      />

      <Card className="py-0">
        <CardContent className="p-4">
          {/* filters */}
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <Input
              value={orderFilter}
              onChange={(e) => setOrderFilter(e.target.value)}
              placeholder="Filter current page by order №…"
              className="min-h-[44px] flex-1"
              aria-label="Filter by order number (current page)"
            />
            <div className="flex flex-wrap items-center gap-2">
              {affiliateFilter ? (
                <Badge variant="outline" className="gap-1 border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-900 dark:bg-teal-950/60 dark:text-teal-300">
                  affiliate {affiliateFilter.slice(0, 8)}…
                  <button
                    type="button"
                    aria-label="Clear affiliate filter"
                    className="ml-0.5 rounded-full hover:bg-teal-100 dark:hover:bg-teal-900"
                    onClick={() => {
                      setAffiliateFilter(null);
                      setPage(1);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ) : null}
              <Select
                value={status}
                onValueChange={(v) => {
                  setStatus(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="min-h-[44px] w-full lg:w-44" aria-label="Filter by status">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {COMMISSION_STATUSES.map((s) => (
                    <SelectItem key={s} value={s} className="capitalize">
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* table */}
          <div className="mt-4 overflow-x-auto">
            {error ? (
              <ErrorState message={error} onRetry={() => void refetch()} />
            ) : loading ? (
              <TableSkeleton rows={8} cols={8} />
            ) : rows.length === 0 ? (
              <EmptyState title="No commissions found" hint="Try clearing filters — commissions appear here the moment a payment posts." />
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8" />
                      <TableHead>Order</TableHead>
                      <TableHead className="hidden md:table-cell">Date</TableHead>
                      <TableHead>Affiliate</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">Base</TableHead>
                      <TableHead className="hidden text-right lg:table-cell">Rate</TableHead>
                      <TableHead className="text-right">Pool</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">Direct</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">Sponsor</TableHead>
                      <TableHead>Status</TableHead>
                      {can("affiliate.manage") ? <TableHead className="text-right">Actions</TableHead> : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => {
                      const direct = row.entries.find((e) => e.role === "direct");
                      const sponsor = row.entries.find((e) => e.role === "sponsor");
                      return (
                        <Fragment key={row.id}>
                          <TableRow className="cursor-pointer" onClick={() => setExpanded(expanded === row.id ? null : row.id)}>
                            <TableCell>{expanded === row.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                            <TableCell>
                              <p className="font-mono text-xs font-semibold">{row.orderNumber}</p>
                              <p className="font-mono text-[10px] text-muted-foreground">{row.orderItemId.slice(0, 12)}…</p>
                            </TableCell>
                            <TableCell className="hidden text-xs text-muted-foreground md:table-cell">{fmtDT(row.createdAt)}</TableCell>
                            <TableCell className="max-w-40 truncate text-sm">{row.affiliate}</TableCell>
                            <TableCell className="hidden text-right sm:table-cell">
                              <Money minor={row.baseMinor} muted />
                            </TableCell>
                            <TableCell className="hidden text-right text-sm tabular-nums lg:table-cell">
                              {bpsLabel(row.rateBps)}
                            </TableCell>
                            <TableCell className="text-right">
                              <Money minor={row.poolMinor} bold />
                            </TableCell>
                            <TableCell className="hidden text-right sm:table-cell">
                              <Money minor={direct?.amountMinor ?? 0} />
                            </TableCell>
                            <TableCell className="hidden text-right sm:table-cell">
                              <Money minor={sponsor?.amountMinor ?? 0} />
                            </TableCell>
                            <TableCell>
                              <StatusChip status={row.status} />
                            </TableCell>
                            {can("affiliate.manage") ? (
                              <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                                <div className="flex justify-end gap-1.5">
                                  {canHold(row) ? (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-8 min-h-[36px] gap-1"
                                      disabled={busyId === row.id}
                                      onClick={() => setHoldTarget(row)}
                                    >
                                      <Lock className="h-3.5 w-3.5" /> Hold
                                    </Button>
                                  ) : null}
                                  {canRelease(row) ? (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-8 min-h-[36px] gap-1"
                                      disabled={busyId === row.id}
                                      onClick={() => setReleaseTarget(row)}
                                    >
                                      <LockOpen className="h-3.5 w-3.5" /> Release
                                    </Button>
                                  ) : null}
                                  {!canHold(row) && !canRelease(row) ? (
                                    <span className="text-xs text-muted-foreground">—</span>
                                  ) : null}
                                </div>
                              </TableCell>
                            ) : null}
                          </TableRow>
                          {expanded === row.id ? (
                            <TableRow>
                              <TableCell colSpan={can("affiliate.manage") ? 11 : 10} className="bg-muted/30">
                                <EntryBreakdown row={row} />
                              </TableCell>
                            </TableRow>
                          ) : null}
                        </Fragment>
                      );
                    })}
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
          <p className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
            <Search className="h-3 w-3" aria-hidden /> The order filter narrows the current page only — the commissions
            API filters server-side by status and affiliate.
          </p>
        </CardContent>
      </Card>

      {/* hold — reason ≥ 10 chars required by the server; enforced client-side */}
      <ReasonDialog
        open={holdTarget !== null}
        onOpenChange={(o) => !o && setHoldTarget(null)}
        title="Hold commission entries"
        description={
          holdTarget
            ? `${holdTarget.orderNumber} · pool ${formatMinor(holdTarget.poolMinor)}. Both roles' un-paid entries freeze as “held” — paid entries are never touched (late issues become recovery entries). Reason (min 10 characters) is written to the audit log.`
            : ""
        }
        placeholder="e.g. Attribution dispute — duplicated referral code, ticket #812"
        submitLabel="Hold entries"
        destructive
        loading={busyId === holdTarget?.id}
        onSubmit={(reason) => {
          if (!holdTarget) return;
          if (reason.length < 10) {
            toast.error("Reason too short", { description: "A documented reason of at least 10 characters is required to hold a commission." });
            return;
          }
          const target = holdTarget;
          void runHold(target, "hold", reason).then((ok) => {
            if (ok) setHoldTarget(null);
          });
        }}
      />

      {/* release — held entries return to the lifecycle with a fresh review window */}
      <ConfirmDialog
        open={releaseTarget !== null}
        onOpenChange={(o) => !o && setReleaseTarget(null)}
        title="Release held entries?"
        description={
          releaseTarget
            ? `${releaseTarget.orderNumber} — held entries return to “approved” with a fresh review window (review_days), then mature on the affiliate-tick sweep.`
            : ""
        }
        confirmLabel="Release entries"
        loading={busyId === releaseTarget?.id}
        onConfirm={() => {
          const target = releaseTarget;
          setReleaseTarget(null);
          if (target) void runHold(target, "release");
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------- entry breakdown */

function EntryBreakdown({ row }: { row: CommissionRow }) {
  return (
    <div className="p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <ScrollText className="h-3.5 w-3.5" aria-hidden /> Entries breakdown — {row.entries.length} role allocation
        {row.entries.length === 1 ? "" : "s"}
      </p>
      <div className="overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Role</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Reversed</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden md:table-cell">Available at</TableHead>
              <TableHead>Hold reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {row.entries.map((e, i) => (
              <TableRow key={i}>
                <TableCell>
                  <Badge variant="outline" className={cn("capitalize", e.role === "sponsor" ? "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/60 dark:text-violet-300" : "border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-900 dark:bg-teal-950/60 dark:text-teal-300")}>
                    {e.role}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Money minor={e.amountMinor} bold />
                </TableCell>
                <TableCell className="text-right">
                  {e.reversedMinor > 0 ? <Money minor={-e.reversedMinor} /> : <span className="text-xs text-muted-foreground">—</span>}
                </TableCell>
                <TableCell>
                  <StatusChip status={e.status} />
                </TableCell>
                <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                  {e.availableAt ? fmtDT(e.availableAt) : "—"}
                </TableCell>
                <TableCell className="max-w-56 truncate font-mono text-[11px] text-muted-foreground" title={e.holdReason ?? undefined}>
                  {e.holdReason ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Base <Money minor={row.baseMinor} muted /> × {bpsLabel(row.rateBps)} = pool <Money minor={row.poolMinor} muted /> —
        allocations never exceed the pool (reconciliation invariant).
      </p>
    </div>
  );
}
