import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import {
  assertEmailOtpStorage,
  verifyEmailOtp,
  issueOrderAccessGrant,
  ORDER_ACCESS_GRANT_TTL_MS,
} from "@/lib/guest-otp";

export const dynamic = "force-dynamic";

// POST /api/orders/otp/verify { email, orderNumber, code } — FINAL CLOSURE §1.
//
// Verifies the 6-digit code for the guest-order challenge bound to
// (email, orderNumber). On success the challenge row is CAS-CONSUMED
// (deleted — the same code can never verify twice; concurrent duplicates
// produce exactly one winner) and a short-lived, order-specific access grant
// is minted. The response contains the grant ONLY — never order data — so it
// stays uniform in size and timing whether the pair matched or not.
//
// Uniform 401 INVALID for: no such order, non-matching pair, no challenge,
// expired code, locked challenge, wrong code, lost consume race. The distinct
// internal reasons exist for tests/audits only — clients always see the same
// 401. The storage pre-flight (503, uniform) runs BEFORE the order lookup so
// a pre-migration deployment cannot become an existence oracle.
//
// Throttling (same axes as the old knowledge-pair lookup):
//   • 10/min per IP · 10/hour per email · 30/hour per order number
//   PLUS the challenge's own bounded attempt counter (5, CAS-guarded).
//
// Grant properties (src/lib/guest-otp.ts): order-specific, purpose-specific
// ("oag:v1:" domain + dedicated ORDER_ACCESS_SECRET), 15-minute TTL, no
// refresh, HMAC-protected, never logged, never written to client-side
// persistent storage (the SPA keeps it in memory only).
export const POST = handle(async (req: Request) => {
  rateLimit(req, "orders-otp-verify", 10);
  const body = (await req.json().catch(() => ({}))) as {
    email?: string;
    orderNumber?: string;
    code?: string;
  };
  const email = (body.email ?? "").trim().toLowerCase();
  const orderNumber = (body.orderNumber ?? "").trim();
  const code = (body.code ?? "").trim();
  if (!email.includes("@") || !orderNumber || !code) {
    throw new ApiError(401, "INVALID", "That code is not valid for this order");
  }
  if (email.length > 254 || orderNumber.length > 32 || code.length > 12) {
    throw new ApiError(401, "INVALID", "That code is not valid for this order");
  }
  rateLimitKey(email, "orders-otp-verify-email", 10, 3_600_000);
  rateLimitKey(orderNumber, "orders-otp-verify-order", 30, 3_600_000);

  // Uniform fail-closed pre-flight BEFORE the order lookup.
  await assertEmailOtpStorage();

  // One indexed read; the email half of the knowledge pair is compared in the
  // app layer (case-fold parity with the legacy lookup route).
  const order = await db.order.findUnique({
    where: { orderNumber },
    select: { id: true, customerEmail: true },
  });
  const matched = !!order && order.customerEmail.toLowerCase() === email;

  const result = matched && order
    ? await verifyEmailOtp({ purpose: "guest-order", subjectId: order.id, code })
    : ({ ok: false, reason: "no-challenge" } as const);

  if (!result.ok || !order) {
    // One uniform 401 for every failure mode — no oracle, no attempt-count
    // disclosure (the challenge's counter is internal).
    throw new ApiError(401, "INVALID", "That code is not valid for this order");
  }

  const accessGrant = issueOrderAccessGrant(order.id);
  // Audit WITHOUT the code and WITHOUT the grant token — the order id is the
  // durable correlation key.
  await logActivity({
    actorType: "shopper",
    actorLabel: "guest-order-otp",
    action: "order.otp.verified",
    entityType: "order",
    entityId: order.id,
    meta: { grantTtlMs: ORDER_ACCESS_GRANT_TTL_MS },
  }).catch(() => undefined);

  return ok({ accessGrant, grantExpiresInMs: ORDER_ACCESS_GRANT_TTL_MS });
});
