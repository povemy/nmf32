import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { requireEmailChannel, type TransactionalEmailChannel } from "@/lib/email-provider";
import { assertEmailOtpStorage, issueEmailOtp } from "@/lib/guest-otp";
import type { GuestVerifyRequestBody, GuestVerifyRequestData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/checkout/guest-verify/request { email } — PHASE 2.2 GUEST
// CHECKOUT RESTORATION.
//
// Lets an UNAUTHENTICATED buyer request a 6-digit code that proves ownership
// of the email they intend to check out with. Mirrors
// /api/orders/otp/request (guest-order) and
// /api/auth/shopper/email-verification/request (shopper-email) — the SAME
// shared OTP machinery (src/lib/guest-otp.ts) with a NEW purpose
// "guest-checkout".
//
// Authorization model (unchanged posture): requesting a code authorizes
// NOTHING. The knowledge of an email address only buys a delivery attempt to
// THAT address. Sensitive effects (order creation with guest ownership) still
// require a successfully CONSUMED code (verify route) — and the resulting
// short-lived "gcv:v1:" token is bound to the verified email.
//
// Delivery goes through the EXISTING transactional email channel — exactly
// the `deliver` convention of the two sibling routes (channel.send with
// meta carrying purpose/subject only, never the code in logs). Fail-closed
// pre-flights BEFORE issuance: no provider → uniform 503; OTP storage not
// migrated → uniform 503.
//
// Throttling (mirrors the sibling conventions — 5/min/IP + 3/h/email):
//   • 5/min per IP
//   • 3/hour per email (identity-keyed — many IPs, one mailbox)
const MESSAGE =
  "If that address is valid, a 6-digit verification code has been sent to it. It expires in 10 minutes.";

export const POST = handle(async (req: Request) => {
  rateLimit(req, "guest-verify-request", 5);
  const body = (await req.json().catch(() => ({}))) as GuestVerifyRequestBody;
  const email = (body.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new ApiError(400, "VALIDATION", "A valid email address is required");
  }
  rateLimitKey(email, "guest-verify-email", 3, 3_600_000);

  // Fail-closed pre-flights BEFORE any challenge write (uniform for every
  // caller — no account/order existence is involved here, but the same
  // posture keeps deployments without email delivery safe by default).
  const channel: TransactionalEmailChannel = requireEmailChannel();
  await assertEmailOtpStorage();

  const result = await issueEmailOtp({
    purpose: "guest-checkout",
    subjectId: email,
    deliver: (code) =>
      channel.send({
        to: email,
        subject: "Your NOMOFEE checkout verification code",
        textBody:
          `Your verification code for NOMOFEE guest checkout is ${code}.\n\n` +
          `It expires in 10 minutes. You need it once to place your order without an account.\n` +
          `If you did not request it, you can ignore this email.\n` +
          `NOMOFEE will never ask you to reply with this code.`,
        meta: { purpose: "guest-checkout", subjectId: email },
      }),
  });

  // Audit WITHOUT the code — the normalized email is the durable correlation
  // key here (there is no order/account id yet). Delivery failures are
  // recorded via the suppressed flag.
  await logActivity({
    actorType: "shopper",
    actorLabel: "guest-checkout-otp",
    action: "checkout.guest_verify.request",
    entityType: "email",
    entityId: null,
    meta: { issued: result.issued, suppressed: result.suppressed ?? null },
  }).catch(() => undefined);

  if (!result.issued) {
    // Locked challenge / delivery failure — the caller knows their own request
    // state, so a non-specific 429 (same shape as the authenticated sibling
    // route) leaks nothing: wait for the row to expire and retry.
    throw new ApiError(
      429,
      "VERIFICATION_CODE_UNAVAILABLE",
      "A verification code could not be sent right now — wait for any earlier code to expire (10 minutes) and try again"
    );
  }
  const payload: GuestVerifyRequestData = { sent: true, message: MESSAGE };
  return ok(payload);
});
