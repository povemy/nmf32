// ============================================================================
// PRODUCT REVIEWS — verified-purchase policy + aggregate invariant (Task B1).
// ============================================================================
// Policy invariants enforced here (shared by the submission route and the
// admin moderation routes, so the two can never drift):
//
//   1. A review can only be written by a signed-in shopper who has a
//      terminal-success order FOR THIS PRODUCT in the product's store
//      (verified purchase). The order id is frozen onto the review row
//      (Review.orderId) so the storefront can badge it "Verified purchase".
//   2. New submissions land in status "pending" — they only ever become
//      public via admin moderation (approve → "published").
//   3. product.ratingAvg / ratingCount are aggregates over PUBLISHED reviews
//      ONLY — recomputed by recomputeProductRating() on every moderation
//      transition (and nowhere else), so pending/rejected rows can never
//      inflate a product's stars.
//
// Pure helpers (status transitions, input sanitization, eligibility
// predicate) are dependency-free and unit-tested in
// src/lib/__tests__/reviews.test.ts — the Prisma-backed helpers below import
// db directly (same pattern as src/lib/ledger.ts).
// ============================================================================
import { Prisma } from "@prisma/client";
import { db } from "./db";

// ----------------------------------------------------------------------------
// Order-status vocabulary (investigated, not assumed)
// ----------------------------------------------------------------------------
// The spec suggested ["delivered", "completed", "received"], but "received"
// does NOT exist in this codebase. The real Order.status vocabulary is
// (single source: /api/me/orders BUCKETS + every transitionOrder call site):
//
//   payment_pending · paid · processing · shipped · delivered · completed
//   cancelled · refunding · partially_refunded · refunded · closed
//   payment_expired
//
// The terminal-success states — the shopper demonstrably HAS the goods — are
// "delivered" (the buyer dashboard's "To Rate" bucket is exactly ["delivered"])
// and "completed" (buyer-confirmed receipt via
// /api/me/orders/[orderNumber]/receive, or the 14-day auto-complete sweep in
// lib/order-completion.ts). Those two are review-eligible.
//
// REVIEW REWARDS work order — partial refunds: a PARTIALLY refunded order can
// still be delivered (buyer kept the goods; only part of the money came back),
// so it stays review-eligible ONLY when receipt was already established
// (deliveredAt/completedAt set) AND the specific line still has unrefunded
// value (OrderItem.refundedMinor < lineSubtotalMinor). Fully refunded
// ("refunded"), cancelled, unpaid ("payment_pending") and expired
// ("payment_expired") orders are NEVER eligible.
export const ELIGIBLE_ORDER_STATUSES = ["delivered", "completed"] as const;

/** Statuses whose orders we fetch as CANDIDATES before the precise predicate
 * (partially_refunded rows are included as candidates, then timestamp- and
 * refund-checked by isEligibleOrder — see REVIEW_REFINEMENT below). */
export const ELIGIBLE_CANDIDATE_STATUSES = ["delivered", "completed", "partially_refunded"] as const;

// ----------------------------------------------------------------------------
// Review status lifecycle
// ----------------------------------------------------------------------------
export const REVIEW_STATUSES = ["pending", "published", "rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** Allowed moderation transitions. pending → published | rejected ONLY:
 *  moderation is a one-way decision off the queue — a final state can never
 *  be re-moderated or un-published (the routes enforce the same rule with a
 *  conditional updateMany on status:"pending", making approve/reject
 *  idempotent-safe against double-clicks and racing moderators). */
const REVIEW_TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
  pending: ["published", "rejected"],
  published: [],
  rejected: [],
};

/** Pure status-transition validator — true iff from → to is an allowed
 *  moderation step. Unknown statuses are invalid by construction. */
export function reviewTransitionAllowed(from: string, to: string): boolean {
  const allowed = REVIEW_TRANSITIONS[from as ReviewStatus];
  if (!allowed) return false;
  return allowed.includes(to as ReviewStatus);
}

// ----------------------------------------------------------------------------
// Verified-purchase eligibility
// ----------------------------------------------------------------------------
/** Minimal structural shape the pure predicate needs (Order rows fetched with
 *  `items` satisfy it; tests fabricate it without a database). */
export type EligibleOrderShape = {
  storeId: string;
  status: string;
  deliveredAt?: Date | null;
  completedAt?: Date | null;
  items: ReadonlyArray<{ productId: string; refundedMinor?: number; lineSubtotalMinor?: number }>;
};

/** Pure eligibility predicate:
 *   • the order belongs to the product's store (multi-seller orders are
 *     separate Order rows — one seller's completion never unlocks another's);
 *   • the order is in a terminal-success status: delivered | completed, or
 *     partially_refunded WITH prior receipt (deliveredAt/completedAt set);
 *   • it contains an item for THIS product that still has unrefunded value
 *     (refundedMinor < lineSubtotalMinor — a fully refunded line is not a
 *     purchase the shopper meaningfully paid for).
 *  Shopper ownership is NOT checked here — it is enforced by the query in
 *  findEligibleOrderForReview (shopperId scope). */
export function isEligibleOrder(order: EligibleOrderShape, productId: string, storeId: string): boolean {
  if (order.storeId !== storeId) return false;
  const terminalSuccess =
    (ELIGIBLE_ORDER_STATUSES as readonly string[]).includes(order.status) ||
    (order.status === "partially_refunded" && (order.deliveredAt != null || order.completedAt != null));
  if (!terminalSuccess) return false;
  return order.items.some((i) => {
    if (i.productId !== productId) return false;
    const refunded = i.refundedMinor ?? 0;
    // Real OrderItem rows always carry lineSubtotalMinor; a shape without it
    // (legacy projections, test fixtures) is treated as refund-free.
    if (i.lineSubtotalMinor == null) return refunded === 0;
    return refunded < i.lineSubtotalMinor;
  });
}

/**
 * Most recent order of THIS shopper that qualifies the shopper to review the
 * given product: same store, terminal-success status (incl. the refined
 * partial-refund rule), contains the product with unrefunded value.
 * Fetches candidate orders newest-first with the product's items, then applies
 * the pure predicate — the per-line refundedMinor < lineSubtotalMinor
 * comparison is not expressible as a Prisma where clause, and the candidate
 * set per shopper is small by construction. Returns the order id to freeze
 * onto the review, or null when no eligible order exists.
 */
export async function findEligibleOrderForReview(
  shopperId: string,
  productId: string,
  storeId: string
): Promise<{ id: string } | null> {
  const candidates = await db.order.findMany({
    where: {
      shopperId,
      storeId,
      status: { in: [...ELIGIBLE_CANDIDATE_STATUSES] },
      items: { some: { productId } },
    },
    select: {
      id: true,
      storeId: true,
      status: true,
      deliveredAt: true,
      completedAt: true,
      items: { where: { productId }, select: { productId: true, refundedMinor: true, lineSubtotalMinor: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const eligible = candidates.find((o) => isEligibleOrder(o, productId, storeId));
  return eligible ? { id: eligible.id } : null;
}

// ----------------------------------------------------------------------------
// Product rating aggregates — published-only invariant
// ----------------------------------------------------------------------------
/** Recompute product.ratingAvg/ratingCount from PUBLISHED reviews only and
 *  persist them. Called after every moderation transition so aggregates can
 *  never count pending/rejected rows. Returns the new values for audit meta. */
export async function recomputeProductRating(productId: string): Promise<{ ratingAvg: number; ratingCount: number }> {
  const agg = await db.review.aggregate({
    where: { productId, status: "published" },
    _avg: { rating: true },
    _count: { rating: true },
  });
  const ratingAvg = Math.round((agg._avg.rating ?? 0) * 100) / 100;
  const ratingCount = agg._count.rating;
  await db.product.update({ where: { id: productId }, data: { ratingAvg, ratingCount } });
  return { ratingAvg, ratingCount };
}

// ----------------------------------------------------------------------------
// Submission input sanitization (pure — unit-tested)
// ----------------------------------------------------------------------------
/** Hard length caps for the free-text fields of a review. */
export const REVIEW_LIMITS = { customerName: 80, title: 120, body: 2000 } as const;

/** C0 control chars (minus \t \n \r, which body copy legitimately uses) + DEL. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Strip control characters that have no place in review text (injection /
 *  terminal-escape noise). Preserves tabs and line breaks. */
export function stripControlChars(s: string): string {
  return s.replace(CONTROL_CHARS, "");
}

export type SanitizedReviewInput = {
  customerName: string;
  rating: number;
  title: string | null;
  body: string | null;
};

export type SanitizeReviewResult =
  | { ok: true; value: SanitizedReviewInput }
  | { ok: false; errors: string[] };

function sanitizeOptionalText(v: unknown, cap: number, field: string, errors: string[]): string | null {
  if (v == null) return null;
  const s = stripControlChars(String(v)).trim();
  if (!s) return null;
  if (s.length > cap) {
    errors.push(`${field} must be at most ${cap} characters`);
    return null;
  }
  return s;
}

/**
 * Validate + normalize a raw submission body (manual style, matching the
 * codebase's hand-rolled route validation):
 *   • customerName: control chars stripped, trimmed, ≤ 80 chars; falls back
 *     to `fallbackName` (the signed-in shopper's fullName) when absent —
 *     required only when no fallback exists.
 *   • rating: REQUIRED integer 1..5 (numeric strings like "4" accepted;
 *     non-integers are rejected, not rounded — hardened vs. the legacy route).
 *   • title / body: optional, control chars stripped, trimmed, null when
 *     empty, capped at 120 / 2000 chars.
 * Returns { ok: true, value } or { ok: false, errors: string[] }.
 */
export function sanitizeReviewInput(
  raw: Record<string, unknown>,
  fallbackName?: string | null
): SanitizeReviewResult {
  const errors: string[] = [];

  const nameRaw = typeof raw.customerName === "string" ? stripControlChars(raw.customerName).trim() : "";
  const fallback = fallbackName != null ? stripControlChars(String(fallbackName)).trim() : "";
  const customerName = nameRaw || fallback;
  if (!customerName) errors.push("customerName is required");
  else if (customerName.length > REVIEW_LIMITS.customerName) {
    errors.push(`customerName must be at most ${REVIEW_LIMITS.customerName} characters`);
  }

  const ratingRaw = raw.rating;
  const rating =
    typeof ratingRaw === "number" ? ratingRaw : typeof ratingRaw === "string" && ratingRaw.trim() !== "" ? Number(ratingRaw.trim()) : NaN;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    errors.push("rating must be an integer between 1 and 5");
  }

  const title = sanitizeOptionalText(raw.title, REVIEW_LIMITS.title, "title", errors);
  const body = sanitizeOptionalText(raw.body, REVIEW_LIMITS.body, "body", errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { customerName, rating, title, body } };
}

// ----------------------------------------------------------------------------
// Phase 1 (B1) — pre-migration probe.
// ----------------------------------------------------------------------------
// The Review migration (20261101000001) adds shopperId/orderId columns. Until
// it is applied, ANY Prisma read that references those columns fails P2022 —
// including the default all-scalar include on the PDP read path. This probe
// caches per process whether the columns exist, so:
//   • the PDP read path can fall back to the LEGACY projection (identical
//     response shape, orderId: null) — public browsing NEVER breaks;
//   • submission + moderation can answer a clean 503 REVIEWS_NOT_MIGRATED
//     (mirroring the admin-MFA pattern) instead of a raw 500;
//   • after the migration is applied and the app restarts, the probe flips
//     and full behavior engages with zero code changes.
/** Transitional: REMOVE once migration 20261101000001 is confirmed applied
 *  in every environment (then this always returns true — or inline the new
 *  columns directly). */
let reviewsSchemaReadyCache: boolean | null = null;
export async function reviewsSchemaReady(): Promise<boolean> {
  if (reviewsSchemaReadyCache !== null) return reviewsSchemaReadyCache;
  try {
    await db.review.findFirst({ select: { shopperId: true }, take: 1 });
    reviewsSchemaReadyCache = true;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === "P2021" || e.code === "P2022")) {
      console.warn("[reviews] shopperId/orderId columns missing — migration 20261101000001 not applied; legacy projection in effect");
      reviewsSchemaReadyCache = false;
    } else {
      throw e;
    }
  }
  return reviewsSchemaReadyCache;
}
