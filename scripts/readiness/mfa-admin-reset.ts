// ============================================================================
// Administrator MFA enrollment RESET runbook script — PHASE 2.1 (§5-B/E).
// ----------------------------------------------------------------------------
// LAST-RESORT recovery for an administrator who lost BOTH their authenticator
// AND every recovery code. This is an OFFLINE operator action (a second
// administrator / break-glass procedure), NEVER an online self-service route —
// an online reset would be an MFA bypass.
//
// ⚠️ RUNBOOK ONLY — DO NOT RUN IN THIS SANDBOX. Authorized staging/production.
//
// USAGE (per affected admin, one at a time, after identity verification
// through your real-world admin verification procedure — out-of-band contact):
//   MFA_ADMIN_RESET_CONFIRM=yes-verified-out-of-band \
//   MFA_ADMIN_EMAIL=<admin email> \
//   bun scripts/readiness/mfa-admin-reset.ts
//
// WHAT IT DOES (all inside one transaction):
//   1. Refuses to run without the explicit confirmation env and target email.
//   2. Looks up the admin by email (fails closed on unknown email — no oracle:
//      this is an operator console, not a public API).
//   3. Deletes the AdminMfaEnrollment row (secret + recovery hashes + counter).
//   4. Revokes EVERY live session for that admin (they were minted through MFA;
//      the reset invalidates the factor they no longer hold).
//   5. Writes an ActivityLog audit row (action: admin.mfa.reset, actor: the
//      operator's email if OPERATOR_EMAIL is set, else "system").
// After running:
//   • The admin signs in with password only (no enrollment exists).
//   • The mandatory-enrollment gate (superadmin/finance/ops) immediately
//     restricts them to the MFA bootstrap routes — they cannot touch privileged
//     functionality until they re-enroll and confirm a fresh TOTP secret.
//   • Non-privileged roles (moderator) simply re-enroll at their leisure.
// ============================================================================
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  if (process.env.MFA_ADMIN_RESET_CONFIRM !== "yes-verified-out-of-band") {
    console.error("[mfa-admin-reset] Refusing to run without MFA_ADMIN_RESET_CONFIRM=yes-verified-out-of-band.");
    process.exit(1);
  }
  const email = (process.env.MFA_ADMIN_EMAIL ?? "").trim().toLowerCase();
  if (!email) {
    console.error("[mfa-admin-reset] MFA_ADMIN_EMAIL must identify the administrator being reset.");
    process.exit(1);
  }
  const operator = (process.env.OPERATOR_EMAIL ?? "system").trim();

  const admin = await db.adminUser.findUnique({ where: { email } });
  if (!admin) {
    console.error("[mfa-admin-reset] No administrator with that email. Nothing was changed.");
    process.exit(1);
  }

  const result = await db.$transaction(async (tx) => {
    const enrollment = await tx.adminMfaEnrollment.findUnique({ where: { adminId: admin.id } });
    if (!enrollment) {
      console.log("[mfa-admin-reset] That administrator has no enrollment — nothing to reset.");
      return { deleted: false, revokedSessions: 0 };
    }
    await tx.adminMfaEnrollment.delete({ where: { adminId: admin.id } });
    const revoked = await tx.session.deleteMany({ where: { userType: "admin", userId: admin.id } });
    await tx.activityLog.create({
      data: {
        actorType: "admin",
        actorId: admin.id,
        actorLabel: operator,
        action: "admin.mfa.reset",
        entityType: "admin_mfa",
        entityId: admin.id,
        metaJson: JSON.stringify({
          reason: "lost authenticator + all recovery codes (out-of-band verified)",
          revokedSessions: revoked.count,
          wasConfirmed: enrollment.confirmedAt != null,
        }),
      },
    });
    return { deleted: true, revokedSessions: revoked.count };
  });

  if (result.deleted) {
    console.log(
      `[mfa-admin-reset] Reset ${email}: enrollment deleted, ${result.revokedSessions} session(s) revoked, audit row written. The admin must sign in with password and re-enroll; the mandatory-enrollment gate restricts privileged access until confirmed.`
    );
  }
}

main()
  .catch((e) => {
    console.error("[mfa-admin-reset] failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
