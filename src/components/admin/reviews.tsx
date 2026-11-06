"use client";
// ============================================================================
// REVIEW MODERATION (rewards work order §8) — the admin console for the
// verified-purchase review queue. Consumes the REAL moderation API:
//   GET  /api/admin/reviews?status=&page=        (RBAC reviews.moderate)
//   POST /api/admin/reviews/[id] { action, reason?, reverseReward? }
// Every row carries the moderator context needed to VERIFY the purchase claim
// before deciding: product + store, shopper identity, the frozen order number
// and its status, the star rating + text, and the membership reward state.
// Approve publishes (aggregates recompute server-side); reject optionally
// reverses the reward for proven fraud — always with an auditable reason.
// ============================================================================
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Star, BadgeCheck, Coins, RotateCcw, ShieldAlert } from "lucide-react";
import { useApi, apiSend } from "./use-api";
import { qs } from "./nav";
import { EmptyState, ErrorState, PageHeader, Pager, StatusChip, fmtDate } from "./ui-bits";
import { cn } from "@/lib/utils";

type AdminReviewRow = {
  id: string;
  productId: string;
  orderId: string | null;
  customerName: string;
  rating: number;
  // Flagged server-side when the text carries a script/HTML payload — the
  // moderator still sees the RAW text (to judge/reject) plus this badge.
  unsafeContent?: boolean;
  title: string | null;
  body: string | null;
  reply: string | null;
  status: string;
  createdAt: string;
  product: { id: string; title: string; slug: string; store: { id: string; name: string; slug: string } };
  shopper: { id: string; email: string; fullName: string } | null;
  order: { id: string; orderNumber: string; status: string } | null;
  reward: { id: string; points: number; reversed: boolean; reversalReason: string | null } | null;
};

const STATUS_TABS = [
  { key: "pending", label: "Pending" },
  { key: "published", label: "Published" },
  { key: "rejected", label: "Rejected" },
  { key: "", label: "All" },
] as const;

function StarRow({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} className={cn("h-3.5 w-3.5", n <= rating ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30")} aria-hidden="true" />
      ))}
    </span>
  );
}

export function ReviewsModerationView() {
  const [tab, setTab] = useState<string>("pending");
  const [page, setPage] = useState(1);
  const url = useMemo(() => `/api/admin/reviews${qs({ status: tab || undefined, page, size: "10" })}`, [tab, page]);
  const { data, meta, error, loading, refetch } = useApi<AdminReviewRow[]>(url);
  const rows = data ?? [];

  const [approveTarget, setApproveTarget] = useState<AdminReviewRow | null>(null);
  const [rejectTarget, setRejectTarget] = useState<AdminReviewRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [reverseReward, setReverseReward] = useState(false);
  const [busy, setBusy] = useState(false);

  const moderate = async (
    r: AdminReviewRow,
    action: "approve" | "reject",
    opts?: { reason?: string; reverseReward?: boolean }
  ) => {
    setBusy(true);
    try {
      const res = await apiSend<{ id: string; status: string; ratingAvg: number; ratingCount: number; rewardReversed: boolean }>(
        `/api/admin/reviews/${r.id}`,
        "POST",
        { action, ...(opts?.reason ? { reason: opts.reason } : {}), ...(opts?.reverseReward ? { reverseReward: true } : {}) }
      );
      toast.success(
        action === "approve" ? "Review published" : "Review rejected",
        {
          description:
            action === "approve"
              ? `Product rating is now ${res.ratingAvg.toFixed(1)}★ from ${res.ratingCount} published review${res.ratingCount === 1 ? "" : "s"}.`
              : opts?.reverseReward
                ? `Reward reversed (${res.rewardReversed ? "done" : "already reversed"}). Aggregates updated.`
                : "Aggregates updated. The submission reward is retained.",
        }
      );
      setApproveTarget(null);
      setRejectTarget(null);
      setRejectReason("");
      setReverseReward(false);
      void refetch();
    } catch (e) {
      toast.error(`Failed to ${action} review`, { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Review Moderation"
        description="Verified-purchase reviews awaiting publication — inspect the buyer, the product and the backing order before deciding."
        actions={
          <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0" onClick={() => void refetch()} disabled={loading}>
            Refresh
          </Button>
        }
      />

      {/* status tabs */}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Review status filter">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key || "all"}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => {
              setTab(t.key);
              setPage(1);
            }}
            className={cn(
              "min-h-[36px] rounded-full border px-3.5 text-xs font-bold transition-all",
              tab === t.key
                ? "border-transparent bg-teal-700 text-white"
                : "border-border bg-card text-muted-foreground hover:border-teal-400 hover:text-teal-700"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error ? (
        <Card className="py-0">
          <CardContent className="p-4">
            <ErrorState message={error} onRetry={() => void refetch()} />
          </CardContent>
        </Card>
      ) : loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-36 animate-pulse rounded-xl border bg-muted/40" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card className="py-0">
          <CardContent className="p-4">
            <EmptyState
              title={tab === "pending" ? "No pending reviews" : `No ${tab || "matching"} reviews`}
              hint="Verified-buyer submissions land here after they pass the purchase-eligibility gate."
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <ul className="space-y-3">
            {rows.map((r) => (
              <li key={r.id} className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StarRow rating={r.rating} />
                      <StatusChip status={r.status} />
                      {r.order ? (
                        <Badge variant="outline" className="gap-1 border-emerald-200 bg-emerald-50 text-emerald-700">
                          <BadgeCheck className="h-3 w-3" aria-hidden="true" />
                          Verified purchase · {r.order.orderNumber} ({r.order.status.replace(/_/g, " ")})
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
                          No order link (legacy)
                        </Badge>
                      )}
                      {r.unsafeContent ? (
                        <Badge variant="outline" className="gap-1 border-rose-200 bg-rose-50 text-rose-600">
                          <ShieldAlert className="h-3 w-3" aria-hidden="true" />
                          Unsafe content — blanked publicly
                        </Badge>
                      ) : null}
                      {r.reward ? (
                        <Badge variant="outline" className={cn("gap-1", r.reward.reversed ? "border-rose-200 bg-rose-50 text-rose-600" : "border-teal-200 bg-teal-50 text-teal-700")}>
                          <Coins className="h-3 w-3" aria-hidden="true" />
                          {r.reward.reversed ? `reward reversed (${r.reward.points} pts)` : `reward credited (+${r.reward.points} pts)`}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="pt-1.5 text-sm font-semibold">{r.title ?? <span className="text-muted-foreground">(no title)</span>}</p>
                    {r.body ? <p className="whitespace-pre-line pt-0.5 text-sm text-foreground/85">{r.body}</p> : null}
                    {r.reply ? (
                      <p className="mt-1.5 rounded-lg border-l-2 border-teal-600 bg-muted/60 p-2 text-xs">
                        <span className="font-semibold text-teal-800">Seller replied:</span> {r.reply}
                      </p>
                    ) : null}
                  </div>
                  {r.status === "pending" ? (
                    <div className="flex shrink-0 gap-2">
                      <Button size="sm" className="min-h-[36px]" disabled={busy} onClick={() => setApproveTarget(r)}>
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-h-[36px] border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                        disabled={busy}
                        onClick={() => {
                          setRejectTarget(r);
                          setRejectReason("");
                          setReverseReward(false);
                        }}
                      >
                        Reject
                      </Button>
                    </div>
                  ) : null}
                </div>

                {/* moderator context: who wrote it, for which product, backed by which order */}
                <div className="mt-3 grid gap-2 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground sm:grid-cols-3">
                  <p>
                    <span className="font-semibold text-foreground">Product:</span> {r.product.title}
                    <br />
                    <span className="font-semibold text-foreground">Store:</span> {r.product.store.name}
                  </p>
                  <p>
                    <span className="font-semibold text-foreground">Buyer:</span> {r.shopper ? `${r.shopper.fullName} (${r.shopper.email})` : r.customerName}
                    <br />
                    <span className="font-semibold text-foreground">Display name:</span> {r.customerName}
                  </p>
                  <p>
                    <span className="font-semibold text-foreground">Submitted:</span> {fmtDate(r.createdAt)}
                    <br />
                    <span className="font-semibold text-foreground">Review ID:</span> <span className="font-mono">{r.id.slice(0, 12)}…</span>
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <Pager page={page} size={meta?.size ?? 10} total={meta?.total ?? 0} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} />
        </>
      )}

      {/* approve confirmation */}
      <Dialog open={approveTarget != null} onOpenChange={(v) => !v && setApproveTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Publish this review?</DialogTitle>
            <DialogDescription>
              Publishing makes it public on the product page and folds its rating into the product average. The membership
              reward was already credited at submission — approval never re-credits.
            </DialogDescription>
          </DialogHeader>
          {approveTarget ? (
            <div className="space-y-2 rounded-lg border bg-muted/40 p-3 text-sm">
              <div className="flex items-center gap-2">
                <StarRow rating={approveTarget.rating} />
                <span className="font-semibold">{approveTarget.product.title}</span>
              </div>
              {approveTarget.title ? <p className="text-sm font-medium">{approveTarget.title}</p> : null}
              {approveTarget.body ? <p className="text-xs text-foreground/80">{approveTarget.body}</p> : null}
            </div>
          ) : null}
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="outline" disabled={busy} onClick={() => setApproveTarget(null)} className="min-h-[44px]">
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => approveTarget && void moderate(approveTarget, "approve")} className="min-h-[44px]">
              Publish review
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* reject with optional auditable reward reversal */}
      <Dialog open={rejectTarget != null} onOpenChange={(v) => !v && setRejectTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject this review?</DialogTitle>
            <DialogDescription>
              Rejection keeps the review out of the public product page and rating aggregates. The submission reward is
              retained by default — reverse it ONLY for proven fraud (the reversal is permanently audited with your identity).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="reject-reason">Reason (optional unless reversing the reward)</Label>
              <Textarea
                id="reject-reason"
                rows={3}
                maxLength={500}
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="e.g. fabricated experience, incentive farming, abusive content"
              />
            </div>
            {rejectTarget?.reward && !rejectTarget.reward.reversed ? (
              <label className="flex items-start gap-2.5 rounded-lg border border-rose-200 bg-rose-50/60 p-3" htmlFor="reverse-reward">
                <Checkbox id="reverse-reward" checked={reverseReward} onCheckedChange={(v) => setReverseReward(v === true)} className="mt-0.5" />
                <span className="text-xs">
                  <span className="block font-semibold text-rose-700">
                    <RotateCcw className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                    Reverse the membership reward (−{rejectTarget.reward.points} pts)
                  </span>
                  <span className="block pt-0.5 text-rose-600/90">
                    For proven fraud only. Requires a reason; recorded in the audit log with your admin identity.
                  </span>
                </span>
              </label>
            ) : null}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="outline" disabled={busy} onClick={() => setRejectTarget(null)} className="min-h-[44px]">
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy || (reverseReward && rejectReason.trim().length < 3)}
              onClick={() => rejectTarget && void moderate(rejectTarget, "reject", { reason: rejectReason.trim() || undefined, reverseReward })}
              className="min-h-[44px]"
            >
              Reject review
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
