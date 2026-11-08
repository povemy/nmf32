"use client";
// AFF-03 — Affiliate Commissions inspector: filterable allocation list with a
// per-row entry breakdown (role/amount/status/hold) and the audited manual
// hold/release controls. Data: GET /api/admin/affiliate/commissions
// (cap: affiliate.manage OR affiliate.finance; hold/release: affiliate.manage).
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Lock, LockOpen, RotateCcw, ScrollText, X } from "lucide-react";
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
import { apiSend, useApi, useDebounced } from "../use-api";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  fmtDate,
  Money,
  PageHeader,
  Pager,
  ReasonDialog,
  StatusChip,
  TableSkeleton,
  fmtDT,
} from "../ui-bits";
import { bpsLabel } from "./types";
import type {
  AdminAffCommissionRow,
  AdminAffCommissionsData,
  AdminAffHoldData,
  AdminStoresData,
} from "@/lib/types/api-contract";

const COMMISSION_STATUSES = ["pending", "approved", "available", "paid", "reversed", "held"];

/** Local-day start → UTC ISO instant for the server's `from` param. */
function dayStartIso(date: string): string | null {
  if (!date) return null;
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Local-day end (inclusive) → UTC ISO instant for the server's `to` param. */
function dayEndIso(date: string): string | null {
  if (!date) return null;
  const d = new Date(`${date}T23:59:59.999`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function AffiliateCommissionsView({ nav }: { nav: AdminNav }) {
  const { can } = useAdminCaps();
  // Deep-link support: accounts detail navigates here with { affiliateId }.
  const [affiliateFilter, setAffiliateFilter] = useState<string | null>(nav.params.affiliateId ?? null);
  const [status, setStatus] = useState("all");
  const [storeFilter, setStoreFilter] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  // P9: order-number search is fully SERVER-SIDE — the input is debounced
  // (~300ms) into the query string, so it narrows the whole history, not the
  // current page. Every filter change resets the page to 1.
  const [orderInput, setOrderInput] = useState("");
  const orderQuery = useDebounced(orderInput, 300);

  // Store directory for the store filter — fetched once on mount. Load-test
  // fixtures can repeat a store name, so duplicates are disambiguated by slug.
  const { data: stores } = useApi<AdminStoresData[]>("/api/admin/stores");
  const storeOptions = useMemo(() => {
    const list = (stores ?? []).map((s) => ({ id: s.id, name: s.name, slug: s.slug }));
    const counts = new Map<string, number>();
    for (const s of list) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
    return list
      .map((s) => ({ id: s.id, label: (counts.get(s.name) ?? 0) > 1 ? `${s.name} · /${s.slug}` : s.name }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [stores]);
  const storeName = useCallback(
    (id: string) => storeOptions.find((s) => s.id === id)?.label ?? `${id.slice(0, 8)}…`,
    [storeOptions]
  );

  const fromIso = useMemo(() => dayStartIso(from), [from]);
  const toIso = useMemo(() => dayEndIso(to), [to]);

  const url = useMemo(() => {
    const sp = new URLSearchParams({ page: String(page), size: "20" });
    if (status !== "all") sp.set("status", status);
    if (affiliateFilter) sp.set("affiliateId", affiliateFilter);
    if (storeFilter) sp.set("storeId", storeFilter);
    const q = orderQuery.trim();
    if (q) sp.set("orderNumber", q);
    if (fromIso) sp.set("from", fromIso);
    if (toIso) sp.set("to", toIso);
    return `/api/admin/affiliate/commissions?${sp.toString()}`;
  }, [status, affiliateFilter, storeFilter, orderQuery, fromIso, toIso, page]);

  const { data, error, loading, refetch } = useApi<AdminAffCommissionsData>(url);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const total = data?.total ?? 0;
  const serverPage = data?.page ?? page;

  // Server-echoed filters for THIS response — the honest description of what
  // the scope totals below actually cover.
  const echo = data?.filters;
  const echoParts: string[] = [];
  if (echo?.status) echoParts.push(`status “${echo.status}”`);
  if (echo?.affiliateId) echoParts.push(`affiliate ${echo.affiliateId.slice(0, 8)}…`);
  if (echo?.storeId) echoParts.push(`store “${storeName(echo.storeId)}”`);
  if (echo?.orderNumber) echoParts.push(`order “${echo.orderNumber}”`);
  if (echo?.from) echoParts.push(`from ${fmtDate(echo.from)}`);
  if (echo?.to) echoParts.push(`to ${fmtDate(echo.to)}`);

  const filtersActive =
    status !== "all" || affiliateFilter != null || storeFilter != null || orderInput.trim() !== "" || from !== "" || to !== "";
  const resetFilters = () => {
    setStatus("all");
    setAffiliateFilter(null);
    setStoreFilter(null);
    setOrderInput("");
    setFrom("");
    setTo("");
    setPage(1);
  };

  const [expanded, setExpanded] = useState<string | null>(null);
  const [holdTarget, setHoldTarget] = useState<AdminAffCommissionRow | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<AdminAffCommissionRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    // Clear stale expansion when the page/filter changes underneath it.
    setExpanded(null);
  }, [url]);

  const runHold = async (row: AdminAffCommissionRow, action: "hold" | "release", reason?: string) => {
    setBusyId(row.id);
    try {
      // NOTE: the contract body (AdminAffHoldBody) marks `reason` required,
      // but the route only enforces it for holds — the release path sends
      // `{ action }` alone, so the body stays inline rather than typed.
      const res = await apiSend<AdminAffHoldData>(`/api/admin/affiliate/commissions/${encodeURIComponent(row.id)}/hold`, "POST", {
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

  const canHold = (row: AdminAffCommissionRow): boolean =>
    row.status !== "held" && row.entries.some((e) => ["pending", "approved", "available"].includes(e.status));
  const canRelease = (row: AdminAffCommissionRow): boolean => row.entries.some((e) => e.status === "held");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Affiliate Commissions"
        description="Every posted allocation with its direct/sponsor split — hold or release entries during fraud review."
      />

      <Card className="py-0">
        <CardContent className="p-4">
          {/* filters — ALL server-side (P9): status, affiliate (deep-link),
              store, order number (debounced) and the created-at date range */}
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <Input
              value={orderInput}
              onChange={(e) => {
                setOrderInput(e.target.value);
                setPage(1);
              }}
              placeholder="Search order number…"
              className="min-h-[44px] flex-1"
              aria-label="Search by order number"
              autoComplete="off"
              inputMode="search"
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
                value={storeFilter ?? "all"}
                onValueChange={(v) => {
                  setStoreFilter(v === "all" ? null : v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="min-h-[44px] w-full lg:w-44" aria-label="Filter by store">
                  <SelectValue placeholder="All stores" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All stores</SelectItem>
                  {storeOptions.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              <Input
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPage(1);
                }}
                aria-label="Created from date"
                className="min-h-[44px] w-full lg:w-40"
              />
              <Input
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPage(1);
                }}
                aria-label="Created to date"
                className="min-h-[44px] w-full lg:w-40"
              />
              {filtersActive ? (
                <Button variant="ghost" size="sm" className="min-h-[44px] gap-1.5" onClick={resetFilters}>
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset
                </Button>
              ) : null}
            </div>
          </div>

          {/* scope totals — server-aggregated over the ACTIVE filters (not the
              page), with the server-echoed filter description underneath */}
          {data ? (
            <div className="mt-3 space-y-1">
              <p className="text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">Scope:</span> {data.total.toLocaleString()} commission
                {data.total === 1 ? "" : "s"} · Pool <Money minor={data.totals?.poolMinor ?? 0} /> · Base{" "}
                <Money minor={data.totals?.baseMinor ?? 0} muted />
              </p>
              {echoParts.length > 0 ? (
                <p className="text-[11px] leading-snug text-muted-foreground">Filters applied — {echoParts.join(" · ")}</p>
              ) : null}
            </div>
          ) : null}

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

function EntryBreakdown({ row }: { row: AdminAffCommissionRow }) {
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
