-- Phase 1 (C4 / F-5): administrator TOTP MFA.
--
-- Operational impact: none until admins enroll (empty table = no MFA
-- enforcement). The app tolerates the table being absent (P2021 guard, with
-- a loud warning) so a code-first deploy does not break admin login; remove
-- that guard only after this migration is confirmed applied everywhere.

-- CreateTable
CREATE TABLE "AdminMfaEnrollment" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "recoveryHashes" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminMfaEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable state: add unique constraint on adminId
CREATE UNIQUE INDEX "AdminMfaEnrollment_adminId_key" ON "AdminMfaEnrollment"("adminId");

-- AddForeignKey
ALTER TABLE "AdminMfaEnrollment" ADD CONSTRAINT "AdminMfaEnrollment_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
