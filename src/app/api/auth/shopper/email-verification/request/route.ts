import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { requireShopper } from "@/lib/auth";
import { requireEmailChannel } from "@/lib/email-provider";
import { assertEmailOtpStorage, issueEmailOtp, getShopperEmailVerified } from "@/lib/guest-otp";

export const dynamic = "force-dynamic";

// POST /api/auth/shopper/email-verification/request — FINAL CLOSURE §2.
//
// Session-authenticated (the caller already owns the ACCOUNT; this flow
// proves ownership of the EMAIL on that account). Sends a 6-digit code to
// the account's own email address (me.email — never caller-supplied).
//
// Until a verified challenge exists, claimGuestStateForShopper() refuses to
// transfer legacy guest orders into the account: registering with someone
// else's email must not claim that person's orders. The login/register
// responses carry emailVerified:false so the client can point the shopper
// here (Me → Profile card).
//
// Fail-closed: 503 EMAIL_PROVIDER_NOT_CONFIGURED / EMAIL_OTP_UNAVAILABLE
// while no provider is configured or migration 20261104000000 is unapplied —
// claiming simply stays disabled (the safe direction), registration and
// checkout are unaffected.
//
// Throttles: 5/min/IP + 3/hour per account. Challenge mechanics (TTL,
// attempts, carry-over, CAS) are shared with the guest-order OTP and live in
// src/lib/guest-otp.ts.
export const POST = handle(async (req: Request) => {
  const me = await requireShopper();
  rateLimit(req, "email-verification-request", 5);
  rateLimitKey(me.id, "email-verification-account", 3, 3_600_000);

  // Already verified → idempotent no-op (the caller's own state — revealing
  // it leaks nothing).
  if (await getShopperEmailVerified(me.id)) {
    return ok({ alreadyVerified: true, sent: false });
  }

  const channel = requireEmailChannel();
  await assertEmailOtpStorage();

  const result = await issueEmailOtp({
    purpose: "shopper-email",
    subjectId: me.id,
    deliver: (code) =>
      channel.send({
        to: me.email,
        subject: "Verify your NOMOFEE email address",
        textBody:
          `Your NOMOFEE email verification code is ${code}.\n\n` +
          `It expires in 10 minutes. Verifying your email lets orders placed as a guest with this address appear in your account.\n` +
          `If you did not create a NOMOFEE account, you can ignore this email.`,
        meta: { purpose: "shopper-email", subjectId: me.id },
      }),
  });

  await logActivity({
    actorType: "shopper",
    actorId: me.id,
    actorLabel: me.email,
    action: "shopper.email_verification.request",
    meta: { issued: result.issued, suppressed: result.suppressed ?? null },
  }).catch(() => undefined);

  if (!result.issued) {
    // The caller is authenticated (no uniformity requirement), but keep the
    // message non-specific so it cannot double as an account-state oracle
    // for anything the caller should not already know.
    throw new ApiError(
      429,
      "VERIFICATION_CODE_UNAVAILABLE",
      "A verification code could not be sent right now — wait for any earlier code to expire (10 minutes) and try again"
    );
  }
  return ok({ sent: true, message: "A 6-digit code was sent to your email address. It expires in 10 minutes." });
});
