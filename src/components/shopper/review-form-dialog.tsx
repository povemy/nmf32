"use client";
// ============================================================================
// Shopper — REVIEW FORM DIALOG.
// Shared by the PDP ("Write a review" CTA for eligible verified buyers) and
// the Me-hub review management view (to-review list). Submits through the
// REAL verified-purchase endpoint
//   POST /api/sf/{store}/products/{product}/reviews
// which enforces eligibility, dedupe, sanitization and the exactly-once
// RM0.05-equivalent membership reward server-side. This component NEVER
// asserts verified-purchase status itself — the badge comes from the backend.
//
// Layout (buyer work order): mobile-first card layout modelled on the Shopee
// "Rate Product" screen — header bar, reward strip, product card, star-rating
// card, review-text card and a docked action bar. Fully responsive: the star
// row uses flex-1 buttons (never a fixed 330px min-width), so the dialog can
// no longer overflow a 360px phone screen. All accents ride the NOMOFEE
// brand palette (brand gradient CTA, gold stars).
// ============================================================================
import { useEffect, useState } from "react";
import { Loader2, Star, BadgeCheck, Coins, ShieldAlert, Package, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { detectReviewSubmissionThreat } from "@/lib/review-text";
import { postJson, patchJson, ApiFail } from "./ui-bits";
import type { MeSubmittedReview, ReviewEditBody, ReviewEditData, ReviewSubmitBody, ReviewSubmitData } from "@/lib/types/api-contract";

const STAR_LABELS = ["Very poor", "Poor", "Average", "Good", "Excellent"] as const;
const REWARD_POINTS = 5; // display copy only — the server is authoritative

/** Edit mode payload — PATCHes MY pending review (no reward interaction).
 *  UI-minimized projection of the contract's MeSubmittedReview row. */
export type EditableReviewT = Pick<MeSubmittedReview, "id" | "rating" | "title" | "body">;

export function ReviewFormDialog({
  open,
  onOpenChange,
  storeSlug,
  productSlug,
  productTitle,
  productImage,
  orderNumber,
  edit,
  onSubmitted,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  storeSlug: string;
  productSlug: string;
  productTitle: string;
  productImage?: string | null;
  /** Context line in the Me-hub variant (which purchase this review belongs to). */
  orderNumber?: string;
  /** When set, the dialog EDITS this pending review (PATCH) instead of submitting a new one. */
  edit?: EditableReviewT | null;
  /** Fired after the backend accepts the review (caller refreshes its data). */
  onSubmitted?: () => void;
}) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  // Unsafe-content warning (buyer work order): { pattern } when the client
  // pre-check OR the server (UNSAFE_CONTENT) flagged scripts/HTML in the text.
  // Rendered as a popup the shopper must acknowledge before retrying.
  const [unsafe, setUnsafe] = useState<{ pattern: string } | null>(null);

  // Reset the form each time the dialog opens (edit mode hydrates its values).
  useEffect(() => {
    if (open) {
      setRating(edit?.rating ?? 0);
      setHover(0);
      setTitle(edit?.title ?? "");
      setBody(edit?.body ?? "");
      setBusy(false);
      setUnsafe(null);
    }
  }, [open, edit]);

  const submit = async () => {
    if (busy) return;
    if (rating < 1 || rating > 5) {
      toast.error("Please choose a star rating", { description: "1–5 stars is required before submitting." });
      return;
    }
    const trimmedBody = body.trim();
    if (trimmedBody.length > 0 && trimmedBody.length < 10) {
      toast.error("Review text is too short", { description: "Write at least 10 characters, or leave the text empty." });
      return;
    }
    // ORCHESTRATOR PRE-CHECK (lib/review-text.ts — the SAME pure patterns the
    // server routes run): detect script/HTML/event-handler payloads BEFORE the
    // request and show the warning popup instead of storing anything.
    const threat = detectReviewSubmissionThreat({ title: title.trim() || null, body: trimmedBody || null });
    if (threat) {
      setUnsafe({ pattern: threat.pattern });
      return;
    }
    setBusy(true);
    try {
      if (edit) {
        // EDIT path — pending-only, budgeted, audited; NEVER touches rewards.
        const payload: ReviewEditBody = {
          rating,
          title: title.trim() || null,
          body: trimmedBody || null,
        };
        await patchJson<ReviewEditData>(`/api/me/reviews/${encodeURIComponent(edit.id)}`, payload);
        toast.success("Review updated", { description: "Your pending review was edited — it is still awaiting approval." });
      } else {
        const payload: ReviewSubmitBody = { rating, title: title.trim() || undefined, body: trimmedBody || undefined };
        const res = await postJson<ReviewSubmitData>(
          `/api/sf/${encodeURIComponent(storeSlug)}/products/${encodeURIComponent(productSlug)}/reviews`,
          payload
        );
        toast.success("Review submitted — pending approval", {
          description: `Thank you for the honest feedback! ${res.reward?.points ?? REWARD_POINTS} membership points (≈ RM0.05) were added to your rewards.`,
          duration: 6000,
        });
      }
      onOpenChange(false);
      onSubmitted?.();
    } catch (e) {
      if (e instanceof ApiFail) {
        if (e.code === "UNSAFE_CONTENT") {
          // Server-side orchestrator verdict — same popup as the pre-check.
          setUnsafe({ pattern: "scripts or HTML code" });
          return;
        }
        if (e.code === "REVIEW_ALREADY_EXISTS") {
          toast.info("You already reviewed this product", { description: "One review per product per account." });
          onOpenChange(false);
          onSubmitted?.();
        } else if (e.code === "VERIFIED_PURCHASE_REQUIRED") {
          toast.error("Only verified buyers can review", { description: "Your eligible order for this product wasn't found." });
        } else if (e.code === "SELLER_SELF_REVIEW") {
          toast.error("Sellers cannot review their own products");
        } else if (e.code === "NOT_EDITABLE" || e.code === "EDIT_LIMIT") {
          toast.error("This review can no longer be edited", { description: e.message });
          onOpenChange(false);
          onSubmitted?.();
        } else {
          toast.error(e.message || "Could not submit the review");
        }
      } else {
        toast.error(e instanceof Error ? e.message : "Could not submit the review");
      }
    } finally {
      setBusy(false);
    }
  };

  const starLabel = hover || rating ? STAR_LABELS[(hover || rating) - 1] : "";

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[92dvh] gap-0 overflow-y-auto overflow-x-hidden rounded-2xl p-0 sm:max-w-lg"
      >
        {/* ---- header bar ---------------------------------------------- */}
        <div className="flex items-center justify-between gap-3 border-b border-slate-200/70 px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            <DialogTitle className="truncate text-left text-base font-bold text-slate-900 dark:text-slate-100">
              {edit ? "Edit your review" : "Rate product"}
            </DialogTitle>
            <DialogDescription className="pt-0.5 text-left text-xs">
              {edit
                ? "Pending reviews can be edited before moderation — your reward is unaffected."
                : "Honest feedback helps other buyers — every star level earns the same reward."}
            </DialogDescription>
          </div>
          <button
            type="button"
            onClick={() => !busy && onOpenChange(false)}
            aria-label="Close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-3 px-3 py-3 sm:px-5 sm:py-4">
          {/* ---- reward strip (submission only — edits never re-credit) -- */}
          {edit ? null : (
            <div className="flex items-center gap-2.5 rounded-xl bg-brand-gradient-soft px-3.5 py-2.5 text-xs leading-snug font-semibold text-teal-800 dark:text-teal-300">
              <Coins className="h-5 w-5 shrink-0 text-teal-600 dark:text-teal-400" aria-hidden="true" />
              <span>
                Earn <strong>{REWARD_POINTS} membership points (≈ RM0.05)</strong> for this review — same reward for any
                star level, credited once accepted.
              </span>
            </div>
          )}

          {/* ---- product card ------------------------------------------- */}
          <div className="rounded-xl border border-slate-200/80 bg-card p-3 shadow-soft">
            <div className="flex items-center gap-3">
              {productImage ? (
                <img src={productImage} alt="" className="h-14 w-14 shrink-0 rounded-lg border border-slate-200/70 object-cover" loading="lazy" />
              ) : (
                <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-muted" aria-hidden="true">
                  <Package className="h-5 w-5 text-muted-foreground" />
                </span>
              )}
              <div className="min-w-0">
                <p className="line-clamp-2 text-sm font-bold leading-snug">{productTitle}</p>
                <p className="flex items-center gap-1 pt-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                  <BadgeCheck className="h-3 w-3 shrink-0" aria-hidden="true" />
                  Verified purchase{orderNumber ? ` · ${orderNumber}` : ""}
                </p>
              </div>
            </div>
          </div>

          {/* ---- star rating card (REQUIRED) ---------------------------- */}
          <div className="rounded-xl border border-slate-200/80 bg-card p-4 shadow-soft">
            <p className="text-sm font-bold text-slate-900 dark:text-slate-100">
              Rate product <span className="text-rose-500" aria-hidden="true">*</span>
            </p>
            {/* flex-1 star buttons: the row always fits the dialog width (no
                fixed min-width → no horizontal scrollbar on 360px screens). */}
            <div className="flex justify-center gap-1 pt-2" role="radiogroup" aria-label="Star rating">
              {[1, 2, 3, 4, 5].map((n) => {
                const active = (hover || rating) >= n;
                return (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={rating === n}
                    aria-label={`${n} star${n === 1 ? "" : "s"} — ${STAR_LABELS[n - 1]}`}
                    onMouseEnter={() => setHover(n)}
                    onMouseLeave={() => setHover(0)}
                    onClick={() => setRating(n)}
                    className="flex h-11 max-w-14 flex-1 touch-manipulation items-center justify-center rounded-lg transition-transform hover:scale-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
                  >
                    <Star
                      className={cn("h-8 w-8 transition-colors sm:h-9 sm:w-9", active ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40")}
                      aria-hidden="true"
                    />
                  </button>
                );
              })}
            </div>
            <p className="min-h-4 pt-1.5 text-center text-xs font-medium text-muted-foreground" aria-live="polite">
              {starLabel}
            </p>
          </div>

          {/* ---- review text card --------------------------------------- */}
          <div className="space-y-3 rounded-xl border border-slate-200/80 bg-card p-4 shadow-soft">
            <div className="space-y-1.5">
              <label htmlFor="review-title" className="text-sm font-bold text-slate-900 dark:text-slate-100">
                Title <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <Input
                id="review-title"
                maxLength={120}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Sum it up in a few words"
                autoComplete="off"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="review-body" className="text-sm font-bold text-slate-900 dark:text-slate-100">
                Your review <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <Textarea
                id="review-body"
                maxLength={2000}
                rows={6}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={"Share your experience with this product…\n\nQuality: How was it?\nValue: Worth the price?"}
                className="resize-none rounded-xl border-0 bg-muted/60 text-sm placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-teal-500/50 dark:bg-muted/30"
              />
              <p className="text-right text-[11px] tabular-nums text-muted-foreground">{body.length}/2000</p>
            </div>
          </div>
        </div>

        {/* ---- docked action bar ---------------------------------------- */}
        <div className="sticky bottom-0 border-t border-slate-200/70 bg-background/95 px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:px-5">
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
              className="min-h-[44px] flex-1"
            >
              Cancel
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={busy || rating === 0}
              className="min-h-[44px] flex-[2] bg-brand-gradient-deep text-base font-bold text-white hover:brightness-110"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {edit ? "Save changes" : "Submit"}
            </Button>
          </div>
        </div>
      </DialogContent>

      {/* Unsafe-content warning popup — client pre-check or server 400
          UNSAFE_CONTENT. Acknowledge → back to the form with the text intact
          so the shopper can strip the flagged markup and resubmit. */}
      <AlertDialog open={unsafe != null} onOpenChange={(v) => !v && setUnsafe(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-left">
              <ShieldAlert className="h-5 w-5 shrink-0 text-rose-600" aria-hidden="true" />
              Reviews must be plain text
            </AlertDialogTitle>
            <AlertDialogDescription className="text-left">
              We detected <strong>{unsafe?.pattern}</strong> in your review. Scripts and HTML code are not allowed — they are
              automatically removed from published reviews. Please remove them and submit plain text describing your
              experience with the product.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction className="min-h-[44px] bg-teal-700 text-white hover:bg-teal-800">Edit my review</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
