import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper, type ShopperUserDTO } from "@/lib/auth";
import { findEligibleOrderForReview, reviewsSchemaReady } from "@/lib/reviews";
import type { SfReviewEligibilityData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/sf/[slug]/products/[pSlug]/reviews/eligibility
// Signed-in shopper's review affordance state for THIS product — drives the
// "Write a review" CTA on the PDP. Auth-varying data must live OUTSIDE the
// cached PDP payload (30s public cache), hence this dedicated probe.
//
//   401 ANONYMOUS          → not signed in (the UI offers login instead)
//   200 {eligible: false, reason: "no_eligible_order"}  → no reviewable purchase
//   200 {eligible: false, reason: "already_reviewed", review: {...}} → done
//   200 {eligible: true}   → show the review form
//
// Deliberately does NOT reveal whether an eligible order EXISTS beyond the
// boolean the CTA needs — no order numbers, no data enrichment.
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ slug: string; pSlug: string }> }) => {
  let me: ShopperUserDTO;
  try {
    me = await requireShopper();
  } catch {
    throw new ApiError(401, "ANONYMOUS", "Sign in to review");
  }
  if (!(await reviewsSchemaReady())) {
    throw new ApiError(503, "REVIEWS_NOT_MIGRATED", "Verified-purchase reviews await a pending database migration");
  }

  const { slug, pSlug } = await ctx.params;
  const store = await db.store.findFirst({ where: { slug, status: "live", seller: { is: { status: "active" } } } });
  if (!store) throw new ApiError(404, "STORE_NOT_FOUND", "Store not found");
  const product = await db.product.findFirst({
    where: { slug: pSlug, storeId: store.id },
    select: { id: true, store: { select: { seller: { select: { email: true } } } } },
  });
  if (!product || product.store.seller == null) throw new ApiError(404, "PRODUCT_NOT_FOUND", "Product not found");

  // Already reviewed? (one review per buyer per product — the frozen rule.)
  const mine = await db.review.findFirst({
    where: { productId: product.id, shopperId: me.id },
    select: { id: true, status: true, rating: true },
  });
  if (mine) {
    const payload: SfReviewEligibilityData = {
      eligible: false,
      reason: "already_reviewed",
      review: { id: mine.id, status: mine.status, rating: mine.rating },
    };
    return ok(payload);
  }

  // Sellers cannot review their own products (mirror the POST gate).
  const sellerEmail = product.store.seller.email;
  if (sellerEmail && sellerEmail.toLowerCase() === me.email.toLowerCase()) {
    const payload: SfReviewEligibilityData = { eligible: false, reason: "own_product" };
    return ok(payload);
  }

  const eligibleOrder = await findEligibleOrderForReview(me.id, product.id, store.id);
  const payload: SfReviewEligibilityData = {
    eligible: eligibleOrder != null,
    reason: eligibleOrder ? "ok" : "no_eligible_order",
  };
  return ok(payload);
});
