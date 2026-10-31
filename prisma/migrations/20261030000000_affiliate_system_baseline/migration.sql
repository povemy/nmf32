-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "attrCampaign" TEXT,
ADD COLUMN     "attrCampaignId" TEXT,
ADD COLUMN     "attrContent" TEXT,
ADD COLUMN     "attrMedium" TEXT,
ADD COLUMN     "attrSource" TEXT,
ADD COLUMN     "attrTerm" TEXT,
ADD COLUMN     "shippingCountryCode" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "shippingCountrySource" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "affiliateDirectId" TEXT,
ADD COLUMN     "affiliateLinkId" TEXT,
ADD COLUMN     "affiliatePoolMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "affiliateRateBps" INTEGER,
ADD COLUMN     "affiliateSponsorId" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "affiliateEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "affiliateRateBps" INTEGER;

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "affiliateReversalMinor" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "affiliateDefaultRateBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "affiliateOptIn" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AnalyticsEvent" (
    "id" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "shopperId" TEXT,
    "visitorId" TEXT,
    "sessionId" TEXT,
    "qty" INTEGER,
    "referrerHost" TEXT,
    "channel" TEXT,
    "campaignId" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmTerm" TEXT,
    "utmContent" TEXT,
    "affiliateId" TEXT,
    "affiliateLinkId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerCampaign" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "defaultSource" TEXT,
    "defaultMedium" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffiliateProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "code" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "bio" TEXT,
    "avatarUrl" TEXT,
    "payoutRef" TEXT,
    "payoutVerifiedAt" TIMESTAMP(3),
    "termsVersion" INTEGER NOT NULL DEFAULT 1,
    "termsAcceptedAt" TIMESTAMP(3) NOT NULL,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "suspendedAt" TIMESTAMP(3),
    "suspendedReason" TEXT,
    "sponsorId" TEXT,
    "sponsorAssignedAt" TIMESTAMP(3),
    "sponsorSource" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AffiliateProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffiliateSponsorAudit" (
    "id" TEXT NOT NULL,
    "affiliateId" TEXT NOT NULL,
    "fromSponsorId" TEXT,
    "toSponsorId" TEXT,
    "reason" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AffiliateSponsorAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffiliateReferralTouch" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "affiliateId" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "channel" TEXT,
    "touchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AffiliateReferralTouch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffiliateLink" (
    "id" TEXT NOT NULL,
    "affiliateId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "productId" TEXT,
    "storeId" TEXT,
    "collectionId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'other',
    "label" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "lastClickAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "AffiliateLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffiliateCollection" (
    "id" TEXT NOT NULL,
    "affiliateId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "AffiliateCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffiliateCollectionItem" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AffiliateCollectionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffiliateAttributionTouch" (
    "id" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "affiliateId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "linkType" TEXT NOT NULL,
    "productId" TEXT,
    "storeId" TEXT,
    "collectionId" TEXT,
    "collectionVersion" INTEGER,
    "scopeProductIds" TEXT,
    "channel" TEXT,
    "clickedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AffiliateAttributionTouch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffiliateCommission" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT,
    "affiliateId" TEXT NOT NULL,
    "sponsorId" TEXT,
    "linkId" TEXT,
    "linkType" TEXT,
    "channel" TEXT,
    "commissionableBaseMinor" INTEGER NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "poolMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MYR',
    "attributionPolicy" TEXT NOT NULL DEFAULT 'v1:lc30d',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "breakdownJson" TEXT NOT NULL DEFAULT '{}',

    CONSTRAINT "AffiliateCommission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffiliateCommissionEntry" (
    "id" TEXT NOT NULL,
    "commissionId" TEXT NOT NULL,
    "beneficiaryAffiliateId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reversedMinor" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3),
    "holdReason" TEXT,
    "paidAt" TIMESTAMP(3),
    "payoutId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AffiliateCommissionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffiliatePayout" (
    "id" TEXT NOT NULL,
    "affiliateId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MYR',
    "status" TEXT NOT NULL DEFAULT 'requested',
    "method" TEXT NOT NULL DEFAULT 'manual_bank',
    "reference" TEXT,
    "note" TEXT,
    "failReason" TEXT,
    "statementJson" TEXT NOT NULL DEFAULT '{}',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "processedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AffiliatePayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsEvent_dedupKey_key" ON "AnalyticsEvent"("dedupKey");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_storeId_eventType_createdAt_idx" ON "AnalyticsEvent"("storeId", "eventType", "createdAt");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_storeId_createdAt_idx" ON "AnalyticsEvent"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_campaignId_createdAt_idx" ON "AnalyticsEvent"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_affiliateId_eventType_createdAt_idx" ON "AnalyticsEvent"("affiliateId", "eventType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SellerCampaign_code_key" ON "SellerCampaign"("code");

-- CreateIndex
CREATE INDEX "SellerCampaign_storeId_status_idx" ON "SellerCampaign"("storeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SellerCampaign_storeId_slug_key" ON "SellerCampaign"("storeId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateProfile_userId_key" ON "AffiliateProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateProfile_code_key" ON "AffiliateProfile"("code");

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateProfile_slug_key" ON "AffiliateProfile"("slug");

-- CreateIndex
CREATE INDEX "AffiliateProfile_sponsorId_idx" ON "AffiliateProfile"("sponsorId");

-- CreateIndex
CREATE INDEX "AffiliateProfile_status_idx" ON "AffiliateProfile"("status");

-- CreateIndex
CREATE INDEX "AffiliateSponsorAudit_affiliateId_createdAt_idx" ON "AffiliateSponsorAudit"("affiliateId", "createdAt");

-- CreateIndex
CREATE INDEX "AffiliateReferralTouch_affiliateId_touchedAt_idx" ON "AffiliateReferralTouch"("affiliateId", "touchedAt");

-- CreateIndex
CREATE INDEX "AffiliateReferralTouch_visitorId_touchedAt_idx" ON "AffiliateReferralTouch"("visitorId", "touchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateLink_code_key" ON "AffiliateLink"("code");

-- CreateIndex
CREATE INDEX "AffiliateLink_affiliateId_createdAt_idx" ON "AffiliateLink"("affiliateId", "createdAt");

-- CreateIndex
CREATE INDEX "AffiliateLink_status_code_idx" ON "AffiliateLink"("status", "code");

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateCollection_slug_key" ON "AffiliateCollection"("slug");

-- CreateIndex
CREATE INDEX "AffiliateCollection_affiliateId_status_idx" ON "AffiliateCollection"("affiliateId", "status");

-- CreateIndex
CREATE INDEX "AffiliateCollectionItem_productId_idx" ON "AffiliateCollectionItem"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateCollectionItem_collectionId_productId_key" ON "AffiliateCollectionItem"("collectionId", "productId");

-- CreateIndex
CREATE INDEX "AffiliateAttributionTouch_visitorId_productId_clickedAt_idx" ON "AffiliateAttributionTouch"("visitorId", "productId", "clickedAt");

-- CreateIndex
CREATE INDEX "AffiliateAttributionTouch_visitorId_storeId_clickedAt_idx" ON "AffiliateAttributionTouch"("visitorId", "storeId", "clickedAt");

-- CreateIndex
CREATE INDEX "AffiliateAttributionTouch_affiliateId_clickedAt_idx" ON "AffiliateAttributionTouch"("affiliateId", "clickedAt");

-- CreateIndex
CREATE INDEX "AffiliateAttributionTouch_clickedAt_idx" ON "AffiliateAttributionTouch"("clickedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateCommission_orderItemId_key" ON "AffiliateCommission"("orderItemId");

-- CreateIndex
CREATE INDEX "AffiliateCommission_affiliateId_createdAt_idx" ON "AffiliateCommission"("affiliateId", "createdAt");

-- CreateIndex
CREATE INDEX "AffiliateCommission_sponsorId_createdAt_idx" ON "AffiliateCommission"("sponsorId", "createdAt");

-- CreateIndex
CREATE INDEX "AffiliateCommission_orderId_idx" ON "AffiliateCommission"("orderId");

-- CreateIndex
CREATE INDEX "AffiliateCommission_status_createdAt_idx" ON "AffiliateCommission"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AffiliateCommission_storeId_createdAt_idx" ON "AffiliateCommission"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "AffiliateCommissionEntry_beneficiaryAffiliateId_status_idx" ON "AffiliateCommissionEntry"("beneficiaryAffiliateId", "status");

-- CreateIndex
CREATE INDEX "AffiliateCommissionEntry_status_availableAt_idx" ON "AffiliateCommissionEntry"("status", "availableAt");

-- CreateIndex
CREATE INDEX "AffiliateCommissionEntry_payoutId_idx" ON "AffiliateCommissionEntry"("payoutId");

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateCommissionEntry_commissionId_role_key" ON "AffiliateCommissionEntry"("commissionId", "role");

-- CreateIndex
CREATE INDEX "AffiliatePayout_affiliateId_status_idx" ON "AffiliatePayout"("affiliateId", "status");

-- CreateIndex
CREATE INDEX "AffiliatePayout_status_requestedAt_idx" ON "AffiliatePayout"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "CartItem_cartId_idx" ON "CartItem"("cartId");

-- CreateIndex
CREATE INDEX "CartItem_variantId_idx" ON "CartItem"("variantId");

-- CreateIndex
CREATE INDEX "Order_storeId_paidAt_idx" ON "Order"("storeId", "paidAt");

-- CreateIndex
CREATE INDEX "Order_paidAt_idx" ON "Order"("paidAt");

-- CreateIndex
CREATE INDEX "Order_storeId_attrCampaignId_idx" ON "Order"("storeId", "attrCampaignId");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_productId_idx" ON "OrderItem"("productId");

-- CreateIndex
CREATE INDEX "OrderItem_affiliateDirectId_idx" ON "OrderItem"("affiliateDirectId");

-- CreateIndex
CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");

-- AddForeignKey
ALTER TABLE "AffiliateProfile" ADD CONSTRAINT "AffiliateProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "ShopperUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateProfile" ADD CONSTRAINT "AffiliateProfile_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "AffiliateProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateCollectionItem" ADD CONSTRAINT "AffiliateCollectionItem_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "AffiliateCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateCollectionItem" ADD CONSTRAINT "AffiliateCollectionItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateCommission" ADD CONSTRAINT "AffiliateCommission_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "AffiliateProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateCommission" ADD CONSTRAINT "AffiliateCommission_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateCommissionEntry" ADD CONSTRAINT "AffiliateCommissionEntry_commissionId_fkey" FOREIGN KEY ("commissionId") REFERENCES "AffiliateCommission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliatePayout" ADD CONSTRAINT "AffiliatePayout_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "AffiliateProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

