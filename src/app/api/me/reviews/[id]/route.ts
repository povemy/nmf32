import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { sanitizeReviewInput, reviewsSchemaReady } from "@/lib/reviews";
import { detectReviewSubmissionThreat } from "@/lib/review-text";
import type { ReviewEditBody, ReviewEditData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

const EDIT_LOG_ACTION = "shopper.review.edited";
// Buyer work order: a submitted review can be amended exactly ONCE while it
// is still pending moderation (the Me-hub chip shows "1 left" before the
// first edit, then the review freezes until moderation completes).
const MAX_EDITS = 1;

// PATCH /api/me/reviews/[id] — edit MY OWN review while it is still PENDING.
//
// Edit rules (rewards work order §4.D):
//   • ownership: the review must belong to the signed-in shopper (404 —
//     another shopper's review id is indistinguishable from "not found");
//   • window: only status "pending" — once an admin has published or rejected
//     the review, the moderation decision is final and the text is frozen;
//   • budget: at most MAX_EDITS edits, counted from the ActivityLog audit
//     trail (the full edit history is preserved there);
//   • rewards: NO reward interaction whatsoever — the RM0.05-equivalent was
//     credited exactly once at submission and an edit can never re-credit it
//     (MembershipReward.reviewId is UNIQUE; this route never touches it).
//   • unsafe content: same guard as submission (lib/review-text.ts) — edits
//     are a re-submission vector, so scripts/HTML are rejected here too.
//
// The status flip race is closed with a CONDITIONAL updateMany on
// status:"pending" — a moderator decision landing mid-edit converges on 409
// instead of overwriting a final state.
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await requireShopper();
  if (!(await reviewsSchemaReady())) {
    throw new ApiError(503, "REVIEWS_NOT_MIGRATED", "Verified-purchase reviews await a pending database migration");
  }
  const { id } = await ctx.params;
  const raw = (await req.json().catch(() => ({}))) as ReviewEditBody;

  const review = await db.review.findFirst({
    where: { id, shopperId: me.id },
    select: { id: true, productId: true, status: true, rating: true, title: true, body: true, customerName: true },
  });
  if (!review) throw new ApiError(404, "NOT_FOUND", "Review not found");

  if (review.status !== "pending") {
    throw new ApiError(409, "NOT_EDITABLE", `This review was already ${review.status} — its content is frozen`);
  }

  const edits = await db.activityLog.count({ where: { action: EDIT_LOG_ACTION, entityId: review.id } });
  if (edits >= MAX_EDITS) {
    throw new ApiError(409, "EDIT_LIMIT", `A review can be edited at most ${MAX_EDITS} time${MAX_EDITS === 1 ? "" : "s"} while pending`);
  }

  // Merge semantics: omitted fields keep their current values; the same
  // hardened sanitizer as submission validates whatever IS provided.
  const merged = sanitizeReviewInput(
    {
      customerName: raw.customerName ?? review.customerName,
      rating: raw.rating ?? review.rating,
      title: raw.title ?? review.title,
      body: raw.body ?? review.body,
    },
    me.fullName
  );
  if (!merged.ok) throw new ApiError(400, "VALIDATION", merged.errors.join("; "));

  // Unsafe-content guard — same rule as submission: scripts/HTML/event
  // handlers are rejected with 400 UNSAFE_CONTENT so the dialog can show its
  // warning popup. An edit is also a (re)submission vector for payloads.
  const threat = detectReviewSubmissionThreat(merged.value);
  if (threat) {
    throw new ApiError(
      400,
      "UNSAFE_CONTENT",
      `Reviews must be plain text — ${threat.pattern} are not allowed. Please remove them and submit plain text.`
    );
  }

  // Conditional write: only a still-pending, still-mine row can update.
  const res = await db.review.updateMany({
    where: { id: review.id, shopperId: me.id, status: "pending" },
    data: {
      rating: merged.value.rating,
      title: merged.value.title,
      body: merged.value.body,
    },
  });
  if (res.count === 0) {
    throw new ApiError(409, "NOT_EDITABLE", "This review is no longer editable (moderation may have just completed)");
  }

  await logActivity({
    actorType: "shopper",
    actorId: me.id,
    actorLabel: me.email,
    action: EDIT_LOG_ACTION,
    entityType: "review",
    entityId: review.id,
    meta: { editNumber: edits + 1, rating: merged.value.rating, productId: review.productId },
  });

  const payload: ReviewEditData = { id: review.id, status: "pending", editsRemaining: MAX_EDITS - (edits + 1) };
  return ok(payload);
});
