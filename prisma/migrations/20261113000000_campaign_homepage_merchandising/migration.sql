-- Work order 14: homepage merchandising fields on the Campaign table.
-- Extends the existing campaign system (single source of truth); adds NO new
-- tables and NO pricing/discount columns — homepage banners never alter prices.
-- Legacy rows default to placement='showcase' so they stay visible.

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "description" TEXT,
ADD COLUMN "placement" TEXT NOT NULL DEFAULT 'showcase',
ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "displayOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "ctaLabel" TEXT,
ADD COLUMN "ctaHref" TEXT,
ADD COLUMN "bannerDesktopUrl" TEXT,
ADD COLUMN "bannerMobileUrl" TEXT,
ADD COLUMN "thumbnailUrl" TEXT,
ADD COLUMN "productQuery" TEXT,
ADD COLUMN "archivedAt" TIMESTAMP(3);

-- CreateIndex (homepage placement query: live campaigns per placement)
CREATE INDEX "Campaign_placement_isPublished_archivedAt_startAt_endAt_idx"
ON "Campaign"("placement", "isPublished", "archivedAt", "startAt", "endAt");
