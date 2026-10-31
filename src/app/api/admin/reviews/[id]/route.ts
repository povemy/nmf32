import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { recomputeProductRating, reviewsSchemaReady } from "@/lib/reviews";
import { bustPublicCacheSafe, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/reviews/[id] { action: "approve" | "reject" } (RBAC reviews.moderate)
// — moderate a pending review (Task B1). Approve → status "published"; reject →
// "rejected". The transition is a CONDITIONAL updateMany on status:"pending":
// a review can only ever be moderated once — double-clicks, retried requests
// and racing moderators all converge on 409 ALREADY_MODERATED instead of
// flipping a final state back and forth. After any successful transition the
// product's rating aggregates are recomputed from PUBLISHED reviews only
// (approve pulls the review in, reject keeps it out), keeping the invariant
// that pending/rejected rows never feed ratingAvg/ratingCount.
export const POST = handle(async (req: Request, ctx: Ctx) => {
  rateLimit(req, "admin-reviews", 60); // light guard on moderation mutations
  const admin = await requireCap("reviews.moderate");
  // Pre-migration guard (Phase 1 B1): until 20261101000001 is applied there
  // can be no pending reviews to moderate anyway — clean 503, not a raw 500.
  if (!(await reviewsSchemaReady())) {
    throw new ApiError(503, "REVIEWS_NOT_MIGRATED", "Review moderation awaits a pending database migration");
  }
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const action = String(body.action ?? "").trim().toLowerCase();
  if (action !== "approve" && action !== "reject") {
    throw new ApiError(400, "VALIDATION", "action must be approve | reject");
  }
  const toStatus = action === "approve" ? "published" : "rejected";

  const review = await db.review.findUnique({
    where: { id },
    select: { id: true, productId: true, status: true },
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

  const { ratingAvg, ratingCount } = await recomputeProductRating(review.productId);

  await logActivity({
    actorType: "admin",
    actorId: admin.id,
    actorLabel: admin.email,
    action: "admin.review.moderated",
    entityType: "review",
    entityId: id,
    meta: { reviewId: id, action, productId: review.productId, status: toStatus, ratingAvg, ratingCount },
  });

  bustPublicCacheSafe(PUBLIC_CACHE_TAGS.reviews);
  return ok({ id, status: toStatus, ratingAvg, ratingCount });
});
