-- ============================================================================
-- PHASE 2.3 — C2.8: REAL SELLER WEBHOOK DELIVERY (migrations)
-- Created 2026-11-08 by the consolidated remediation programme.
--
-- STATUS: NOT APPLIED (same authorization rule as 20261105000000 /
-- 20261106000000). Apply to an AUTHORIZED environment (staging first, then
-- production via the deployment runbook); the shared development Supabase
-- requires explicit owner approval.
--
-- CONTENTS (additive — one NEW table, zero changes to existing tables):
--   • WebhookDeliveryAttempt — one row per REAL outbound delivery attempt
--     (responseCode / error / truncated response body / duration / signed
--     flag / trigger). attemptNo = 0 marks an administrative transition that
--     made no HTTP attempt (e.g. event_unsubscribed). attemptNo >= 1 rows are
--     genuine HTTP attempts made by lib/webhook-delivery.ts.
--
-- DELIBERATELY NO NEW COLUMNS ON WebhookDelivery (design note, C2.8):
--   • nextAttemptAt is DERIVED — lastAttemptAt + fixed backoff(attempts)
--     (1m/5m/15m/1h/4h/12h/24h, 8 attempts) — a pure function, no column
--     needed (lib/webhook-delivery.ts webhookNextRetryAt).
--   • lastError / responseBody live in the per-attempt table above.
--   Rationale: WebhookDelivery has default-select read sites on hot paths
--   (GET /api/store/webhooks `include: { deliveries: … }`, admin deliveries
--   list) and the dev database runs un-migrated — additive columns would
--   break those reads (P2022) and every write from the live payment fan-out.
--   A relation-only field was added to the Prisma model (no column), so
--   default selects are byte-identical. While THIS migration is unapplied,
--   lib/webhook-delivery.ts accesses WebhookDeliveryAttempt best-effort and
--   degrades to the columns-only record (status/attempts/responseCode/
--   lastAttemptAt remain authoritative either way).
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS "WebhookDeliveryAttempt";
-- ============================================================================

-- Table: WebhookDeliveryAttempt ----------------------------------------------
CREATE TABLE "WebhookDeliveryAttempt" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'sweep',
    "responseCode" INTEGER,
    "error" TEXT,
    "responseBody" TEXT,
    "durationMs" INTEGER,
    "signed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- FK: attempts die with their delivery (endpoint deletion cascades through
-- WebhookDelivery). ON DELETE CASCADE mirrors the Prisma relation.
ALTER TABLE "WebhookDeliveryAttempt"
    ADD CONSTRAINT "WebhookDeliveryAttempt_deliveryId_fkey"
    FOREIGN KEY ("deliveryId") REFERENCES "WebhookDelivery"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Latest-attempt lookup per delivery (admin visibility reads the newest row
-- per deliveryId first).
CREATE INDEX "WebhookDeliveryAttempt_deliveryId_attemptNo_idx"
    ON "WebhookDeliveryAttempt"("deliveryId", "attemptNo");
