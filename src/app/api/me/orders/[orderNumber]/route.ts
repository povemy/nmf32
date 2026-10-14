import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/me/orders/[orderNumber] — account-scoped order detail for the
// signed-in buyer. Ownership is enforced by shopperId (claimed at login /
// checkout) — no order-number tweaking can read another buyer's order.
// Used by the order-status view when the guest email lookup doesn't apply.
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ orderNumber: string }> }) => {
  const me = await requireShopper();
  const { orderNumber } = await ctx.params;

  const order = await db.order.findFirst({
    where: { orderNumber: orderNumber.trim().toUpperCase(), shopperId: me.id },
    select: {
      orderNumber: true, status: true, totalMinor: true, createdAt: true,
      trackingNumber: true, customerEmail: true,
      store: { select: { id: true, name: true, slug: true } },
      items: { select: { title: true, qty: true } },
      history: { orderBy: { createdAt: "asc" }, select: { toStatus: true, createdAt: true } },
    },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "No order with that number on your account");

  return ok({
    orderNumber: order.orderNumber,
    status: order.status,
    totalMinor: order.totalMinor,
    storeName: order.store.name,
    storeId: order.store.id,
    storeSlug: order.store.slug,
    createdAt: order.createdAt,
    customerEmail: order.customerEmail, // lets the receipt endpoint work for account orders
    items: order.items.map((i) => ({ title: i.title, qty: i.qty })),
    history: order.history.map((h) => ({ toStatus: h.toStatus, createdAt: h.createdAt })),
  });
});
