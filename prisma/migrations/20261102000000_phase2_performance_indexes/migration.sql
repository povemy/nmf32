-- ============================================================================
-- PHASE 2 / IMPLEMENTATION B — performance indexes (CREATED, NOT APPLIED).
-- ----------------------------------------------------------------------------
-- Every index below is justified by a live query pattern (see the Phase 2
-- report §B for the evidence). None duplicates an existing index; the one
-- replacement ([processed] → [processed, createdAt]) keeps the leading column
-- so every former use site stays covered.
--
-- PRODUCTION DEPLOYMENT NOTE: Prisma wraps migrations in a transaction, and
-- CREATE INDEX (plain) takes a SHARE lock that blocks writes on the table for
-- the build duration. On the CURRENT table sizes (dev DB) this is sub-second.
-- If, at deployment time, "Order" or "InventoryLog" have grown past ~1M rows,
-- run these statements OUT-OF-BAND as CREATE INDEX CONCURRENTLY (same names),
-- then mark this migration as applied (insert into _prisma_migrations) —
-- the standard Prisma escape hatch for hot tables.
-- ============================================================================

-- 1. Expiry-sweep candidate scan (cron, every 30 s):
--    orders → paymentGroup WHERE status IN ('requires_payment','failed')
--    AND expiresAt < now. Previously a full PaymentGroup scan each sweep.
CREATE INDEX "PaymentGroup_status_expiresAt_idx" ON "PaymentGroup"("status", "expiresAt");

-- 2. Seller order-listing views (primary seller workflow):
--    WHERE storeId = ? AND status IN (...). Serves all six status-group
--    filters; the leading column also serves storeId-only equality scans.
CREATE INDEX "Order_storeId_status_idx" ON "Order"("storeId", "status");

-- 3. Order-maintenance auto-complete sweep (cron, every 30 s):
--    WHERE status = 'delivered' AND deliveredAt < cutoff ORDER BY deliveredAt ASC.
CREATE INDEX "Order_status_deliveredAt_idx" ON "Order"("status", "deliveredAt");

-- 4. Ops recovery sweep for payment webhooks (admin/payouts/sweep):
--    WHERE processed = false AND createdAt < cutoff ORDER BY createdAt ASC.
--    REPLACES the single-column [processed] index (leading column identical,
--    so providerRef+processed lookups are unaffected).
DROP INDEX "PaymentWebhookLog_processed_idx";
CREATE INDEX "PaymentWebhookLog_processed_createdAt_idx" ON "PaymentWebhookLog"("processed", "createdAt");

-- 5. FK index — InventoryLog.variantId (append-heavy table; cascade variant
--    deletion otherwise full-scans it).
CREATE INDEX "InventoryLog_variantId_idx" ON "InventoryLog"("variantId");

-- 6. Admin webhook-deliveries listing (status filter + createdAt order) and
--    endpointId FK index (cascade-delete scans on an append-heavy table).
CREATE INDEX "WebhookDelivery_status_createdAt_idx" ON "WebhookDelivery"("status", "createdAt");
CREATE INDEX "WebhookDelivery_endpointId_idx" ON "WebhookDelivery"("endpointId");
