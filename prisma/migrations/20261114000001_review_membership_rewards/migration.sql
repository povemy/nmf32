-- REVIEW REWARDS WORK ORDER — verified-review membership ledger.
-- Additive only: new MembershipReward table + Review listing indexes +
-- 1:1 relation column. No existing column changes, no data backfill.
--
-- NOTE (deployment): this sandbox/staging environment applies schema via
-- `prisma db push` (the established workflow — see package.json db:push and
-- the _prisma_migrations table, which only carries the first four baselines).
-- For PRODUCTION, deploy via `prisma migrate deploy` with separate owner
-- authorization as required by the work order (§12).

-- Membership reward ledger: one row per credited reward, UNIQUE(reviewId)
-- enforces exactly-once per review at the database level.
CREATE TABLE "MembershipReward" (
    "id"             TEXT   NOT NULL,
    "shopperId"      TEXT   NOT NULL,
    "kind"           TEXT   NOT NULL DEFAULT 'review',
    "reviewId"       TEXT,
    "points"         INTEGER NOT NULL,
    "note"           TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt"     TIMESTAMP(3),
    "reversalReason" TEXT,

    CONSTRAINT "MembershipReward_pkey" PRIMARY KEY ("id")
);

-- Audit ledger deliberately has NO FK on shopperId (ActivityLog pattern):
-- it must survive shopper deletion. reviewId is FK'd to Review with SetNull
-- so a product-cascade review deletion keeps the financial audit row.
CREATE UNIQUE INDEX "MembershipReward_reviewId_key" ON "MembershipReward"("reviewId");
CREATE INDEX "MembershipReward_shopperId_createdAt_idx" ON "MembershipReward"("shopperId", "createdAt");

ALTER TABLE "MembershipReward"
    ADD CONSTRAINT "MembershipReward_reviewId_fkey"
    FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Public review listing API: WHERE productId = ? AND status = 'published'
-- with rating filter and createdAt/rating sort orders.
CREATE INDEX "Review_productId_status_createdAt_idx" ON "Review"("productId", "status", "createdAt");
CREATE INDEX "Review_productId_status_rating_idx" ON "Review"("productId", "status", "rating");
