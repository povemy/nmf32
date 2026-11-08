"use client";
// R2-UI — Pending releases (grace-period release schedule). Rendered as the
// "Pending releases" tab inside Wallet & Payouts (nav-reorg consolidation);
// per-order pending seller-net ledger credits (T1 "order_paid") joined to
// orders, showing exactly when each payment leaves the clearing hold.
import { useState } from "react";
import {
  EmptyState,
  RowsSkeleton,
  StatusChip,
  apiGet,
  fmtDate,
  formatMinor,
  useApi,
  type SellerNav,
} from "./ui-bits";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowDownToLine, Hourglass, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PendingReleaseRow, PendingReleasesData } from "@/lib/types/api-contract";

const PAGE_SIZE = 25;

// Release date-times render in the platform's local timezone (Asia/Kuala_Lumpur)
// regardless of the viewer's device clock — money dates should not drift.
const MY_DATETIME = new Intl.DateTimeFormat("en-MY", {
  timeZone: "Asia/Kuala_Lumpur",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** YYYY-MM-DD day key in Asia/Kuala_Lumpur — used for "releases today". */
function myDayKey(v: string | Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(v));
}

function fmtMyDateTime(v: string | Date | null | undefined): string {
  if (!v) return "—";
  try {
    return MY_DATETIME.format(new Date(v));
  } catch {
    return "—";
  }
}

/** Days-left badge text: "Releases today" / "Releasing in N hours" / "Releases in N days". */
function releaseLabel(availableAt: string): { text: string; className: string } {
  const msLeft = new Date(availableAt).getTime() - Date.now();
  if (msLeft <= 0) return { text: "Releasing now", className: "bg-emerald-100 text-emerald-700 border-emerald-200" };
  const hoursLeft = msLeft / 3600000;
  if (hoursLeft < 1) return { text: "Releasing soon", className: "bg-emerald-100 text-emerald-700 border-emerald-200" };
  if (myDayKey(availableAt) === myDayKey(new Date()))
    return { text: "Releases today", className: "bg-emerald-100 text-emerald-700 border-emerald-200" };
  if (hoursLeft < 24) {
    const n = Math.max(1, Math.floor(hoursLeft));
    return { text: `Releasing in ${n} hour${n === 1 ? "" : "s"}`, className: "bg-amber-100 text-amber-700 border-amber-200" };
  }
  const n = Math.ceil(hoursLeft / 24);
  return { text: `Releases in ${n} day${n === 1 ? "" : "s"}`, className: "bg-amber-100 text-amber-700 border-amber-200" };
}

/** Elapsed share of the hold window (paidAt → availableAt), clamped 0–100. */
function holdProgressPct(row: PendingReleaseRow): number {
  const paidMs = row.paidAt ? new Date(row.paidAt).getTime() : 0;
  const availMs = new Date(row.availableAt).getTime();
  if (availMs <= paidMs) return 100;
  const pct = ((Date.now() - paidMs) / (availMs - paidMs)) * 100;
  return Math.min(100, Math.max(0, pct));
}

export default function SellerPendingReleases({ onNavigate }: { onNavigate: (n: SellerNav) => void }) {
  const { data, loading, error, refetch, setData } = useApi<PendingReleasesData>(`/api/store/pending-releases?size=${PAGE_SIZE}`);
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="space-y-5">
        <RowsSkeleton rows={2} />
        <RowsSkeleton rows={5} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3 p-6">
          <p className="text-sm text-rose-600">Could not load pending releases{error ? `: ${error}` : ""}</p>
          <Button variant="outline" size="sm" onClick={refetch}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { summary, releases } = data;
  const hasMore = releases.length < summary.count;
  // Typical hold window for the explainer copy — derived from the first row.
  const typicalHoldDays = releases[0]?.holdDays ?? null;

  const loadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const next = await apiGet<PendingReleasesData>(`/api/store/pending-releases?size=${PAGE_SIZE}&page=${page + 1}`);
      setData({ ...data, releases: [...releases, ...next.releases] });
      setPage(page + 1);
    } catch (e) {
      setLoadMoreError(e instanceof Error ? e.message : "Could not load more releases");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* summary header */}
      <section aria-label="Pending summary">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Hourglass className="h-4 w-4 text-amber-500" /> Grace-period release schedule
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border p-3">
                <p className="text-xs text-muted-foreground">Total pending</p>
                <p className="mt-1 text-xl font-semibold tabular-nums text-amber-600">{formatMinor(summary.totalMinor)}</p>
              </div>
              <div className="rounded-xl border p-3">
                <p className="text-xs text-muted-foreground">Payments waiting</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">{summary.count}</p>
              </div>
              <div className="rounded-xl border p-3">
                <p className="text-xs text-muted-foreground">Next release</p>
                <p className="mt-1 text-sm font-semibold">{fmtMyDateTime(summary.nextReleaseAt)}</p>
              </div>
            </div>
            <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
              Sales are held for the grace period{typicalHoldDays != null ? ` (${typicalHoldDays} day${typicalHoldDays === 1 ? "" : "s"})` : ""} before they become
              available. This schedule shows exactly when each payment releases.
            </p>
          </CardContent>
        </Card>
      </section>

      {/* release schedule list */}
      <section aria-label="Pending payments">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Pending payments</CardTitle>
          </CardHeader>
          <CardContent>
            {releases.length === 0 ? (
              <EmptyState
                title="No pending payments"
                hint="All matured sales are already in your available balance 🎉"
                icon={<ArrowDownToLine className="h-8 w-8" />}
              />
            ) : (
              <div
                className="max-h-[480px] space-y-2 overflow-y-auto pr-1 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent"
              >
                {releases.map((row) => {
                  const badge = releaseLabel(row.availableAt);
                  const pct = holdProgressPct(row);
                  const close = pct >= 90 || new Date(row.availableAt).getTime() - Date.now() < 24 * 3600000;
                  return (
                    <button
                      key={`${row.orderId}-${row.availableAt}`}
                      type="button"
                      onClick={() => onNavigate({ view: "orders", orderId: row.orderId })}
                      aria-label={`Order ${row.orderNumber}, ${formatMinor(row.amountMinor)}, ${badge.text} — open order`}
                      className="block w-full rounded-xl border p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{row.orderNumber}</span>
                        <StatusChip status={row.orderStatus} />
                        <span className="ml-auto text-sm font-semibold tabular-nums text-emerald-600">
                          +{formatMinor(row.amountMinor)}
                        </span>
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>Paid {fmtDate(row.paidAt)}</span>
                        <span>Releases {fmtMyDateTime(row.availableAt)}</span>
                        <span className={cn("ml-auto rounded-full border px-2 py-0.5 text-[11px] font-semibold", badge.className)}>
                          {badge.text}
                        </span>
                      </span>
                      <span className="mt-2 block h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
                        <span
                          className={cn("block h-full rounded-full transition-[width]", close ? "bg-emerald-500" : "bg-amber-500")}
                          style={{ width: `${pct}%` }}
                        />
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {loadMoreError ? (
              <p className="mt-3 text-xs text-rose-600" role="alert">
                {loadMoreError}
              </p>
            ) : null}

            {hasMore ? (
              <div className="mt-4 flex justify-center">
                <Button variant="outline" className="min-h-[44px] gap-2" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Load more ({summary.count - releases.length} remaining)
                </Button>
              </div>
            ) : null}

            {releases.length > 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Click any payment to open its order. Released amounts move to your available balance automatically — request a payout from the Overview tab.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
