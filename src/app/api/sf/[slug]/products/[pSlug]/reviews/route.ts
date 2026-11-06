import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handle, ok, okPaged, ApiError, logActivity } from "@/lib/api";
import { requireShopper, type ShopperUserDTO } from "@/lib/auth";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { findEligibleOrderForReview, sanitizeReviewInput, reviewsSchemaReady } from "@/lib/reviews";
import { creditReviewReward, REVIEW_REWARD_POINTS, pointsToMinor } from "@/lib/review-rewards";

export const dynamic = "force-dynamic";

// ============================================================================
// /api/sf/[slug]/products/[pSlug]/reviews — the verified-purchase review API.
//
//   GET  — PUBLIC listing with server-side filtering / sorting / pagination
//          (approved reviews only; pending/rejected can never appear).
//   POST — VERIFIED-PURCHASE submission (Task B1) + membership reward credit
//          (rewards work order): review + MembershipReward ledger row are
//          created in ONE transaction, so the RM0.05-equivalent reward is
//          credited exactly once per review, atomically.
//
// POST gate order (each step before the next):
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
//   9. TRANSACTION: create review (pending) + credit reward ledger row.
// ============================================================================

// ---------------------------------------------------------------------------
// GET — public, published-only listing.
//   ?star=1..5     filter by exact star level
//   ?sort=recent|highest|lowest   (default recent)
//   ?page=&size=   server-side pagination (default 10, max 50)
// Pending and rejected reviews are structurally excluded (where status) and
// can therefore never appear publicly or influence totals.
// ---------------------------------------------------------------------------
export const GET = handle(async (req: Request, ctx: { params: Promise<{ slug: string; pSlug: string }> }) => {
  const { slug, pSlug } = await ctx.params;
  const url = new URL(req.url);

  // Resolve the product the same fail-closed way as the PDP route.
  const store = await db.store.findFirst({ where: { slug, status: "live", seller: { is: { status: "active" } } } });
  if (!store) throw new ApiError(404, "STORE_NOT_FOUND", "Store not found");
  const product = await db.product.findFirst({ where: { slug: pSlug, storeId: store.id }, select: { id: true } });
  if (!product) throw new ApiError(404, "PRODUCT_NOT_FOUND", "Product not found");

  const starParam = url.searchParams.get("star");
  if (starParam != null && !["1", "2", "3", "4", "5"].includes(starParam)) {
    throw new ApiError(400, "VALIDATION", "star must be an integer between 1 and 5");
  }
  const sortParam = url.searchParams.get("sort") ?? "recent";
  if (!["recent", "highest", "lowest"].includes(sortParam)) {
    throw new ApiError(400, "VALIDATION", "sort must be one of: recent, highest, lowest");
  }
  // Server-side pagination (default 10, max 50) — the client never loads the
  // full review set.
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const size = Math.min(50, Math.max(1, parseInt(url.searchParams.get("size") ?? "10", 10) || 10));
  const skip = (page - 1) * size;

  const where: Prisma.ReviewWhereInput = {
    productId: product.id,
    status: "published",
    ...(starParam ? { rating: Number(starParam) } : {}),
  };
  const orderBy: Prisma.ReviewOrderByWithRelationInput =
    sortParam === "highest" ? [{ rating: "desc" as const }, { createdAt: "desc" as const }] : sortParam === "lowest" ? [{ rating: "asc" as const }, { createdAt: "desc" as const }] : { createdAt: "desc" };

  const [rows, total] = await Promise.all([
    db.review.findMany({
      where,
      orderBy,
      skip,
      take: size,
      select: {
        id: true,
        orderId: true,
        customerName: true,
        rating: true,
        title: true,
        body: true,
        reply: true,
        createdAt: true,
      },
    }),
    db.review.count({ where }),
  ]);

  return okPaged(
    {
      reviews: rows.map((r) => ({
        id: r.id,
        // orderId != null ⇒ verified purchase (B1) — server-derived, never a
        // client-submitted flag. shopperId/email are never exposed publicly.
        orderId: r.orderId,
        customerName: r.customerName,
        rating: r.rating,
        title: r.title,
        body: r.body,
        reply: r.reply,
        createdAt: r.createdAt,
      })),
    },
    { page, size, total }
  );
});

// ---------------------------------------------------------------------------
// POST — verified-purchase submission (+ exactly-once reward credit).
// ---------------------------------------------------------------------------
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
  // C1.3 defense-in-depth (V-F7 fix): live store + admin-approved seller —
  // an inactive seller's storefront surfaces 404 fail closed (sf/[slug] pattern).
  const store = await db.store.findFirst({ where: { slug, status: "live", seller: { is: { status: "active" } } } });
  if (!store) throw new ApiError(404, "STORE_NOT_FOUND", "Store not found");

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
  //    product in THIS store (delivered/completed + refined refund rules —
  //    see lib/reviews.ts).
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

  // 9. TRANSACTION: create the pending review AND credit the membership
  //    reward in one atomic unit. A failure in either write rolls both back;
  //    a client retry after a committed response hits the duplicate check (409)
  //    before a second reward could ever exist (reviewId is UNIQUE anyway).
  try {
    const created = await db.$transaction(async (tx) => {
      const review = await tx.review.create({
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
      const reward = await creditReviewReward(tx, {
        shopperId: me.id,
        reviewId: review.id,
        productTitle: product.title,
      });
      return { review, reward };
    });

    // Audit the submission + reward credit (outside the transaction — the
    // ActivityLog is an append-only trail, not a business invariant).
    await logActivity({
      actorType: "shopper",
      actorId: me.id,
      actorLabel: me.email,
      action: "shopper.review.submitted",
      entityType: "review",
      entityId: created.review.id,
      meta: {
        productId: product.id,
        orderId: eligibleOrder.id,
        rating: parsed.value.rating,
        rewardId: created.reward.id,
        rewardPoints: REVIEW_REWARD_POINTS,
      },
    });

    return ok(
      {
        id: created.review.id,
        status: "pending",
        reward: {
          credited: true,
          points: REVIEW_REWARD_POINTS,
          minorEquivalent: pointsToMinor(REVIEW_REWARD_POINTS),
        },
        message: `Thanks! Your review is pending approval. ${REVIEW_REWARD_POINTS} membership points (≈ RM0.05) were added to your rewards.`,
      },
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
