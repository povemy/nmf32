-- FINAL CLOSURE — guest-order ownership verification (email OTP) + shopper
-- email verification gate for guest-order claiming.
--
-- ONE additive table; NO column is added to any existing table (a missing
-- column would break every existing Prisma query before this migration is
-- applied, while a missing TABLE is tolerated fail-closed by the P2021 guard
-- in src/lib/guest-otp.ts — same dev contract as AdminMfaEnrollment).
--
-- Semantics (see docs/security/guest-order-otp-design.md):
--   (purpose, subjectId) is UNIQUE — exactly one live challenge per subject:
--     purpose "guest-order"   → subjectId = Order.id     (row deleted on verify)
--     purpose "shopper-email" → subjectId = ShopperUser.id (verifiedAt set on
--                               verify; the row PERSISTS as the durable proof
--                               of email ownership that gates claiming)
--   codeHash  = HMAC-SHA256(EMAIL_OTP_SECRET, 'otp:v1:<purpose>:<subjectId>:<utcDayBucket>:<code>')
--               — keyed hash, never plaintext, never logged.
--   attempts  = wrong-code counter (CAS-guarded increments, max 5). It is
--               carried over on re-issuance while a row is unexpired and only
--               resets after expiry — repeated issuance cannot reset
--               brute-force accounting.
--   expiresAt = 10-minute OTP TTL (absolute; day-bucket rollover at UTC
--               midnight is handled by verifying against BOTH the current and
--               the previous day bucket, so a code issued before midnight
--               stays valid through its full intended expiry).
--
-- Empty on creation → zero enforcement impact until flows write to it.
-- Safe at any point in the migration sequence; no data transformation.
CREATE TABLE "EmailOtpChallenge" (
  "id"         TEXT NOT NULL,
  "purpose"    TEXT NOT NULL,
  "subjectId"  TEXT NOT NULL,
  "codeHash"   TEXT NOT NULL,
  "attempts"   INTEGER NOT NULL DEFAULT 0,
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmailOtpChallenge_pkey" PRIMARY KEY ("id")
);

-- One live challenge per (purpose, subject). Also serializes concurrent
-- issuances (upsert) and backs the CAS consume/verified transitions.
CREATE UNIQUE INDEX "EmailOtpChallenge_purpose_subjectId_key"
  ON "EmailOtpChallenge"("purpose", "subjectId");

-- Purge helper parity with the Session sweep: expired guest-order challenge
-- rows are garbage after their TTL; the session-purge cron pattern can sweep
-- them with:  DELETE FROM "EmailOtpChallenge"
--             WHERE "verifiedAt" IS NULL AND "expiresAt" < now();
-- (rows with verifiedAt set are KEPT — they are the claiming proof.)
