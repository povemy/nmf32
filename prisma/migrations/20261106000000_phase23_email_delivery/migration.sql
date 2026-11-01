-- ============================================================================
-- PHASE 2.3 — TRANSACTIONAL EMAIL DELIVERY INFRASTRUCTURE (migrations)
-- Created 2026-11-06 by the consolidated remediation programme.
--
-- STATUS: NOT APPLIED (same authorization rule as 20261105000000).
--
-- Two NEW tables (additive — no existing table or query is affected):
--   1. EmailDeliveryEvent — durable inbox for SIGNED provider delivery
--      webhooks (Resend/Svix). Exactly-once processing keyed on
--      (provider, providerEventId); provider retries reuse the svix-id.
--   2. EmailSuppression — hard-bounce / complaint suppression list. Send
--      adapters consult it before delivery; the provider webhook maintains
--      it (email.bounced / email.complained add; suppression.removed clears).
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS "EmailSuppression";
--   DROP TABLE IF EXISTS "EmailDeliveryEvent";
-- ============================================================================

-- Table: EmailDeliveryEvent --------------------------------------------------
CREATE TABLE "EmailDeliveryEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "emailId" TEXT,
    "email" TEXT,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailDeliveryEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmailDeliveryEvent_provider_providerEventId_key"
    ON "EmailDeliveryEvent"("provider", "providerEventId");
CREATE INDEX "EmailDeliveryEvent_email_idx" ON "EmailDeliveryEvent"("email");
CREATE INDEX "EmailDeliveryEvent_eventType_receivedAt_idx"
    ON "EmailDeliveryEvent"("eventType", "receivedAt");

-- Table: EmailSuppression ----------------------------------------------------
CREATE TABLE "EmailSuppression" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmailSuppression_email_key" ON "EmailSuppression"("email");
CREATE INDEX "EmailSuppression_reason_idx" ON "EmailSuppression"("reason");
