import { db } from "@/lib/db";
import { handle, ok, ApiError, transitionOrder } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { fastForwardDelivery, mockPodUrl } from "@/lib/shipping";

export const dynamic = "force-dynamic";

// POST /api/me/orders/[orderNumber]/receive — buyer confirms receipt.
// Allowed from "shipped" OR "delivered" → status "completed", completedAt now,
// OrderStatusHistory {actor:"shopper"}. Repeat → 409 VALIDATION; unpaid → 409.
// Scoped by session shopperId (404 otherwise). If a platform shipment is still
// mid-flight it is fast-forwarded to DELIVERED first so the timeline never
// shows the parcel travelling after the buyer already has it.
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
  if (!["shipped", "delivered"].includes(order.status)) {
    throw new ApiError(409, "VALIDATION", `Order receipt cannot be confirmed from status '${order.status}'`);
  }

  const shipment = await db.shipment.findUnique({ where: { orderId: order.id } });
  if (shipment && shipment.providerId === "mock" && shipment.status !== "DELIVERED") {
    // Backfill skipped milestones + DELIVERED event with the mock POD photo.
    await fastForwardDelivery(order.id, new Date(), mockPodUrl(shipment.awbNumber ?? order.orderNumber));
  }

  await transitionOrder({
    orderId: order.id,
    toStatus: "completed",
    actor: "shopper",
    note: "Confirmed receipt by buyer",
    timestamps: { completedAt: new Date() },
  });
  const completed = await db.order.findUnique({
    where: { id: order.id },
    select: { id: true, orderNumber: true, status: true, completedAt: true },
  });

  return ok({
    id: completed!.id,
    orderNumber: completed!.orderNumber,
    status: completed!.status,
    completedAt: completed!.completedAt,
  });
});
