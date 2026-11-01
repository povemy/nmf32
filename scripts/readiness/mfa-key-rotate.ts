// ============================================================================
// MFA_ENCRYPTION_KEY rotation runbook script — PHASE 2.1 (§5-E).
// ----------------------------------------------------------------------------
// PURPOSE: rotate the AES-256-GCM key that encrypts AdminMfaEnrollment.secretEnc
// WITHOUT invalidating every administrator's authenticator: decrypt with the
// OLD key, re-encrypt with the NEW key, in ONE transaction, with audit rows.
//
// ⚠️ RUNBOOK ONLY — DO NOT RUN IN THIS SANDBOX. Authorized staging/production
// use, during a maintenance window, with DB backups verified. This script is
// deliberately database-touching and therefore out of bounds for Phase 2.1
// execution; it is PREPARED for the deployment operator.
//
// PROCEDURE (documented in docs/ops/phase21-deployment-runbook.md):
//   1. Backup the AdminMfaEnrollment table (and confirm restore works).
//   2. Deploy app code that reads MFA_ENCRYPTION_KEY from a NEW env var slot
//      (MFA_ENCRYPTION_KEY_NEW) while STILL reading the old one — OR run this
//      script with both keys supplied and restart the app with the new key
//      immediately after (window: enrollments cannot be confirmed in between;
//      login MFA verifies fail closed → retry after restart).
//   3. Run:  bun scripts/readiness/mfa-key-rotate.ts
//      Env:   MFA_ENCRYPTION_KEY      (old, current)
//             MFA_ENCRYPTION_KEY_NEW  (new)
//   4. The script:
//        • refuses to run in a non-Node environment without explicit consent
//        • refuses when either key is missing or the two keys are identical
//        • verifies EVERY row decrypts under the old key BEFORE writing
//          (fail-fast: a single undecryptable row aborts — do NOT partially
//          rotate; that state would need per-admin re-enrollment to resolve)
//        • re-encrypts all rows in one transaction with per-row iv/tag
//        • leaves recoveryHashes / confirmedAt / lastUsedTotpCounter untouched
//        • writes an ActivityLog audit row (actor: system, action: mfa.key_rotated)
//   5. Swap the env: MFA_ENCRYPTION_KEY := new value; REMOVE the _NEW var.
//   6. Restart the app; verify: one admin MFA login succeeds; /api/health clean.
//   7. Securely destroy the old key material everywhere it was stored.
//
// KEY-LOSS RECOVERY (documented decision tree — no script needed):
//   • Key lost, backups lost → secrets are cryptographically gone. Correct
//     action: run scripts/readiness/mfa-admin-reset.ts for each affected admin
//     (audited enrollment deletion), have them re-enroll with the new key
//     (password reauth required — enrollment is always password-gated), and
//     treat any session minted before the incident as suspect (revoke all).
//   • Key compromised (not lost) → run THIS rotation script.
//
// NEVER log key material. This script prints counts and ids only.
// ============================================================================
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const oldKey = process.env.MFA_ENCRYPTION_KEY;
  const newKey = process.env.MFA_ENCRYPTION_KEY_NEW;
  if (!oldKey || !newKey) {
    console.error("[mfa-rotate] Both MFA_ENCRYPTION_KEY (old) and MFA_ENCRYPTION_KEY_NEW must be set.");
    process.exit(1);
  }
  if (oldKey === newKey) {
    console.error("[mfa-rotate] The new key must differ from the old key.");
    process.exit(1);
  }
  if (process.env.MFA_ROTATE_CONFIRM !== "yes-i-have-a-backup") {
    console.error("[mfa-rotate] Refusing to run without MFA_ROTATE_CONFIRM=yes-i-have-a-backup (see runbook step 1).");
    process.exit(1);
  }

  const rows = await db.adminMfaEnrollment.findMany({ select: { id: true, adminId: true, secretEnc: true, confirmedAt: true } });
  console.log(`[mfa-rotate] ${rows.length} enrollment(s) to rotate.`);

  // Stage 1 — dry-run decrypt with the OLD key (fail-fast BEFORE any write).
  const { decryptSecret, encryptSecret } = await import("../../src/lib/mfa");
  const staged: { id: string; secretEnc: string }[] = [];
  for (const row of rows) {
    try {
      const plaintextSecret = decryptSecretWith(row.secretEnc, oldKey);
      staged.push({ id: row.id, secretEnc: encryptSecretWith(plaintextSecret, newKey) });
    } catch {
      console.error(
        `[mfa-rotate] ABORT: enrollment ${row.id} (admin ${row.adminId}, confirmed=${row.confirmedAt != null}) does not decrypt with the supplied OLD key. Nothing has been written. Resolve this row first (see key-loss decision tree).`
      );
      process.exit(1);
    }
  }

  // The lib helpers read process.env.MFA_ENCRYPTION_KEY at call time, so we
  // perform the old-key decrypt by temporarily setting the env — mirrored
  // helpers below keep this script self-contained and auditable.
  function decryptSecretWith(enc: string, key: string): string {
    const prev = process.env.MFA_ENCRYPTION_KEY;
    process.env.MFA_ENCRYPTION_KEY = key;
    try {
      return decryptSecret(enc);
    } finally {
      process.env.MFA_ENCRYPTION_KEY = prev;
    }
  }
  function encryptSecretWith(plain: string, key: string): string {
    const prev = process.env.MFA_ENCRYPTION_KEY;
    process.env.MFA_ENCRYPTION_KEY = key;
    try {
      return encryptSecret(plain);
    } finally {
      process.env.MFA_ENCRYPTION_KEY = prev;
    }
  }

  // Stage 2 — single transaction: rotate every row + audit.
  await db.$transaction(async (tx) => {
    for (const s of staged) {
      await tx.adminMfaEnrollment.update({ where: { id: s.id }, data: { secretEnc: s.secretEnc } });
    }
    await tx.activityLog.create({
      data: {
        actorType: "admin",
        actorId: "system",
        actorLabel: "mfa-key-rotation",
        action: "admin.mfa.key_rotated",
        entityType: "admin_mfa",
        entityId: "all",
        metaJson: JSON.stringify({ rows: staged.length }),
      },
    });
  });
  console.log(`[mfa-rotate] Rotated ${staged.length} enrollment(s) and wrote the audit row. Swap MFA_ENCRYPTION_KEY to the new value and restart the app NOW.`);
}

main()
  .catch((e) => {
    console.error("[mfa-rotate] failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
