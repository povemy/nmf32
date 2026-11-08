import { db } from "@/lib/db";
import { handle, ok, ApiError, notify, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import type { RefundRequestBody, RefundRequestData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/store/orders/[id]/refund-request {amountMinor, reason?, restock?}
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { me, store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as RefundRequestBody;

  const amountMinor = Math.round(Number(body.amountMinor));
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    throw new ApiError(400, "VALIDATION", "amountMinor must be a positive integer");
  }

  const order = await db.order.findFirst({
    where: { OR: [{ id }, { orderNumber: id }], storeId: store.id },
    include: { refunds: true },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");

  const refundableStatuses = ["paid", "processing", "shipped", "delivered", "received", "completed"];
  if (!refundableStatuses.includes(order.status)) {
    throw new ApiError(409, "INVALID_STATUS", `Cannot request refund for order in status '${order.status}'`);
  }

  const alreadyRequested = order.refunds.filter((r) => r.status !== "rejected").reduce((s, r) => s + r.amountMinor, 0);
  if (amountMinor > order.totalMinor - alreadyRequested) {
    throw new ApiError(409, "INVALID_AMOUNT", "Refund amount exceeds refundable balance");
  }

  const refund = await db.refund.create({
    data: {
      orderId: order.id,
      amountMinor,
      reason: body.reason != null ? String(body.reason) : null,
      status: "requested",
      requestedBy: "seller",
      restock: body.restock === undefined ? true : !!body.restock,
    },
  });

  await notify({
    event: "refund.requested",
    channel: "email",
    recipient: "admin@nomofee.io",
    subject: `Refund requested for ${order.orderNumber}`,
  });
  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "refund.requested",
    entityType: "refund",
    entityId: refund.id,
    meta: { orderNumber: order.orderNumber, amountMinor },
  });

  const payload: RefundRequestData = {
    ...refund,
    processedAt: refund.processedAt ? refund.processedAt.toISOString() : null,
    createdAt: refund.createdAt.toISOString(),
    updatedAt: refund.updatedAt.toISOString(),
  };
  return ok(payload, { status: 201 });
});
