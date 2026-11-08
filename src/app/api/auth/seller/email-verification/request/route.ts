import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { requireSeller } from "@/lib/auth";
import { requireEmailChannel } from "@/lib/email-provider";
import { assertEmailOtpStorage, issueEmailOtp } from "@/lib/guest-otp";
import { getSellerEmailVerified } from "@/lib/seller-email-verification";
import type { SellerEvDoneData, SellerEvSentData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/auth/seller/email-verification/request — PHASE 2.3 (C2.7).
//
// Session-authenticated (the caller already owns the ACCOUNT; this flow
// proves ownership of the EMAIL on that account) — the seller-side twin of
// /api/auth/shopper/email-verification/request. Sends a 6-digit code to the
// session seller's OWN email (me.email — never a caller-supplied address), so
// a verified seller email is an honest signal for admin review (KYC queue /
// seller detail surface it) and for future PSP onboarding.
//
// Fail-closed: 503 EMAIL_PROVIDER_NOT_CONFIGURED / EMAIL_OTP_UNAVAILABLE /
// SELLER_EMAIL_VERIFICATION_UNAVAILABLE while no provider is configured, the
// EmailOtpChallenge table is un-migrated, or the loaded client predates the
// Phase 2.3 schema — verification simply stays unavailable (the safe
// direction); registration, onboarding and store operations are unaffected.
//
// Throttles: 5/min/IP + 3/hour per account. Challenge mechanics (TTL,
// attempts, carry-over, CAS) are shared with the guest-order OTP and live in
// src/lib/guest-otp.ts.
export const POST = handle(async (req: Request) => {
  const me = await requireSeller();
  rateLimit(req, "email-verification-request", 5);
  rateLimitKey(me.id, "email-verification-account", 3, 3_600_000);

  // Already verified → idempotent no-op (the caller's own state — revealing
  // it leaks nothing). Tolerant read: pre-migration reads as unverified.
  if (await getSellerEmailVerified(me.id)) {
    const payload: SellerEvDoneData = { alreadyVerified: true, sent: false };
    return ok(payload);
  }

  const channel = requireEmailChannel();
  await assertEmailOtpStorage();

  const result = await issueEmailOtp({
    purpose: "seller-email",
    subjectId: me.id,
    deliver: (code) =>
      channel.send({
        to: me.email,
        subject: "Verify your NOMOFEE seller email address",
        textBody:
          `Your NOMOFEE seller email verification code is ${code}.\n\n` +
          `It expires in 10 minutes. Verifying your email confirms you control this address and helps our team review your store faster.\n` +
          `If you did not create this NOMOFEE seller account, you can ignore this email.`,
        meta: { purpose: "seller-email", subjectId: me.id },
      }),
  });

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "seller.email_verification.request",
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
  const payload: SellerEvSentData = { sent: true, message: "A 6-digit code was sent to your email address. It expires in 10 minutes." };
  return ok(payload);
});
