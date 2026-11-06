import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { isEligibleOrder, ELIGIBLE_CANDIDATE_STATUSES, reviewsSchemaReady } from "@/lib/reviews";
import { sanitizeReviewTextForDisplay, wasReviewTextRemoved } from "@/lib/review-text";
import { summarizeShopperRewards } from "@/lib/review-rewards";
import { placeholderUrl } from "@/lib/placeholder";

export const dynamic = "force-dynamic";

const EDIT_LOG_ACTION = "shopper.review.edited";
const MAX_EDITS = 2;

// GET /api/me/reviews — the shopper's review-management surface:
//   • toReview  — eligible purchased products NOT yet reviewed (delivered /
//     completed / receipt-confirmed partial-refund lines, per-item refund
//     rules applied — the SAME server predicate the submission route enforces)
//   • submitted — my reviews with moderation status + reward state
//   • rewards   — membership ledger summary (net points, reversals, history)
//
// Eligibility is server-derived end to end: the button can only appear for
// products the backend itself certifies as reviewable.
export const GET = handle(async () => {
  const me = await requireShopper();
  if (!(await reviewsSchemaReady())) {
    throw new ApiError(503, "REVIEWS_NOT_MIGRATED", "Verified-purchase reviews await a pending database migration");
  }

  // 1) My reviews (for status display AND to exclude reviewed products from
  //    the to-review list — one review per buyer per product).
  const myReviews = await db.review.findMany({
    where: { shopperId: me.id },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      reward: { select: { points: true, reversedAt: true, reversalReason: true } },
      product: {
        select: {
          id: true,
          title: true,
          slug: true,
          status: true,
          store: { select: { id: true, name: true, slug: true, seller: { select: { email: true } } } },
          images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } },
        },
      },
    },
  });
  const reviewedProductIds = new Set(myReviews.map((r) => r.productId));

  // 2) Edit counts from the audit trail (pending reviews stay editable up to
  //    MAX_EDITS — one grouped query, no N+1).
  const reviewIds = myReviews.map((r) => r.id);
  const editCounts = reviewIds.length
    ? await db.activityLog.groupBy({
        by: ["entityId"],
        where: { action: EDIT_LOG_ACTION, entityId: { in: reviewIds } },
        _count: { _all: true },
      })
    : [];
  const editsByReview = new Map(editCounts.map((g) => [g.entityId ?? "", g._count._all]));

  // 3) Eligible unreviewed purchase lines. Orders are per-seller rows, so
  //    multi-seller purchases evaluate independently — one seller's
  //    completion never unlocks another seller's undelivered items.
  const candidateOrders = await db.order.findMany({
    where: { shopperId: me.id, status: { in: [...ELIGIBLE_CANDIDATE_STATUSES] } },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: {
      id: true,
      orderNumber: true,
      storeId: true,
      status: true,
      deliveredAt: true,
      completedAt: true,
      createdAt: true,
      store: { select: { id: true, name: true, slug: true, seller: { select: { email: true } } } },
      items: {
        where: { productId: { not: null } },
        select: {
          productId: true,
          refundedMinor: true,
          lineSubtotalMinor: true,
          product: {
            select: {
              id: true,
              title: true,
              slug: true,
              status: true,
              store: { select: { id: true, name: true, slug: true, seller: { select: { email: true } } } },
              images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } },
            },
          },
        },
      },
    },
  });

  const toReview: Array<{
    orderNumber: string;
    orderStatus: string;
    purchasedAt: Date;
    store: { id: string; name: string; slug: string };
    product: { id: string; title: string; slug: string; imageUrl: string };
  }> = [];
  const seenProductIds = new Set<string>();
  for (const o of candidateOrders) {
    for (const item of o.items) {
      const p = item.product;
      if (!p || !item.productId) continue;
      // Dedupe per product (one review per product) — newest order wins.
      if (seenProductIds.has(p.id)) continue;
      // Already reviewed → surfaced in `submitted` instead.
      if (reviewedProductIds.has(p.id)) continue;
      // Seller self-purchases are blocked at submission; mirror it here.
      const sellerEmail = p.store.seller?.email;
      if (sellerEmail && sellerEmail.toLowerCase() === me.email.toLowerCase()) continue;
      // The SAME server predicate as the submission route (status + receipt
      // timestamps + per-line refund rule).
      if (!isEligibleOrder(o, p.id, o.storeId)) continue;
      seenProductIds.add(p.id);
      toReview.push({
        orderNumber: o.orderNumber,
        orderStatus: o.status,
        purchasedAt: o.createdAt,
        store: { id: p.store.id, name: p.store.name, slug: p.store.slug },
        product: {
          id: p.id,
          title: p.title,
          slug: p.slug,
          imageUrl: p.images[0]?.url ?? placeholderUrl(p.slug, { w: 200, h: 200, label: p.title }),
        },
      });
      if (toReview.length >= 50) break;
    }
    if (toReview.length >= 50) break;
  }

  // 4) Reward ledger summary.
  const rewards = await summarizeShopperRewards(me.id);

  return ok({
    toReview,
    submitted: myReviews.map((r) => ({
      id: r.id,
      rating: r.rating,
      // Display-side guard: a payload-carrying text renders blank here too,
      // with contentRemoved flags so the shopper sees WHY it is blank (the
      // system removed it) instead of a silently disappeared review.
      title: sanitizeReviewTextForDisplay(r.title),
      body: sanitizeReviewTextForDisplay(r.body),
      titleRemoved: wasReviewTextRemoved(r.title),
      bodyRemoved: wasReviewTextRemoved(r.body),
      status: r.status,
      createdAt: r.createdAt,
      product: {
        id: r.product.id,
        title: r.product.title,
        slug: r.product.slug,
        imageUrl: r.product.images[0]?.url ?? placeholderUrl(r.product.slug, { w: 200, h: 200, label: r.product.title }),
        store: { name: r.product.store.name, slug: r.product.store.slug },
      },
      reward: r.reward
        ? { points: r.reward.points, reversed: r.reward.reversedAt != null, reversalReason: r.reward.reversalReason }
        : null,
      editable: r.status === "pending" && (editsByReview.get(r.id) ?? 0) < MAX_EDITS,
      editCount: editsByReview.get(r.id) ?? 0,
    })),
    rewards,
    policy: {
      pointsPerReview: 5,
      minorPerPoint: 1,
      maxEdits: MAX_EDITS,
    },
  });
});
