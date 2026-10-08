import { db } from "@/lib/db";
import { handle, ok, ApiError, transitionOrder, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";

export const dynamic = "force-dynamic";

// POST /api/store/orders/[id]/fulfill — paid → processing (+fulfilledAt).
export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { me, store } = await requireActiveSellerStore();
  const { id } = await ctx.params;

  const order = await db.order.findFirst({ where: { OR: [{ id }, { orderNumber: id }], storeId: store.id } });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
  if (!["paid", "processing"].includes(order.status)) {
    throw new ApiError(409, "INVALID_STATUS", `Cannot fulfill order in status '${order.status}'`);
  }

  await transitionOrder({
    orderId: order.id,
    toStatus: "processing",
    actor: "seller",
    note: `Fulfilled by ${me.displayName}`,
    timestamps: { fulfilledAt: new Date() },
  });

  const fresh = await db.order.findUnique({ where: { id: order.id } });
  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "order.fulfilled",
    entityType: "order",
    entityId: order.id,
    meta: { orderNumber: order.orderNumber },
  });

  return ok({ id: fresh!.id, status: fresh!.status, fulfilledAt: fresh!.fulfilledAt });
});
