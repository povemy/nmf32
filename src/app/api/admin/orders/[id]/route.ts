import { NextRequest } from "next/server";
import { handle, ok, ApiError } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/admin/orders/[id] — full order dossier
export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  await requireAdmin();
  const { id } = await ctx.params;

  const order = await db.order.findUnique({
    where: { id },
    include: {
      store: { include: { seller: { select: { id: true, email: true, displayName: true, fullName: true } } } },
      items: true,
      history: { orderBy: { createdAt: "asc" } },
      paymentIntents: { orderBy: { createdAt: "desc" } },
      refunds: { orderBy: { createdAt: "desc" } },
      disputes: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");

  // Store.sellerId is nullable in the schema — no seller → no wallet (was a
  // TypeError 500 before; findUnique already returns Wallet|null downstream).
  const sellerId = order.store.seller?.id;
  const wallet = sellerId ? await db.wallet.findUnique({ where: { sellerId: sellerId } }) : null;

  return ok({
    order,
    items: order.items,
    history: order.history,
    paymentIntents: order.paymentIntents,
    refunds: order.refunds,
    dispute: order.disputes[0] ?? null,
    disputes: order.disputes,
    seller: order.store.seller,
    store: { id: order.store.id, name: order.store.name, slug: order.store.slug },
    wallet,
  });
});
