-- Phase 1 (SEC-03 / B1): verified-purchase product reviews.
--
-- Operational impact: review submission is disabled (route-level 401/403
-- guards are code-side) until this migration is applied; the new columns are
-- nullable so existing "published" rows stay readable and keep counting in
-- public aggregates. Legacy rows keep shopperId NULL and are exempt from the
-- unique policy (Postgres treats NULLs as distinct).

ALTER TABLE "Review" ADD COLUMN "shopperId" TEXT;
ALTER TABLE "Review" ADD COLUMN "orderId" TEXT;

CREATE UNIQUE INDEX "Review_productId_shopperId_key" ON "Review"("productId", "shopperId");

ALTER TABLE "Review" ADD CONSTRAINT "Review_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_shopperId_fkey" FOREIGN KEY ("shopperId") REFERENCES "ShopperUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- New reviews default to pending moderation (code sets this explicitly too).
ALTER TABLE "Review" ALTER COLUMN "status" SET DEFAULT 'pending';
