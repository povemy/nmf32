import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper, type ShopperUserDTO } from "@/lib/auth";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { findEligibleOrderForReview, sanitizeReviewInput, reviewsSchemaReady } from "@/lib/reviews";

export const dynamic = "force-dynamic";

// POST /api/sf/[slug]/products/[pSlug]/reviews — VERIFIED-PURCHASE submission (Task B1).
// {customerName?, rating 1..5, title?, body?} → review is created "pending";
// it only becomes public (and only then feeds product aggregates) after admin
// moderation approves it (POST /api/admin/reviews/[id]).
//
// Gate order (each step before the next):
//   1. IP rate limit (5/min) — cheapest check first, before any DB work.
//   2. Shopper login (401) — runs BEFORE any new-column DB access, so the
//      anonymous path keeps working even before the Review migration is applied.
//   3. Store (live) + product (active) resolution — one findFirst that also
//      carries the store's seller email for the self-review block.
//   4. Seller self-review block (403 SELLER_SELF_REVIEW).
//   5. Verified-purchase eligibility (403 VERIFIED_PURCHASE_REQUIRED, uniform
//      message — no data leak about which orders exist).
//   6. Duplicate review (409 REVIEW_ALREADY_EXISTS) — code-level check plus
//      the DB @@unique([productId, shopperId]) as the race backstop (P2002).
//   7. Input validation/sanitization (lib/reviews.ts — pure + unit-tested).
//   8. Identity rate limits: 3/hour/account, 10/hour/product.
//   9. Create with status "pending" — 201, no aggregates in the response
//      (nothing is published yet, so there is nothing to report).
export const POST = handle(async (req: Request, ctx: { params: Promise<{ slug: string; pSlug: string }> }) => {
  rateLimit(req, "sf-review", 5); // 5/min/IP — first, before any DB access

  // 2. Login gate (uniform message; requireShopper's own 401 is re-wrapped so
  // the API contract is stable regardless of which sub-check fired).
  let me: ShopperUserDTO;
  try {
    me = await requireShopper();
  } catch {
    throw new ApiError(401, "UNAUTHORIZED", "Login required to review");
  }

  // 2.5 Pre-migration guard (Phase 1 B1): the Review columns this feature
  // needs (shopperId/orderId + unique index) come from migration
  // 20261101000001. Until it is applied, submission answers a clean 503
  // (mirroring the admin-MFA pattern) instead of failing mid-transaction.
  // Read paths (PDP) keep working via the legacy projection.
  if (!(await reviewsSchemaReady())) {
    throw new ApiError(503, "REVIEWS_NOT_MIGRATED", "Verified-purchase reviews await a pending database migration — submission is temporarily unavailable");
  }

  const { slug, pSlug } = await ctx.params;
  const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // 3. Store + product (single product fetch carries the seller email).
  const store = await db.store.findUnique({ where: { slug } });
  if (!store || store.status !== "live") throw new ApiError(404, "STORE_NOT_FOUND", "Store not found");

  const product = await db.product.findFirst({
    where: { slug: pSlug, storeId: store.id },
    include: { store: { select: { sellerId: true, seller: { select: { email: true } } } } },
  });
  if (!product || product.status !== "active") throw new ApiError(404, "PRODUCT_NOT_FOUND", "Product not found");

  // 4. Sellers cannot review their own products (store.seller via the product's store).
  const sellerEmail = product.store.seller?.email;
  if (sellerEmail && sellerEmail.toLowerCase() === me.email.toLowerCase()) {
    throw new ApiError(403, "SELLER_SELF_REVIEW", "Sellers cannot review their own products");
  }

  // 5. Verified purchase: most recent eligible order of THIS shopper for THIS
  //    product in THIS store (delivered/completed — see lib/reviews.ts).
  const eligibleOrder = await findEligibleOrderForReview(me.id, product.id, store.id);
  if (!eligibleOrder) {
    throw new ApiError(403, "VERIFIED_PURCHASE_REQUIRED", "You can review after your order is delivered");
  }

  // 6. Duplicate (code-level; the DB unique index is the race backstop).
  const existing = await db.review.findFirst({
    where: { productId: product.id, shopperId: me.id },
    select: { id: true },
  });
  if (existing) throw new ApiError(409, "REVIEW_ALREADY_EXISTS", "You have already reviewed this product");

  // 7. Input validation + sanitization (customerName falls back to me.fullName).
  const parsed = sanitizeReviewInput(raw, me.fullName);
  if (!parsed.ok) throw new ApiError(400, "VALIDATION", parsed.errors.join("; "));

  // 8. Identity-keyed rate limits (spread across IPs still throttles the
  //    account; a coordinated ring still throttles per product).
  rateLimitKey(me.id, "sf-review-acct", 3, 3600_000); // 3/hour/account
  rateLimitKey(product.id, "sf-review-product", 10, 3600_000); // 10/hour/product

  // 9. Create as pending — moderation publishes it (and recomputes aggregates).
  try {
    const review = await db.review.create({
      data: {
        productId: product.id,
        shopperId: me.id,
        orderId: eligibleOrder.id,
        customerName: parsed.value.customerName,
        rating: parsed.value.rating,
        title: parsed.value.title,
        body: parsed.value.body,
        status: "pending",
      },
      select: { id: true },
    });
    return ok(
      { id: review.id, status: "pending", message: "Thanks! Your review is pending approval." },
      { status: 201 }
    );
  } catch (e) {
    // Race backstop: a concurrent submission won the @@unique([productId, shopperId]).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ApiError(409, "REVIEW_ALREADY_EXISTS", "You have already reviewed this product");
    }
    throw e;
  }
});
