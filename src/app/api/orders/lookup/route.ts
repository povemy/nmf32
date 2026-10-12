import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";

export const dynamic = "force-dynamic";

// GET /api/orders/lookup?email=&orderNumber= — guest order tracking.
export const GET = handle(async (req: Request) => {
  const url = new URL(req.url);
  const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  const orderNumber = (url.searchParams.get("orderNumber") ?? "").trim();
  if (!email || !orderNumber) {
    throw new ApiError(400, "VALIDATION", "email and orderNumber are required");
  }

  const order = await db.order.findUnique({
    where: { orderNumber },
    include: {
      items: { select: { title: true, qty: true } },
      history: { orderBy: { createdAt: "asc" }, select: { toStatus: true, createdAt: true } },
      store: { select: { name: true, slug: true, id: true } },
    },
  });

  // SQLite has no case-insensitive filter — compare in app layer.
  if (!order || order.customerEmail.toLowerCase() !== email) {
    throw new ApiError(404, "NOT_FOUND", "No order found for that email and order number");
  }

  return ok({
    orderNumber: order.orderNumber,
    status: order.status,
    totalMinor: order.totalMinor,
    storeName: order.store.name,
    storeId: order.store.id,
    storeSlug: order.store.slug,
    createdAt: order.createdAt,
    items: order.items.map((i) => ({ title: i.title, qty: i.qty })),
    history: order.history.map((h) => ({ toStatus: h.toStatus, createdAt: h.createdAt })),
  });
});
