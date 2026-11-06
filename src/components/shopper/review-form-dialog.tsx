"use client";
// ============================================================================
// Shopper — REVIEW FORM DIALOG (rewards work order §4).
// Shared by the PDP ("Write a review" CTA for eligible verified buyers) and
// the Me-hub review management view (to-review list). Submits through the
// REAL verified-purchase endpoint
//   POST /api/sf/{store}/products/{product}/reviews
// which enforces eligibility, dedupe, sanitization and the exactly-once
// RM0.05-equivalent membership reward server-side. This component NEVER
// asserts verified-purchase status itself — the badge comes from the backend.
// ============================================================================
import { useEffect, useState } from "react";
import { Loader2, Star, BadgeCheck, Coins } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { postJson, patchJson, ApiFail } from "./ui-bits";

const STAR_LABELS = ["Very poor", "Poor", "Average", "Good", "Excellent"] as const;
const REWARD_POINTS = 5; // display copy only — the server is authoritative

/** Edit mode payload — PATCHes MY pending review (no reward interaction). */
export type EditableReviewT = {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
};

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

  // Reset the form each time the dialog opens (edit mode hydrates its values).
  useEffect(() => {
    if (open) {
      setRating(edit?.rating ?? 0);
      setHover(0);
      setTitle(edit?.title ?? "");
      setBody(edit?.body ?? "");
      setBusy(false);
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
    setBusy(true);
    try {
      if (edit) {
        // EDIT path — pending-only, budgeted, audited; NEVER touches rewards.
        await patchJson<{ id: string; editsRemaining: number }>(`/api/me/reviews/${encodeURIComponent(edit.id)}`, {
          rating,
          title: title.trim() || null,
          body: trimmedBody || null,
        });
        toast.success("Review updated", { description: "Your pending review was edited — it is still awaiting approval." });
      } else {
        const res = await postJson<{ id: string; status: string; reward: { points: number } }>(
          `/api/sf/${encodeURIComponent(storeSlug)}/products/${encodeURIComponent(productSlug)}/reviews`,
          { rating, title: title.trim() || undefined, body: trimmedBody || undefined }
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

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-left">{edit ? "Edit your review" : "Write a review"}</DialogTitle>
          <DialogDescription className="text-left">
            {edit
              ? "Pending reviews can be edited before moderation — your reward is unaffected."
              : "Honest feedback helps other buyers — every star level earns the same reward."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* product context */}
          <div className="flex items-center gap-3 rounded-xl border bg-muted/40 p-3">
            {productImage ? (
              <img src={productImage} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" loading="lazy" />
            ) : null}
            <div className="min-w-0">
              <p className="line-clamp-1 text-sm font-semibold">{productTitle}</p>
              {orderNumber ? (
                <p className="text-xs text-muted-foreground">Purchase {orderNumber} · verified buyer</p>
              ) : (
                <p className="flex items-center gap-1 text-xs text-emerald-600">
                  <BadgeCheck className="h-3 w-3" aria-hidden="true" /> Verified purchase
                </p>
              )}
            </div>
          </div>

          {/* star picker — REQUIRED */}
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">
              Your rating <span className="text-rose-500" aria-hidden="true">*</span>
            </legend>
            <div className="flex items-center gap-1" role="radiogroup" aria-label="Star rating">
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
                    className="flex h-11 w-11 items-center justify-center rounded-lg transition-transform hover:scale-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
                  >
                    <Star
                      className={cn("h-7 w-7 transition-colors", active ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40")}
                      aria-hidden="true"
                    />
                  </button>
                );
              })}
              <span className="ml-2 min-w-[86px] text-sm font-medium text-muted-foreground" aria-live="polite">
                {hover || rating ? STAR_LABELS[(hover || rating) - 1] : ""}
              </span>
            </div>
          </fieldset>

          {/* optional title */}
          <div className="space-y-1.5">
            <label htmlFor="review-title" className="text-sm font-semibold">
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

          {/* optional body */}
          <div className="space-y-1.5">
            <label htmlFor="review-body" className="text-sm font-semibold">
              Your review <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Textarea
              id="review-body"
              maxLength={2000}
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What did you like or dislike? How was the quality and delivery?"
            />
            <p className="text-right text-[11px] text-muted-foreground">{body.length}/2000</p>
          </div>

          {/* reward disclosure (submission only — edits never re-credit) */}
          {edit ? null : (
            <div className="flex items-center gap-2 rounded-lg bg-teal-50 px-3 py-2 text-xs text-teal-800 dark:bg-teal-950/40 dark:text-teal-300">
              <Coins className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                Earn <strong>{REWARD_POINTS} membership points (≈ RM0.05)</strong> for this review — same reward for any star
                level, added once your submission is accepted.
              </span>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)} className="min-h-[44px]">
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || rating === 0} className="min-h-[44px] bg-brand-gradient text-white hover:brightness-110">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {edit ? "Save changes" : "Submit review"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
