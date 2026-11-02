-- Phase 1 (SEC-03 / B1): verified-purchase product reviews.
--
-- Operational impact: review submission is disabled (route-level 401/403
-- guards are code-side) until this migration is applied; the new columns are
-- nullable so existing "published" rows stay readable and keep counting in
-- public aggregates. Legacy rows keep shopperId NULL and are exempt from the
-- unique policy (Postgres treats NULLs as distinct).

ALTER TABLE "Review" ADD COLUMN "shopperId" TEXT;
-- Phase 3 fix (2026-11-02, disclosed in the Phase 3 staging report): "orderId" is
-- deliberately NOT re-added here. The 0_init baseline already ships
-- Review."orderId" (nullable, FK-less), so re-adding it made the full chain
-- un-applicable from zero — a fresh replay failed with
-- "column orderId of relation Review already exists" (caught by the
-- pre-approval shadow replay on 2026-11-02). The FK constraint below is still
-- created here because 0_init defines no Review_orderId_fkey. This migration
-- has never been applied to ANY database, so editing it is side-effect-free.
CREATE UNIQUE INDEX "Review_productId_shopperId_key" ON "Review"("productId", "shopperId");

ALTER TABLE "Review" ADD CONSTRAINT "Review_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_shopperId_fkey" FOREIGN KEY ("shopperId") REFERENCES "ShopperUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- New reviews default to pending moderation (code sets this explicitly too).
ALTER TABLE "Review" ALTER COLUMN "status" SET DEFAULT 'pending';
