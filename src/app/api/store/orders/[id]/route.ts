import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { parseJson } from "@/lib/json";

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

  return ok({
    ...order,
    shippingAddress: parseJson<Record<string, unknown>>(order.shippingAddressJson, {}),
    latestPaymentRef: order.paymentIntents[0]?.providerRef ?? null,
  });
});
