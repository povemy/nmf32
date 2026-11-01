import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSession } from "@/lib/auth";
import { verifyOrderAccessGrant } from "@/lib/guest-otp";

export const dynamic = "force-dynamic";

// GET /api/orders/lookup?orderNumber=NM-… — guest order tracking.
//
// FINAL CLOSURE §1 — CORRECTED AUTHORIZATION MODEL. The knowledge pair
// (email + order number) NO LONGER AUTHORZES anything: it can only REQUEST
// an email-OTP challenge on POST /api/orders/otp/request. Sensitive order
// data is released ONLY to:
//   (a) a short-lived, order-specific access grant
//       ("Authorization: Bearer v1.<orderId>.<expiry>.<hmac>") minted after a
//       successful OTP verification — proof that the requester controls the
//       email address ON the order; or
//   (b) an authenticated shopper session that OWNS the order
//       (order.shopperId === me.id — normal account ownership).
// Unauthenticated requests without a grant receive a uniform 401
// ORDER_VERIFICATION_REQUIRED and NEVER touch the order table — no
// order-existence oracle, no customer PII for unverified callers.
//
// Throttles (retained; axes re-tuned to the new model):
//   • 10/min per IP (unchanged)
//   • 300/hour per order number — a polling-friendly cap for the 12-second
//     status-view refresh. The old 30/h anti-enumeration cap moved to the
//     OTP request route (3/h/email, 5/h/order, 3/h/pair) where the knowledge
//     pair is now accepted; grant/session holders are authenticated by
//     cryptography/ownership, so a generous per-order ceiling adds no
//     enumeration surface.
export const GET = handle(async (req: Request) => {
  rateLimit(req, "orders-lookup", 10);
  const url = new URL(req.url);
  const orderNumber = (url.searchParams.get("orderNumber") ?? "").trim();
  if (!orderNumber) {
    throw new ApiError(400, "VALIDATION", "orderNumber is required");
  }
  if (orderNumber.length > 32) {
    throw new ApiError(400, "VALIDATION", "orderNumber is required");
  }
  rateLimitKey(orderNumber, "orders-lookup-order", 300, 3_600_000);

  // ---- Authorization: (a) order-access grant, then (b) owning session ----
  let order: Awaited<ReturnType<typeof loadOrder>> | null = null;

  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    const grant = verifyOrderAccessGrant(authHeader.slice(7).trim());
    if (grant) {
      order = await loadOrder({ id: grant.orderId });
      // The grant is order-specific: the requested orderNumber must be the
      // granted order's own number (defense in depth).
      if (order && order.orderNumber !== orderNumber) order = null;
    }
    // Invalid/expired grant → fall through to the session path (the same
    // Bearer header cannot also be a session token: grants are not hex).
  }

  if (!order) {
    const session = await getSession();
    if (session?.userType === "shopper") {
      order = await loadOrder({ orderNumber });
      if (order && order.shopperId !== session.userId) order = null;
    }
  }

  if (!order) {
    // Uniform for: no order, someone else's order, no grant, expired grant,
    // unauthenticated. No DB row is examined on the unauthenticated path.
    throw new ApiError(
      401,
      "ORDER_VERIFICATION_REQUIRED",
      "Verify access to this order with the code sent to its email address, or sign in to the account that owns it"
    );
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

// ---------------------------------------------------------------- loaders

const INCLUDE = {
  items: { select: { title: true, qty: true } },
  history: { orderBy: { createdAt: "asc" }, select: { toStatus: true, createdAt: true } },
  store: { select: { name: true, slug: true, id: true } },
} as const;

function loadOrder(where: { id: string } | { orderNumber: string }) {
  return db.order.findUnique({ where, include: INCLUDE });
}
