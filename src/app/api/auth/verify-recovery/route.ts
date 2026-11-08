import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { db } from "@/lib/db";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { assertEmailOtpStorage, verifyEmailOtp } from "@/lib/guest-otp";
import {
  normalizeRecoveryEmail,
  issuePasswordResetGrant,
  passwordEpochTag,
  PASSWORD_RESET_GRANT_TTL_MS,
} from "@/lib/password-recovery";
import type { VerifyRecoveryBody, VerifyRecoveryData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/auth/verify-recovery { email, code } — WORK ORDER 1: shopper
// password recovery, step B.
//
// Verifies the 6-digit recovery code for the "password-reset" challenge bound
// to the email. On success the challenge row is CAS-CONSUMED (deleted — the
// same code can never verify twice; concurrent duplicates produce exactly ONE
// winner, identical to the guest-order / guest-checkout purposes) and a
// short-lived reset grant is minted:
//
//   • domain "prg:v1:" — DISTINCT from "gcv:v1:" guest-checkout tokens,
//     "oag:v1:" order-access grants and "otp:v1:" code hashes; valid ONLY as
//     the grant of POST /api/auth/reset-password,
//   • HMAC-SHA256(EMAIL_OTP_SECRET, "prg:v1:<email>:<expiry>:<pwTag>") —
//     keyed, constant-time compared, rotation of the secret kills every
//     outstanding grant instantly,
//   • 15-minute TTL, no refresh, stateless MAC, never logged, never persisted
//     client-side (the SPA keeps it in memory only),
//   • pwTag binds the grant to the account's CURRENT password epoch — the
//     reset route re-derives it, so the grant dies the moment any password
//     change lands (single-use semantics without new state).
//
// Uniform 401 INVALID for: no challenge, expired code, locked challenge,
// wrong code, lost consume race, missing/ineligible account. The distinct
// internal reasons exist for tests/audits only — clients always see the same
// 401, so a prober learns nothing about whether an account exists.
//
// Throttling (mirrors /api/checkout/guest-verify/verify): 10/min per IP +
// 10/hour per email, PLUS the challenge's own bounded attempt counter (5,
// CAS-guarded — counters carry over across re-issued codes while live).
export const POST = handle(async (req: Request) => {
  rateLimit(req, "auth-recovery-verify", 10);
  const body = (await req.json().catch(() => ({}))) as VerifyRecoveryBody;
  const email = normalizeRecoveryEmail(body.email);
  const code = (body.code ?? "").trim();
  if (!email || !code || code.length > 12) {
    throw new ApiError(401, "INVALID", "That code is not valid");
  }
  rateLimitKey(email, "auth-recovery-verify-email", 10, 3_600_000);

  // Uniform fail-closed pre-flight BEFORE touching the challenge table.
  await assertEmailOtpStorage();

  // The grant binds the CURRENT password epoch — resolve the account first
  // (a missing/ineligible account cannot proceed even with a valid code: the
  // challenge only exists because the account was eligible at request time).
  const shopper = await db.shopperUser.findUnique({
    where: { email },
    select: { id: true, status: true, passwordHash: true },
  });

  const result = shopper && shopper.status === "active"
    ? await verifyEmailOtp({ purpose: "password-reset", subjectId: email, code })
    : { ok: false as const, reason: "no-challenge" as const };

  if (!result.ok) {
    // One uniform 401 for every failure mode — no oracle, no attempt-count
    // disclosure (the challenge's counter is internal).
    throw new ApiError(401, "INVALID", "That code is not valid");
  }

  const token = issuePasswordResetGrant(email, passwordEpochTag(shopper!.passwordHash));
  // Audit WITHOUT the code and WITHOUT the token — the normalized email is
  // the durable correlation key.
  await logActivity({
    actorType: "shopper",
    actorId: shopper!.id,
    actorLabel: email,
    action: "shopper.password_reset.verified",
    entityType: "email",
    entityId: shopper!.id,
    meta: { grantTtlMs: PASSWORD_RESET_GRANT_TTL_MS },
  }).catch(() => undefined);

  const payload: VerifyRecoveryData = {
    token,
    email,
    expiresAt: new Date(Date.now() + PASSWORD_RESET_GRANT_TTL_MS).toISOString(),
  };
  return ok(payload);
});
