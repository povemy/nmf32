// Unit tests for the PURE parts of src/lib/reviews.ts (Task B1) — no database,
// no network: status-transition policy, verified-purchase eligibility
// predicate, and submission input sanitization/length caps. The Prisma-backed
// helpers (findEligibleOrderForReview / recomputeProductRating) are exercised
// by the route/integration layer, not here.
import { describe, test, expect } from "bun:test";
import {
  ELIGIBLE_ORDER_STATUSES,
  ELIGIBLE_CANDIDATE_STATUSES,
  REVIEW_STATUSES,
  REVIEW_LIMITS,
  isEligibleOrder,
  reviewTransitionAllowed,
  sanitizeReviewInput,
  stripControlChars,
  type EligibleOrderShape,
} from "../reviews";

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------
describe("review status vocabulary", () => {
  test("reviews are pending → published | rejected (no other lifecycle states)", () => {
    expect([...REVIEW_STATUSES]).toEqual(["pending", "published", "rejected"]);
  });

  test("eligible order statuses are this codebase's terminal-success states", () => {
    // ORDER-FLOW CORRECTION: "received" (buyer-confirmed receipt — the To Rate
    // bucket) and "completed" are the review-eligible states; courier
    // "delivered" alone is NOT — the buyer must confirm receipt first.
    expect([...ELIGIBLE_ORDER_STATUSES]).toEqual(["received", "completed"]);
  });

  test("candidate statuses add partially_refunded for the refund-refined predicate", () => {
    // Rewards work order: a received-but-partially-refunded order stays
    // reviewable per-line; the pure predicate then checks receipt timestamps.
    expect([...ELIGIBLE_CANDIDATE_STATUSES]).toEqual(["received", "completed", "partially_refunded"]);
  });
});

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------
describe("reviewTransitionAllowed", () => {
  test("pending can be approved or rejected", () => {
    expect(reviewTransitionAllowed("pending", "published")).toBe(true);
    expect(reviewTransitionAllowed("pending", "rejected")).toBe(true);
  });

  test("final states can never transition (one-way moderation)", () => {
    expect(reviewTransitionAllowed("published", "rejected")).toBe(false);
    expect(reviewTransitionAllowed("published", "pending")).toBe(false);
    expect(reviewTransitionAllowed("rejected", "published")).toBe(false);
    expect(reviewTransitionAllowed("rejected", "pending")).toBe(false);
  });

  test("self transitions and unknown statuses are invalid", () => {
    expect(reviewTransitionAllowed("pending", "pending")).toBe(false);
    expect(reviewTransitionAllowed("published", "published")).toBe(false);
    expect(reviewTransitionAllowed("archived", "published")).toBe(false);
    expect(reviewTransitionAllowed("pending", "archived")).toBe(false);
    expect(reviewTransitionAllowed("", "published")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Verified-purchase eligibility (pure predicate over fabricated orders)
// ---------------------------------------------------------------------------
const P_ID = "prod_1";
const S_ID = "store_1";

function order(overrides: Partial<EligibleOrderShape> & Pick<EligibleOrderShape, "status">): EligibleOrderShape {
  return { storeId: S_ID, items: [{ productId: P_ID, refundedMinor: 0, lineSubtotalMinor: 1000 }], ...overrides };
}

describe("isEligibleOrder", () => {
  test("terminal-success statuses with matching store + product are eligible", () => {
    expect(isEligibleOrder(order({ status: "received" }), P_ID, S_ID)).toBe(true);
    expect(isEligibleOrder(order({ status: "completed" }), P_ID, S_ID)).toBe(true);
  });

  test("courier-delivered WITHOUT buyer receipt confirmation is NOT eligible (To Receive, not To Rate)", () => {
    expect(isEligibleOrder(order({ status: "delivered" }), P_ID, S_ID)).toBe(false);
  });

  test("non-terminal statuses are NOT eligible (goods not confirmed in hand)", () => {
    for (const status of ["payment_pending", "paid", "processing", "shipped", "cancelled", "refunded", "refunding", "closed", "payment_expired"]) {
      expect(isEligibleOrder(order({ status }), P_ID, S_ID)).toBe(false);
    }
  });

  test("wrong store is not eligible (cross-store purchases don't count)", () => {
    expect(isEligibleOrder(order({ status: "received", storeId: "store_other" }), P_ID, S_ID)).toBe(false);
  });

  test("order without THIS product in its items is not eligible", () => {
    expect(isEligibleOrder(order({ status: "received", items: [{ productId: "prod_other" }] }), P_ID, S_ID)).toBe(false);
    expect(isEligibleOrder(order({ status: "received", items: [] }), P_ID, S_ID)).toBe(false);
  });

  test("multi-item order containing the product anywhere is eligible", () => {
    const multi = order({ status: "completed", items: [{ productId: "prod_other" }, { productId: P_ID }] });
    expect(isEligibleOrder(multi, P_ID, S_ID)).toBe(true);
  });

  // ---- Rewards work order: partial-refund refinement -------------------------
  test("partially_refunded WITH prior receipt (deliveredAt/receivedAt) is eligible", () => {
    expect(isEligibleOrder(order({ status: "partially_refunded", deliveredAt: new Date() }), P_ID, S_ID)).toBe(true);
    expect(isEligibleOrder(order({ status: "partially_refunded", receivedAt: new Date() }), P_ID, S_ID)).toBe(true);
    expect(isEligibleOrder(order({ status: "partially_refunded", completedAt: new Date() }), P_ID, S_ID)).toBe(true);
  });

  test("partially_refunded WITHOUT receipt evidence is NOT eligible (refund before delivery)", () => {
    expect(isEligibleOrder(order({ status: "partially_refunded" }), P_ID, S_ID)).toBe(false);
  });

  test("a fully refunded line is NOT eligible even on a received order", () => {
    expect(
      isEligibleOrder(order({ status: "received", items: [{ productId: P_ID, refundedMinor: 1000, lineSubtotalMinor: 1000 }] }), P_ID, S_ID)
    ).toBe(false);
    expect(
      isEligibleOrder(order({ status: "received", items: [{ productId: P_ID, refundedMinor: 1500, lineSubtotalMinor: 1000 }] }), P_ID, S_ID)
    ).toBe(false);
  });

  test("a partially refunded line on a received order IS eligible (remaining unrefunded value)", () => {
    expect(
      isEligibleOrder(order({ status: "received", items: [{ productId: P_ID, refundedMinor: 400, lineSubtotalMinor: 1000 }] }), P_ID, S_ID)
    ).toBe(true);
  });

  test("item refund check applies per-line — a refunded OTHER line does not block this product", () => {
    const multi = order({
      status: "received",
      items: [
        { productId: "prod_other", refundedMinor: 500, lineSubtotalMinor: 500 },
        { productId: P_ID, refundedMinor: 0, lineSubtotalMinor: 1000 },
      ],
    });
    expect(isEligibleOrder(multi, P_ID, S_ID)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Input sanitization
// ---------------------------------------------------------------------------
describe("stripControlChars", () => {
  test("strips C0 control chars and DEL", () => {
    expect(stripControlChars("ab\u0000\u0007c\u000Bd\u007F")).toBe("abcd");
  });

  test("preserves meaningful whitespace (tabs, newlines, carriage returns)", () => {
    expect(stripControlChars("line1\nline2\tindented\r\n")).toBe("line1\nline2\tindented\r\n");
  });
});

describe("sanitizeReviewInput", () => {
  test("happy path: name, rating, title and body pass through", () => {
    const res = sanitizeReviewInput({ customerName: " Aminah ", rating: 4, title: " Great mug ", body: " Solid build. " });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({ customerName: "Aminah", rating: 4, title: "Great mug", body: "Solid build." });
    }
  });

  test("customerName falls back to the signed-in shopper's fullName", () => {
    const res = sanitizeReviewInput({ rating: 5 }, "Fallback Name");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.customerName).toBe("Fallback Name");
  });

  test("missing customerName with no fallback is an error", () => {
    const res = sanitizeReviewInput({ rating: 5 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join()).toContain("customerName");
  });

  test("length caps are enforced on all three text fields", () => {
    const over = (n: number) => "x".repeat(n + 1);
    const res = sanitizeReviewInput(
      { customerName: over(REVIEW_LIMITS.customerName), rating: 3, title: over(REVIEW_LIMITS.title), body: over(REVIEW_LIMITS.body) },
      null
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.includes("customerName"))).toBe(true);
      expect(res.errors.some((e) => e.includes("title"))).toBe(true);
      expect(res.errors.some((e) => e.includes("body"))).toBe(true);
    }
  });

  test("values exactly at the caps are accepted", () => {
    const at = (n: number) => "x".repeat(n);
    const res = sanitizeReviewInput(
      { customerName: at(REVIEW_LIMITS.customerName), rating: 3, title: at(REVIEW_LIMITS.title), body: at(REVIEW_LIMITS.body) },
      null
    );
    expect(res.ok).toBe(true);
  });

  test("control characters are stripped before caps are checked", () => {
    const res = sanitizeReviewInput({ customerName: "A", rating: 5, title: "ok\u0000title", body: "ok\u0007body" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.title).toBe("oktitle");
      expect(res.value.body).toBe("okbody");
    }
  });

  test("empty title/body normalize to null", () => {
    const res = sanitizeReviewInput({ customerName: "A", rating: 2, title: "   ", body: "" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.title).toBeNull();
      expect(res.value.body).toBeNull();
    }
  });

  test("rating must be an integer between 1 and 5", () => {
    for (const rating of [0, -1, 6, 4.5, NaN, Infinity, "abc", null, undefined, true]) {
      const res = sanitizeReviewInput({ customerName: "A", rating });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errors.some((e) => e.includes("rating"))).toBe(true);
    }
    for (const rating of [1, 2, 3, 4, 5, "4"]) {
      const res = sanitizeReviewInput({ customerName: "A", rating });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.rating).toBe(Number(rating));
    }
  });

  test("non-string customerName falls back rather than crashing", () => {
    const res = sanitizeReviewInput({ customerName: 12345, rating: 4 }, "Real Name");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.customerName).toBe("Real Name");
  });
});
