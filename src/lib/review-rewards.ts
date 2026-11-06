// ============================================================================
// REVIEW REWARDS — membership ledger for verified reviews (rewards work order).
// ============================================================================
// RM0.05-equivalent per eligible review, represented as 5 membership POINTS at
// the platform's established valuation (1 point ≈ RM0.01 — the same conversion
// the dormant Nomo Coins UI copy publishes). Deliberately NOT credited to
// ShopperWallet.coinBalance: NOMO_FINANCE_ENABLED=false is an FSA 2013 / BNM
// regulatory gate that forbids reconnecting the finance suite, so points are
// ledger-visible but not spendable until the owner activates finance.
//
// Exactly-once mechanics:
//   • the reward row is created in the SAME db.$transaction as the review;
//   • MembershipReward.reviewId is UNIQUE — even a buggy future caller cannot
//     create a second reward for the same review;
//   • a retried submission hits REVIEW_ALREADY_EXISTS (409) on the review
//     unique constraint before any reward row could be duplicated;
//   • reversal (proven-fraud rejection) is a CONDITIONAL update on
//     reversedAt IS NULL, so concurrent/repeated reversals converge.
//
// Reward policy: credited at submission (honest feedback, ANY star rating —
// a 1-star review earns exactly what a 5-star review earns), reversed only
// through an auditable admin action with a recorded reason.
// ============================================================================
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { logActivity } from "./api";

/** Points credited per eligible verified review. 5 points ≡ RM0.05. */
export const REVIEW_REWARD_POINTS = 5;

/** Established platform valuation: 1 membership point ≈ RM0.01 (1 minor). */
export const POINTS_TO_MINOR_RATIO = 1; // minor units per point

export const REVIEW_REWARD_KIND = "review";

/** Convert points to their informational RM minor-unit equivalent. */
export function pointsToMinor(points: number): number {
  return points * POINTS_TO_MINOR_RATIO;
}

/** Credit the review reward INSIDE the caller's transaction. Exactly-once is
 * structural: reviewId UNIQUE + the review row itself was just created in the
 * same transaction. Returns the created ledger row id. */
export async function creditReviewReward(
  tx: Prisma.TransactionClient,
  input: { shopperId: string; reviewId: string; productTitle: string }
): Promise<{ id: string }> {
  return tx.membershipReward.create({
    data: {
      shopperId: input.shopperId,
      kind: REVIEW_REWARD_KIND,
      reviewId: input.reviewId,
      points: REVIEW_REWARD_POINTS,
      note: `Verified review reward — ${input.productTitle.slice(0, 120)}`,
    },
    select: { id: true },
  });
}

/** Reverse a reward for proven fraud — CONDITIONAL on reversedAt IS NULL so
 * repeated/concurrent reversals are no-ops (idempotent). Audited via
 * ActivityLog. Returns true when this call performed the reversal. */
export async function reverseReviewReward(input: {
  reviewId: string;
  reason: string;
  actorId: string;
  actorLabel: string;
}): Promise<boolean> {
  const res = await db.membershipReward.updateMany({
    where: { reviewId: input.reviewId, reversedAt: null, kind: REVIEW_REWARD_KIND },
    data: { reversedAt: new Date(), reversalReason: input.reason.slice(0, 500) },
  });
  if (res.count === 0) return false;
  await logActivity({
    actorType: "admin",
    actorId: input.actorId,
    actorLabel: input.actorLabel,
    action: "membership.reward.reversed",
    entityType: "review",
    entityId: input.reviewId,
    meta: { reason: input.reason.slice(0, 500), points: -REVIEW_REWARD_POINTS },
  });
  return true;
}

/** Shopper-facing reward summary: net (unreversed) points, total credits,
 * reversals, and the recent ledger entries. */
export async function summarizeShopperRewards(shopperId: string) {
  const [rows, agg] = await Promise.all([
    db.membershipReward.findMany({
      where: { shopperId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, kind: true, points: true, note: true, createdAt: true, reversedAt: true, reversalReason: true },
    }),
    db.membershipReward.groupBy({
      by: ["reversedAt"],
      where: { shopperId, kind: REVIEW_REWARD_KIND },
      _count: { _all: true },
      _sum: { points: true },
    }),
  ]);
  // groupBy on a nullable DateTime buckets NULL vs non-NULL — derive net totals.
  let activePoints = 0;
  let activeCount = 0;
  let reversedCount = 0;
  let reversedPoints = 0;
  for (const g of agg) {
    if (g.reversedAt == null) {
      activePoints += g._sum.points ?? 0;
      activeCount += g._count._all;
    } else {
      reversedCount += g._count._all;
      reversedPoints += g._sum.points ?? 0;
    }
  }
  return {
    activePoints,
    activeCount,
    reversedCount,
    reversedPoints,
    minorEquivalent: pointsToMinor(activePoints),
    recent: rows,
  };
}
