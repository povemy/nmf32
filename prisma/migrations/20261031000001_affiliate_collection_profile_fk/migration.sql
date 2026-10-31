-- Post-implementation audit (defect fix): declare the AffiliateCollection →
-- AffiliateProfile relation that the public collection route already includes
-- (phantom relation — Prisma would throw "Unknown argument `affiliate`" the
-- moment the deferred collections feature is re-enabled). Adds the missing
-- database foreign key; additive, forward-only, no data change.

-- AddForeignKey
ALTER TABLE "AffiliateCollection" ADD CONSTRAINT "AffiliateCollection_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "AffiliateProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
