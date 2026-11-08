import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { recomputeProductRating, reviewsSchemaReady } from "@/lib/reviews";
import { reverseReviewReward } from "@/lib/review-rewards";
import { bustPublicCacheSafe, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";
import type { AdminReviewModerateBody, AdminReviewModerateData } from "@/lib/types/api-contract";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/reviews/[id] { action: "approve" | "reject", reason?, reverseReward? }
// (RBAC reviews.moderate) — moderate a pending review (Task B1 + rewards
// work order). Approve → status "published"; reject → "rejected".
//
// The transition is a CONDITIONAL updateMany on status:"pending": a review
// can only ever be moderated once — double-clicks, retried requests and
// racing moderators all converge on 409 ALREADY_MODERATED instead of flipping
// a final state back and forth. After any successful transition the product's
// rating aggregates are recomputed from PUBLISHED reviews only (approve pulls
// the review in, reject keeps it out), keeping the invariant that
// pending/rejected rows never feed ratingAvg/ratingCount.
//
// REWARDS (work order §5/§8):
//   • approve NEVER credits anything — the RM0.05-equivalent reward was
//     already credited exactly once at submission (transaction + UNIQUE
//     reviewId), so approval can never duplicate it;
//   • reject optionally REVERSES the reward when the flag is set — reserved
//     for proven fraud (incentive farming, fabricated content). The reversal
//     is conditional (idempotent) and audited with the admin identity and a
//     REQUIRED reason. A plain quality rejection leaves the honest-submission
//     reward intact, per policy.
export const POST = handle(async (req: Request, ctx: Ctx) => {
  rateLimit(req, "admin-reviews", 60); // light guard on moderation mutations
  const admin = await requireCap("reviews.moderate");
  // Pre-migration guard (Phase 1 B1): until 20261101000001 is applied there
  // can be no pending reviews to moderate anyway — clean 503, not a raw 500.
  if (!(await reviewsSchemaReady())) {
    throw new ApiError(503, "REVIEWS_NOT_MIGRATED", "Review moderation awaits a pending database migration");
  }
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as AdminReviewModerateBody;

  const action = String(body.action ?? "").trim().toLowerCase();
  if (action !== "approve" && action !== "reject") {
    throw new ApiError(400, "VALIDATION", "action must be approve | reject");
  }
  const toStatus = action === "approve" ? "published" : "rejected";

  // Reject params: free-text reason (≤500) + optional reward reversal.
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  const reverseReward = body.reverseReward === true;
  if (reverseReward && action !== "reject") {
    throw new ApiError(400, "VALIDATION", "reverseReward only applies to reject");
  }
  if (reverseReward && reason.length < 3) {
    throw new ApiError(400, "VALIDATION", "A reversal reason is required when reversing the membership reward (proven-fraud record)");
  }

  const review = await db.review.findUnique({
    where: { id },
    select: { id: true, productId: true, status: true, shopperId: true },
  });
  if (!review) throw new ApiError(404, "NOT_FOUND", "Review not found");

  const res = await db.review.updateMany({
    where: { id, status: "pending" },
    data: { status: toStatus },
  });
  if (res.count === 0) {
    // Already moderated (or raced) — current status is safe to surface to an
    // authenticated moderator, unlike shopper-facing eligibility errors.
    throw new ApiError(409, "ALREADY_MODERATED", `Review is no longer pending (current status: ${review.status})`);
  }

  // Reward reversal — AFTER the review transition succeeded, conditional +
  // idempotent (a second attempt finds reversedAt set and no-ops).
  let rewardReversed = false;
  if (action === "reject" && reverseReward) {
    rewardReversed = await reverseReviewReward({ reviewId: id, reason, actorId: admin.id, actorLabel: admin.email });
  }

  const { ratingAvg, ratingCount } = await recomputeProductRating(review.productId);

  await logActivity({
    actorType: "admin",
    actorId: admin.id,
    actorLabel: admin.email,
    action: "admin.review.moderated",
    entityType: "review",
    entityId: id,
    meta: {
      reviewId: id,
      action,
      reason: reason || undefined,
      rewardReversed,
      productId: review.productId,
      status: toStatus,
      ratingAvg,
      ratingCount,
    },
  });

  bustPublicCacheSafe(PUBLIC_CACHE_TAGS.reviews);
  const payload: AdminReviewModerateData = { id, status: toStatus, ratingAvg, ratingCount, rewardReversed };
  return ok(payload);
});
