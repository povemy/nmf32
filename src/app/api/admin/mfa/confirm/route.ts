import { NextRequest } from "next/server";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireAdmin, revokeUserSessions } from "@/lib/auth";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { readBody, reqStr } from "@/app/api/admin/_helpers";
import { generateRecoveryCodes, getMfaEnrollment, isPrismaMissingTableError, verifyAdminPassword, verifyTotpForSecretEnc } from "@/lib/mfa";

export const dynamic = "force-dynamic";

// POST /api/admin/mfa/confirm { password, code } (C4) — complete enrollment:
// verify a live TOTP code against the UNCONFIRMED secret, set confirmedAt,
// mint the 10 one-time recovery codes, then revoke EVERY admin session.
//
// Session revocation is the documented invariant: every live session of a
// confirmed admin was minted THROUGH MFA — including this one, so the admin is
// signed out and signs back in with their authenticator. The recovery codes in
// this response are the ONLY time plaintext codes exist.
export const POST = handle(async (req: NextRequest) => {
  rateLimit(req, "admin-mfa", 10);
  const admin = await requireAdmin();
  const body = await readBody(req);
  const password = reqStr(body, "password", "Current password");
  const code = reqStr(body, "code", "Authenticator code");

  // Current-password reauthentication (uniform failure — no oracle).
  const row = await db.adminUser.findUnique({ where: { id: admin.id } });
  if (!row || !(await verifyAdminPassword(password, row.passwordHash))) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Current password is incorrect");
  }

  const enrollment = await getMfaEnrollment(admin.id);
  if (!enrollment) {
    throw new ApiError(404, "MFA_NOT_ENROLLED", "No enrollment in progress — start enrollment first");
  }
  if (enrollment.confirmedAt) {
    throw new ApiError(409, "MFA_ALREADY_ENROLLED", "Two-factor authentication is already enabled");
  }

  if (!verifyTotpForSecretEnc(enrollment.secretEnc, code)) {
    throw new ApiError(401, "INVALID_CODE", "That code didn't match — check your authenticator app and try again");
  }

  const { codes, hashesJson } = generateRecoveryCodes();
  try {
    await db.adminMfaEnrollment.update({
      where: { adminId: admin.id },
      data: { confirmedAt: new Date(), recoveryHashes: hashesJson },
    });
  } catch (e) {
    if (isPrismaMissingTableError(e)) {
      throw new ApiError(503, "MFA_NOT_MIGRATED", "MFA enrollment table missing — apply migration 20261101000002 first");
    }
    throw e;
  }

  // Invariant enforcement: ALL admin sessions die here (this one included) —
  // the next session is minted through the MFA login flow.
  const revokedSessions = await revokeUserSessions("admin", admin.id);

  await logActivity({
    actorType: "admin",
    actorId: admin.id,
    actorLabel: admin.email,
    action: "admin.mfa.confirmed",
    entityType: "admin_mfa",
    entityId: admin.id,
    meta: { revokedSessions },
  });

  return ok({ recoveryCodes: codes });
});
