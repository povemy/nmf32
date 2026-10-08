import { db } from "@/lib/db";
import { handle, ok, ApiError, transitionOrder, dispatchStoreWebhooks, notify, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";

export const dynamic = "force-dynamic";

// POST /api/store/orders/[id]/ship {provider, trackingNumber}
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { me, store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const provider = String(body.provider ?? "").trim();
  const trackingNumber = String(body.trackingNumber ?? "").trim();
  if (!provider || !trackingNumber) {
    throw new ApiError(400, "VALIDATION", "provider and trackingNumber are required");
  }

  const order = await db.order.findFirst({ where: { OR: [{ id }, { orderNumber: id }], storeId: store.id } });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
  if (!["paid", "processing"].includes(order.status)) {
    throw new ApiError(409, "INVALID_STATUS", `Cannot ship order in status '${order.status}'`);
  }

  await transitionOrder({
    orderId: order.id,
    toStatus: "shipped",
    actor: "seller",
    note: `Shipped via ${provider}: ${trackingNumber}`,
    timestamps: { shippedAt: new Date() },
  });

  const fresh = await db.order.update({
    where: { id: order.id },
    data: { trackingProvider: provider, trackingNumber },
  });

  await dispatchStoreWebhooks({
    storeId: store.id,
    event: "order.shipped",
    payload: { orderNumber: order.orderNumber, tracking: trackingNumber, provider },
  });

  await notify({
    event: "order.shipped",
    channel: "email",
    recipient: order.customerEmail,
    subject: `Your order ${order.orderNumber} has shipped`,
  });

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "order.shipped",
    entityType: "order",
    entityId: order.id,
    meta: { orderNumber: order.orderNumber, provider, trackingNumber },
  });

  return ok({
    id: fresh.id,
    status: fresh.status,
    shippedAt: fresh.shippedAt,
    trackingNumber,
    trackingProvider: provider,
  });
});
