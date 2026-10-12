import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";

export const dynamic = "force-dynamic";

// POST /api/checkout/payments/[ref]/retry — re-open a FAILED payment session.
// Mirrors a gateway's "initiate a new attempt" call: only a failed intent can be
// retried; a succeeded (or already-processing) one can never be re-opened here.
export const POST = handle(async (_req: Request, ctx: { params: Promise<{ ref: string }> }) => {
  const { ref } = await ctx.params;
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

  const updated = await db.paymentIntent.update({
    where: { id: intent.id },
    data: { status: "requires_payment" },
  });

  await logActivity({
    actorType: "shopper",
    action: "payment.retry",
    entityType: "order",
    entityId: intent.orderId,
    meta: { providerRef: ref, provider: intent.provider },
  });

  return ok({ status: updated.status });
});
