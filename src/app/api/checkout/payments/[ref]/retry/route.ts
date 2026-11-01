import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";

export const dynamic = "force-dynamic";

// POST /api/checkout/payments/[ref]/retry — re-open a FAILED payment session.
// Mirrors a gateway's "initiate a new attempt" call: only a failed session can be
// retried; a succeeded (or already-processing) one can never be re-opened here.
// Works for both legacy PaymentIntents and OPTION A PaymentGroups.
export const POST = handle(async (_req: Request, ctx: { params: Promise<{ ref: string }> }) => {
  const { ref } = await ctx.params;

  const group = await db.paymentGroup.findUnique({ where: { ref } });
  if (group) {
    if (group.status === "succeeded") {
      throw new ApiError(409, "ALREADY_PAID", "This payment was already completed");
    }
    if (group.status !== "failed") {
      throw new ApiError(409, "NOT_RETRYABLE", "Only a failed payment can be retried");
    }
    if (group.expiresAt.getTime() < Date.now()) {
      throw new ApiError(410, "SESSION_EXPIRED", "This payment session has expired — start a new checkout");
    }

    // C1.1 verification fix (Phase 2.2): CONDITIONAL re-open. The reads above
    // are stale by definition — if the expiry sweep claims the group `expired`
    // between them and the write, an unconditional update would resurrect an
    // already-restocked session as requires_payment (the sweep would then have
    // to release it again on a later tick). Only a still-failed, still-live
    // session may be re-opened; anything else falls through to the re-read.
    const reopened = await db.paymentGroup.updateMany({
      where: { id: group.id, status: "failed", expiresAt: { gt: new Date() } },
      data: { status: "requires_payment" },
    });
    if (reopened.count === 0) {
      const fresh = await db.paymentGroup.findUnique({ where: { id: group.id }, select: { status: true } });
      if (fresh?.status === "succeeded") throw new ApiError(409, "ALREADY_PAID", "This payment was already completed");
      if (fresh?.status === "expired") throw new ApiError(410, "SESSION_EXPIRED", "This payment session has expired — start a new checkout");
      throw new ApiError(409, "NOT_RETRYABLE", "This payment session can no longer be retried — start a new checkout");
    }

    await logActivity({
      actorType: "shopper",
      action: "payment.retry",
      entityType: "payment_group",
      entityId: group.id,
      meta: { providerRef: ref, provider: group.provider },
    });

    return ok({ status: "requires_payment" });
  }

  const intent = await db.paymentIntent.findUnique({ where: { providerRef: ref } });
  if (!intent) throw new ApiError(404, "NOT_FOUND", "Payment not found");

  if (intent.status === "succeeded") {
    throw new ApiError(409, "ALREADY_PAID", "This payment was already completed");
  }
  if (intent.status !== "failed") {
    throw new ApiError(409, "NOT_RETRYABLE", "Only a failed payment can be retried");
  }
  if (intent.expiresAt.getTime() < Date.now()) {
    throw new ApiError(410, "SESSION_EXPIRED", "This payment session has expired — start a new checkout");
  }

  // C1.1 verification fix: conditional re-open (same rationale as the group
  // branch above) — never resurrect an expired/intent-succeeded session.
  const reopened = await db.paymentIntent.updateMany({
    where: { id: intent.id, status: "failed", expiresAt: { gt: new Date() } },
    data: { status: "requires_payment" },
  });
  if (reopened.count === 0) {
    const fresh = await db.paymentIntent.findUnique({ where: { id: intent.id }, select: { status: true } });
    if (fresh?.status === "succeeded") throw new ApiError(409, "ALREADY_PAID", "This payment was already completed");
    throw new ApiError(409, "NOT_RETRYABLE", "This payment session can no longer be retried — start a new checkout");
  }

  await logActivity({
    actorType: "shopper",
    action: "payment.retry",
    entityType: "order",
    entityId: intent.orderId,
    meta: { providerRef: ref, provider: intent.provider },
  });

  return ok({ status: "requires_payment" });
});
