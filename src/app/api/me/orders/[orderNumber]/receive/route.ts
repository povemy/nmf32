import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { fastForwardDelivery, mockPodUrl } from "@/lib/shipping";
import { approveAffiliateCommissionsForOrder } from "@/lib/affiliate";

export const dynamic = "force-dynamic";

// POST /api/me/orders/[orderNumber]/receive — buyer confirms receipt.
// ORDER-FLOW CORRECTION: "Order received" now transitions shipped|delivered →
// "received" (the buyer dashboard's To Rate bucket) with receivedAt now — it
// NO LONGER jumps straight to "completed". Completion happens later, on the
// buyer's rating (review submission flips received → completed) or after the
// 30-day rating window (order-maintenance cron, stage 2). Repeat → idempotent
// success (the already-received state is returned; NO second history row, NO
// second financial event). Unpaid → 409; any other state → 409.
//
// Scoped by session shopperId (404 otherwise — another buyer's order number
// is indistinguishable from "not found"). If a platform shipment is still
// mid-flight it is fast-forwarded to DELIVERED first so the timeline never
// shows the parcel travelling after the buyer already has it.
//
// RACE SAFETY (rewards work order §3.C): the status flip is a CONDITIONAL
// updateMany on status IN (shipped, delivered) — two concurrent taps converge
// on ONE received transition (the loser re-reads "received" and returns the
// idempotent success envelope). The history row is written only when the
// conditional flip actually changed a row, so repeat clicks can never
// duplicate receipt events. Settlement maturity is untouched: payouts mature
// days_after_paid (CommissionSetting), so confirming receipt neither releases
// nor duplicates seller funds; the affiliate approval is itself a conditional
// (status:"pending") update — idempotent under repeats and races.
export const POST = handle(async (_req: Request, ctx: { params: Promise<{ orderNumber: string }> }) => {
  const me = await requireShopper();
  const { orderNumber } = await ctx.params;

  const order = await db.order.findFirst({
    where: { orderNumber: orderNumber.trim().toUpperCase(), shopperId: me.id },
    select: { id: true, orderNumber: true, status: true, shopperId: true },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "No order with that number on your account");

  if (order.status === "payment_pending") {
    throw new ApiError(409, "INVALID_STATUS", "This order is not paid yet — complete payment before confirming receipt");
  }
  if (order.status === "received") {
    // Idempotent repeat: the receipt was already confirmed (this session or a
    // concurrent one) — return the settled state, no duplicate history/event.
    const done = await db.order.findUnique({
      where: { id: order.id },
      select: { id: true, orderNumber: true, status: true, receivedAt: true, completedAt: true },
    });
    return ok({
      id: done!.id,
      orderNumber: done!.orderNumber,
      status: done!.status,
      receivedAt: done!.receivedAt,
      completedAt: done!.completedAt,
      alreadyConfirmed: true,
    });
  }
  if (order.status === "completed") {
    // Post-window repeat (order already completed by rating or the 30-day
    // sweep) — same idempotent envelope, nothing to do.
    const done = await db.order.findUnique({
      where: { id: order.id },
      select: { id: true, orderNumber: true, status: true, receivedAt: true, completedAt: true },
    });
    return ok({
      id: done!.id,
      orderNumber: done!.orderNumber,
      status: done!.status,
      receivedAt: done!.receivedAt,
      completedAt: done!.completedAt,
      alreadyConfirmed: true,
    });
  }
  if (!["shipped", "delivered"].includes(order.status)) {
    throw new ApiError(409, "VALIDATION", `Order receipt cannot be confirmed from status '${order.status}'`);
  }

  const shipment = await db.shipment.findUnique({ where: { orderId: order.id } });
  if (shipment && shipment.providerId === "mock" && shipment.status !== "DELIVERED") {
    // Backfill skipped milestones + DELIVERED event with the mock POD photo.
    await fastForwardDelivery(order.id, new Date(), mockPodUrl(shipment.awbNumber ?? order.orderNumber));
  }

  // AFFILIATE — receipt is an authoritative completion state (as with deliver;
  // commissions were already approved at courier-delivery — this is the
  // idempotent belt-and-braces pass). Conditional + idempotent: repeat calls
  // find no "pending" commissions.
  try { await approveAffiliateCommissionsForOrder(order.id); } catch { /* best-effort */ }

  // CONDITIONAL flip: exactly one of N concurrent/racing requests transitions
  // shipped|delivered → received; the rest see count 0 and converge on the
  // idempotent envelope above. receivedAt starts the 30-day rating window.
  const flipped = await db.order.updateMany({
    where: { id: order.id, status: { in: ["shipped", "delivered"] } },
    data: { status: "received", receivedAt: new Date() },
  });

  if (flipped.count > 0) {
    // Receipt-confirmation history — written ONLY by the request that won the
    // conditional flip, so repeat clicks never duplicate the event.
    await db.orderStatusHistory.create({
      data: {
        orderId: order.id,
        fromStatus: order.status,
        toStatus: "received",
        actor: "shopper",
        note: "Confirmed receipt by buyer — rate within 30 days",
      },
    });
  }

  const received = await db.order.findUnique({
    where: { id: order.id },
    select: { id: true, orderNumber: true, status: true, receivedAt: true, completedAt: true },
  });

  return ok({
    id: received!.id,
    orderNumber: received!.orderNumber,
    status: received!.status,
    receivedAt: received!.receivedAt,
    completedAt: received!.completedAt,
  });
});
