-- ============================================================================
-- PHASE 2.2 — CRITICAL MARKETPLACE INTEGRITY (migrations)
-- Created 2026-11-05 by the consolidated remediation programme.
--
-- STATUS: NOT APPLIED. Per the operational restrictions of the programme this
-- file was authored but must only be applied to an AUTHORIZED environment
-- (staging first, then production via the deployment runbook). Applying it
-- against the shared development Supabase requires explicit owner approval.
--
-- CONTENTS (each item independent and additive — safe to apply in one pass):
--   1. C1.2  AffiliatePayout — partial unique index: one OPEN payout per
--            affiliate (hard backstop against the double-payment race).
--   2. C3    MarketplaceConnection — sellerId column + index (OAuth
--            connection ownership scoping: runner selection, claim/bind,
--            callback attribution).
--   3. C2.3  UserVoucher / CouponRedemption — lookup indexes for the
--            redemption-restoration sweep (checkout-compensation.ts).
--   4. Guest checkout — PaymentGroup.shopperId becomes nullable (guest
--            PaymentGroups carry no shopper account; existing rows and all
--            account-scoped flows unaffected).
--
-- ROLLBACK (reverse order):
--   DROP INDEX IF EXISTS "AffiliatePayout_one_open_per_affiliate";
--   ALTER TABLE "PaymentGroup" ALTER COLUMN "shopperId" SET NOT NULL;   -- only if no NULL rows exist
--   DROP INDEX IF EXISTS "CouponRedemption_orderId_idx";
--   DROP INDEX IF EXISTS "UserVoucher_usedOrderId_idx";
--   DROP INDEX IF EXISTS "MarketplaceConnection_sellerId_idx";
--   ALTER TABLE "MarketplaceConnection" DROP COLUMN IF EXISTS "sellerId";
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. C1.2 — one open affiliate payout per affiliate (partial unique index).
-- Prisma cannot express partial unique indexes; raw SQL is the only correct
-- expression. The guard below fails LOUDLY (instead of an opaque unique
-- violation) if pre-fix residue already contains duplicate open payouts —
-- resolve them FIRST by rejecting the extra rows via the admin queue
-- (rejection releases their claimed entries back to payoutId IS NULL), then
-- re-apply.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "AffiliatePayout" p
    WHERE p.status IN ('requested', 'processing')
    GROUP BY p."affiliateId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'AffiliatePayout_one_open_per_affiliate: duplicate open payouts exist for at least one affiliate (pre-fix race residue). Reject the extra open payouts via the admin affiliate queue (this releases their claimed entries), then re-apply this migration.';
  END IF;
END
$$;

CREATE UNIQUE INDEX "AffiliatePayout_one_open_per_affiliate"
  ON "AffiliatePayout"("affiliateId")
  WHERE status IN ('requested', 'processing');

-- ----------------------------------------------------------------------------
-- 2. C3 — Marketplace connection ownership.
-- sellerId records which seller's OAuth flow created the connection (from the
-- signed state parameter validated in the callback). The import runner and
-- claim/bind scope their connection queries by this column so one seller can
-- never import through — or capture — another seller's connection. Existing
-- rows keep NULL (legacy unattributed connections; claim/bind still allows
-- shopId matching for those, scoped to the claim token's job).
-- ----------------------------------------------------------------------------
ALTER TABLE "MarketplaceConnection" ADD COLUMN "sellerId" TEXT;
CREATE INDEX "MarketplaceConnection_sellerId_idx" ON "MarketplaceConnection"("sellerId");

-- ----------------------------------------------------------------------------
-- 3. C2.3 — redemption-restoration lookup indexes.
-- restoreRedemptionsForOrder() selects UserVoucher by (usedOrderId, status)
-- and CouponRedemption by orderId on every expired-unpaid sweep candidate.
-- Without these indexes both lookups are sequential scans.
-- ----------------------------------------------------------------------------
CREATE INDEX "UserVoucher_usedOrderId_idx" ON "UserVoucher"("usedOrderId");
CREATE INDEX "CouponRedemption_orderId_idx" ON "CouponRedemption"("orderId");

-- ----------------------------------------------------------------------------
-- 4. Guest checkout restoration — PaymentGroup.shopperId nullable.
-- Account checkouts are byte-identical (shopperId still set); guest checkouts
-- pass NULL. The Prisma relation becomes optional; onDelete: Cascade only
-- fires for non-NULL references.
-- ----------------------------------------------------------------------------
ALTER TABLE "PaymentGroup" ALTER COLUMN "shopperId" DROP NOT NULL;
