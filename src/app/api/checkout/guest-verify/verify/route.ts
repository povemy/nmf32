import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import {
  assertEmailOtpStorage,
  verifyEmailOtp,
  issueGuestCheckoutToken,
  GUEST_CHECKOUT_TOKEN_TTL_MS,
} from "@/lib/guest-otp";

export const dynamic = "force-dynamic";

// POST /api/checkout/guest-verify/verify { email, code } — PHASE 2.2 GUEST
// CHECKOUT RESTORATION.
//
// Verifies the 6-digit code for the guest-checkout challenge bound to the
// email. On success the challenge row is CAS-CONSUMED (deleted — the same
// code can never verify twice; concurrent duplicates produce exactly ONE
// winner, identical to the guest-order purpose) and a short-lived
// verified-email token is minted:
//
//   • domain "gcv:v1:" — DISTINCT from "oag:v1:" order-access grants and from
//     "otp:v1:" code hashes; valid ONLY as the guest-order gate of
//     POST /api/checkout/create (which additionally requires the checkout's
//     customer.email to equal the token's email),
//   • HMAC-SHA256(EMAIL_OTP_SECRET, "gcv:v1:<email>:<expiryMs>") — keyed,
//     constant-time compared, rotation of the secret kills every outstanding
//     token instantly,
//   • 30-minute TTL, no refresh, never logged, never persisted client-side.
//
// Uniform 401 INVALID for: no challenge, expired code, locked challenge,
// wrong code, lost consume race. The distinct internal reasons exist for
// tests/audits only — clients always see the same 401.
//
// Throttling (mirrors /api/orders/otp/verify): 10/min per IP + 10/hour per
// email, PLUS the challenge's own bounded attempt counter (5, CAS-guarded).
export const POST = handle(async (req: Request) => {
  rateLimit(req, "guest-verify-verify", 10);
  const body = (await req.json().catch(() => ({}))) as { email?: string; code?: string };
  const email = (body.email ?? "").trim().toLowerCase();
  const code = (body.code ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !code || code.length > 12) {
    throw new ApiError(401, "INVALID", "That code is not valid");
  }
  rateLimitKey(email, "guest-verify-verify-email", 10, 3_600_000);

  // Uniform fail-closed pre-flight BEFORE touching the challenge table.
  await assertEmailOtpStorage();

  const result = await verifyEmailOtp({ purpose: "guest-checkout", subjectId: email, code });

  if (!result.ok) {
    // One uniform 401 for every failure mode — no oracle, no attempt-count
    // disclosure (the challenge's counter is internal).
    throw new ApiError(401, "INVALID", "That code is not valid");
  }

  const token = issueGuestCheckoutToken(email);
  // Audit WITHOUT the code and WITHOUT the token — the normalized email is
  // the durable correlation key.
  await logActivity({
    actorType: "shopper",
    actorLabel: "guest-checkout-otp",
    action: "checkout.guest_verify.verified",
    entityType: "email",
    entityId: null,
    meta: { tokenTtlMs: GUEST_CHECKOUT_TOKEN_TTL_MS },
  }).catch(() => undefined);

  return ok({ token, email, expiresAt: new Date(Date.now() + GUEST_CHECKOUT_TOKEN_TTL_MS).toISOString() });
});
