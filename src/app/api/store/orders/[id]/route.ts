import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { parseJson } from "@/lib/json";
import type {
  SellerOrderDetailData,
  SellerOrderItemRow,
  SellerOrderHistoryRow,
  SellerOrderPaymentIntentRow,
  SellerOrderRefundRow,
} from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/store/orders/[id] — full detail: order + items + history.
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { store } = await requireActiveSellerStore();
  const { id } = await ctx.params;

  const order = await db.order.findFirst({
    where: { OR: [{ id }, { orderNumber: id }], storeId: store.id },
    include: {
      items: true,
      history: { orderBy: { createdAt: "asc" } },
      paymentIntents: { orderBy: { createdAt: "desc" } },
      refunds: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");

  const payload: SellerOrderDetailData = {
    ...order,
    paidAt: order.paidAt ? order.paidAt.toISOString() : null,
    fulfilledAt: order.fulfilledAt ? order.fulfilledAt.toISOString() : null,
    shippedAt: order.shippedAt ? order.shippedAt.toISOString() : null,
    deliveredAt: order.deliveredAt ? order.deliveredAt.toISOString() : null,
    receivedAt: order.receivedAt ? order.receivedAt.toISOString() : null,
    completedAt: order.completedAt ? order.completedAt.toISOString() : null,
    cancelledAt: order.cancelledAt ? order.cancelledAt.toISOString() : null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    shippingAddress: parseJson<Record<string, unknown>>(order.shippingAddressJson, {}),
    latestPaymentRef: order.paymentIntents[0]?.providerRef ?? null,
    items: order.items.map(
      (it): SellerOrderItemRow => ({
        ...it,
      })
    ),
    history: order.history.map(
      (h): SellerOrderHistoryRow => ({
        ...h,
        createdAt: h.createdAt.toISOString(),
      })
    ),
    paymentIntents: order.paymentIntents.map(
      (p): SellerOrderPaymentIntentRow => ({
        ...p,
        expiresAt: p.expiresAt.toISOString(),
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      })
    ),
    refunds: order.refunds.map(
      (r): SellerOrderRefundRow => ({
        ...r,
        processedAt: r.processedAt ? r.processedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })
    ),
  };
  return ok(payload);
});
