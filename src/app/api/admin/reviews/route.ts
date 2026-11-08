import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { handle, okPaged, ApiError, getPagination } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { REVIEW_STATUSES, reviewsSchemaReady } from "@/lib/reviews";
import { detectReviewThreat } from "@/lib/review-text";
import type { AdminReviewsData } from "@/lib/types/api-contract";

// GET /api/admin/reviews?status=pending|published|rejected&productId=&page=&size=
// — the review moderation queue (Task B1). RBAC: reviews.moderate (same tier
// as products.moderate — superadmin/ops/moderator). Newest first; each row
// carries moderator context: product title + store name + shopper email (the
// review author) + the frozen eligible order, so a moderator can verify the
// purchase claim before approving.
export const GET = handle(async (req: NextRequest) => {
  await requireCap("reviews.moderate");
  // Pre-migration guard (Phase 1 B1): until 20261101000001 is applied the new
  // columns don't exist — answer a clean 503 rather than a raw 500.
  if (!(await reviewsSchemaReady())) {
    throw new ApiError(503, "REVIEWS_NOT_MIGRATED", "Review moderation awaits a pending database migration");
  }
  const url = new URL(req.url);
  const { page, size, skip, take } = getPagination(url);

  const status = url.searchParams.get("status");
  if (status && !REVIEW_STATUSES.includes(status as (typeof REVIEW_STATUSES)[number])) {
    throw new ApiError(400, "VALIDATION", `status must be one of: ${REVIEW_STATUSES.join(" | ")}`);
  }
  const productId = url.searchParams.get("productId");

  const where: Prisma.ReviewWhereInput = {
    ...(status ? { status } : {}),
    ...(productId ? { productId } : {}),
  };

  const [rows, total] = await Promise.all([
    db.review.findMany({
      where,
      include: {
        product: { select: { id: true, title: true, slug: true, store: { select: { id: true, name: true, slug: true } } } },
        shopper: { select: { id: true, email: true, fullName: true } },
        order: { select: { id: true, orderNumber: true, status: true } },
        reward: { select: { id: true, points: true, reversedAt: true, reversalReason: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    db.review.count({ where }),
  ]);

  const data: AdminReviewsData[] = rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    orderId: r.orderId,
    customerName: r.customerName,
    rating: r.rating,
    // Moderator context intentionally keeps the RAW text (the moderator must
    // see what was attempted to reject it) but is flagged so the queue UI can
    // badge it: detectReviewThreat === public display would auto-blank it.
    unsafeContent: detectReviewThreat(r.title) != null || detectReviewThreat(r.body) != null,
    title: r.title,
    body: r.body,
    reply: r.reply,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    product: {
      id: r.product.id,
      title: r.product.title,
      slug: r.product.slug,
      store: r.product.store,
    },
    shopper: r.shopper ? { id: r.shopper.id, email: r.shopper.email, fullName: r.shopper.fullName } : null,
    order: r.order ? { id: r.order.id, orderNumber: r.order.orderNumber, status: r.order.status } : null,
    reward: r.reward
      ? { id: r.reward.id, points: r.reward.points, reversed: r.reward.reversedAt != null, reversalReason: r.reward.reversalReason }
      : null,
  }));
  return okPaged(data, { page, size, total });
});
