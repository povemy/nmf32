import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// GET /api/orders/lookup?email=&orderNumber= — guest order tracking.
// Phase 1 (SEC-05 / B2 / B4): the human-readable NM- order numbers are
// KEPT (support feature) but can never act as an authentication credential
// on their own — the email half of the knowledge pair is required, and the
// endpoint is throttled on THREE independent axes so sequential-number
// brute-force is infeasible:
//   • 10/min per IP            (rateLimit)
//   • 10/hour per EMAIL        (identity-keyed — many IPs, one victim)
//   • 30/hour per ORDER NUMBER (identity-keyed — many emails, one order)
// Uniform 404 for missing-order and email-mismatch — no enumeration oracle.
export const GET = handle(async (req: Request) => {
  rateLimit(req, "orders-lookup", 10);
  const url = new URL(req.url);
  const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  const orderNumber = (url.searchParams.get("orderNumber") ?? "").trim();
  if (!email || !orderNumber) {
    throw new ApiError(400, "VALIDATION", "email and orderNumber are required");
  }
  if (email.length > 254 || orderNumber.length > 32) {
    throw new ApiError(400, "VALIDATION", "email and orderNumber are required");
  }
  rateLimitKey(email, "orders-lookup-email", 10, 3_600_000);
  rateLimitKey(orderNumber, "orders-lookup-order", 30, 3_600_000);

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
