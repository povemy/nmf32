import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { db } from "@/lib/db";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { revokeUserSessions } from "@/lib/auth";
import { hashPasswordAsync } from "@/lib/password";
import { verifyPasswordResetGrant, passwordEpochTag } from "@/lib/password-recovery";
import type { ResetPasswordBody, ResetPasswordData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/auth/reset-password { token, newPassword } — WORK ORDER 1:
// shopper password recovery, step C.
//
// Consumes the "prg:v1:" reset grant minted by /api/auth/verify-recovery and
// establishes the new password. Fail-closed on EVERY grant defect: wrong
// shape, tampered MAC, expired, minted against an older password epoch
// (i.e. already used — the pwTag binding), missing/ineligible account.
//
//   • password policy — the SAME rule as registration (≥ 8 chars, capped at
//     200 to bound scrypt input), so the two entry points can never drift;
//   • hashing — hashPasswordAsync (the SAME s1: scrypt format every login /
//     register path verifies);
//   • supersede — after a successful reset, ANY remaining live
//     "password-reset" challenge row for the address is deleted (a code
//     requested but never verified can no longer mint a new grant);
//   • session revocation — revokeUserSessions("shopper", id), the F-02
//     primitive: every live session of the account dies immediately, so a
//     stolen browser session cannot survive the credential change;
//   • audit — shopper.password_reset.completed WITHOUT the password, the
//     grant, or any hash material (sessionsRevoked count only).
//
// Throttling: 10/min per IP + 10/hour per grant-email. A replayed grant is
// worthless anyway (pwTag mismatch after the first reset), but the throttles
// keep the route's brute-force surface identical to its siblings.
export const POST = handle(async (req: Request) => {
  rateLimit(req, "auth-password-reset", 10);
  const body = (await req.json().catch(() => ({}))) as ResetPasswordBody;
  const token = typeof body.token === "string" ? body.token : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (!token || token.length > 4096) {
    throw new ApiError(401, "INVALID_GRANT", "This recovery session is not valid");
  }
  if (newPassword.length < 8) {
    throw new ApiError(400, "VALIDATION", "Password must be at least 8 characters");
  }
  if (newPassword.length > 200) {
    throw new ApiError(400, "VALIDATION", "Password cannot exceed 200 characters");
  }

  // Resolve the account THROUGH the grant (the grant carries the email) —
  // never from a caller-supplied email field, which could name any account.
  const probe = probeGrantEmail(token);
  if (probe) rateLimitKey(probe, "auth-password-reset-email", 10, 3_600_000);

  const shopper = probe
    ? await db.shopperUser.findUnique({ where: { email: probe }, select: { id: true, status: true, passwordHash: true } })
    : null;
  if (!shopper || shopper.status !== "active") {
    throw new ApiError(401, "INVALID_GRANT", "This recovery session is not valid");
  }

  // pwTag binding: the grant must have been minted against the CURRENT
  // password epoch — used/expired/rotated grants all fail here.
  const grant = verifyPasswordResetGrant(token, passwordEpochTag(shopper.passwordHash));
  if (!grant) {
    throw new ApiError(401, "INVALID_GRANT", "This recovery session is not valid or has expired");
  }

  const passwordHash = await hashPasswordAsync(newPassword);
  await db.shopperUser.update({ where: { id: shopper.id }, data: { passwordHash } });

  // Supersede any remaining live recovery challenge for this address (a code
  // requested but never verified must not survive the reset it was racing).
  await db.emailOtpChallenge
    .deleteMany({ where: { purpose: "password-reset", subjectId: grant.email } })
    .catch(() => undefined);

  // F-02 primitive: every live session dies with the old credential.
  const sessionsRevoked = await revokeUserSessions("shopper", shopper.id);

  await logActivity({
    actorType: "shopper",
    actorId: shopper.id,
    actorLabel: grant.email,
    action: "shopper.password_reset.completed",
    entityType: "shopper",
    entityId: shopper.id,
    meta: { sessionsRevoked },
  }).catch(() => undefined);

  const payload: ResetPasswordData = {
    reset: true,
    message: "Your password has been changed. Sign in with your new password — all other sessions were signed out.",
  };
  return ok(payload);
});

/** Best-effort extraction of the grant's bound email for the identity-keyed
 *  throttle — WITHOUT validating the MAC (the throttle must fire even for
 *  garbage tokens hammering the route). Returns null for non-grant shapes. */
function probeGrantEmail(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const email = Buffer.from(parts[1], "base64url").toString("utf8");
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email.toLowerCase() : null;
  } catch {
    return null;
  }
}
