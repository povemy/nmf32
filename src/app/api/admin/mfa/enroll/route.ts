import { NextRequest } from "next/server";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { readBody, reqStr } from "@/app/api/admin/_helpers";
import {
  encryptSecret,
  generateTotpSecret,
  getMfaEnrollment,
  isPrismaMissingTableError,
  mfaEncryptionConfigured,
  otpauthUrl,
  verifyAdminPassword,
} from "@/lib/mfa";

export const dynamic = "force-dynamic";

// POST /api/admin/mfa/enroll { password } (C4) — start (or restart) TOTP
// enrollment for the signed-in admin.
//
//   • Current-password reauthentication against the LIVE admin row
//     (requireAdmin's DTO deliberately does not carry the hash).
//   • A CONFIRMED enrollment is never silently overwritten — 409
//     MFA_ALREADY_ENROLLED (disable first). Restarting an UNCONFIRMED
//     enrollment is allowed (lost setup key recovery).
//   • Returns { secretBase32, otpauthUrl } — the ONLY moment the plaintext
//     secret exists. NEVER logged, never echoed again after this response.
export const POST = handle(async (req: NextRequest) => {
  rateLimit(req, "admin-mfa", 10);
  const admin = await requireAdmin();
  const body = await readBody(req);
  const password = reqStr(body, "password", "Current password");

  if (!mfaEncryptionConfigured()) {
    throw new ApiError(503, "MFA_NOT_CONFIGURED", "MFA_ENCRYPTION_KEY is not set — two-factor authentication is unavailable.");
  }

  // Current-password reauthentication (uniform failure — no oracle).
  const row = await db.adminUser.findUnique({ where: { id: admin.id } });
  if (!row || !(await verifyAdminPassword(password, row.passwordHash))) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Current password is incorrect");
  }

  const existing = await getMfaEnrollment(admin.id);
  if (existing?.confirmedAt) {
    throw new ApiError(409, "MFA_ALREADY_ENROLLED", "Two-factor authentication is already enabled — disable it before re-enrolling");
  }

  const { secretBase32 } = generateTotpSecret();
  const secretEnc = encryptSecret(secretBase32);
  try {
    await db.adminMfaEnrollment.upsert({
      where: { adminId: admin.id },
      create: { adminId: admin.id, secretEnc, recoveryHashes: "[]", confirmedAt: null },
      update: { secretEnc, recoveryHashes: "[]", confirmedAt: null },
    });
  } catch (e) {
    if (isPrismaMissingTableError(e)) {
      throw new ApiError(503, "MFA_NOT_MIGRATED", "MFA enrollment table missing — apply migration 20261101000002 first");
    }
    throw e;
  }

  await logActivity({
    actorType: "admin",
    actorId: admin.id,
    actorLabel: admin.email,
    action: "admin.mfa.enrolled",
    entityType: "admin_mfa",
    entityId: admin.id,
    meta: { confirmed: false },
  });

  return ok({ secretBase32, otpauthUrl: otpauthUrl(admin, secretBase32) });
});
