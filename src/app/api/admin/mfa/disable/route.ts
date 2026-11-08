import { NextRequest } from "next/server";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireAdminUngated, revokeUserSessions } from "@/lib/auth";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { readBody, reqStr } from "@/app/api/admin/_helpers";
import type { MfaDisableBody, MfaDisableData } from "@/lib/types/api-contract";
import { getMfaEnrollment, isPrismaMissingTableError, matchRecoveryCode, verifyAdminPassword, verifyTotpForSecretEnc } from "@/lib/mfa";
import { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

// POST /api/admin/mfa/disable { password, code } (C4) — remove the enrollment
// after current-password + code reauthentication, then revoke every admin
// session (no zombie session may outlive a security-posture change).
//
// `code` is EITHER a live TOTP code (±1 step) OR an unused recovery code.
// (Recovery hashes are matched, not burned — the whole row is deleted right
// below.) Works on unconfirmed enrollments too, so a lost-key setup can be
// backed out with the app it was provisioned in.
export const POST = handle(async (req: NextRequest) => {
  rateLimit(req, "admin-mfa", 10);
  const admin = await requireAdminUngated();
  const body = (await readBody(req)) as MfaDisableBody & Record<string, unknown>;
  const password = reqStr(body, "password", "Current password");
  const code = reqStr(body, "code", "Authenticator or recovery code");

  // Current-password reauthentication (uniform failure — no oracle).
  const row = await db.adminUser.findUnique({ where: { id: admin.id } });
  if (!row || !(await verifyAdminPassword(password, row.passwordHash))) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Current password is incorrect");
  }

  const enrollment = await getMfaEnrollment(admin.id);
  if (!enrollment) {
    throw new ApiError(404, "MFA_NOT_ENROLLED", "Two-factor authentication is not enabled");
  }

  const codeOk =
    verifyTotpForSecretEnc(enrollment.secretEnc, code) || matchRecoveryCode(enrollment.recoveryHashes, code) >= 0;
  if (!codeOk) {
    throw new ApiError(401, "INVALID_CODE", "That code didn't match — check your authenticator app and try again");
  }

  try {
    await db.adminMfaEnrollment.delete({ where: { adminId: admin.id } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      // Concurrent disable already removed the row — idempotent success.
    } else if (isPrismaMissingTableError(e)) {
      throw new ApiError(503, "MFA_NOT_MIGRATED", "MFA enrollment table missing — apply migration 20261101000002 first");
    } else {
      throw e;
    }
  }

  const revokedSessions = await revokeUserSessions("admin", admin.id);

  await logActivity({
    actorType: "admin",
    actorId: admin.id,
    actorLabel: admin.email,
    action: "admin.mfa.disabled",
    entityType: "admin_mfa",
    entityId: admin.id,
    meta: { revokedSessions },
  });

  const payload: MfaDisableData = { disabled: true, revokedSessions };
  return ok(payload);
});
