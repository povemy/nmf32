-- ============================================================================
-- PHASE 2.4 / C2.2 — trigram indexes for marketplace search (CREATED, NOT
-- APPLIED in this sandbox: no DB commands were run; folder only).
-- ----------------------------------------------------------------------------
-- Serves the tokenized search introduced/adopted by this phase:
--   • MAIN results  /api/market/products      (market/_shared/search.ts
--     buildTokenWhere) — every token must hit ≥1 of:
--         "Product"."title"        ILIKE '%token%'
--         "Product"."description"  ILIKE '%token%'
--         "Category"."name"        ILIKE '%token%'   (relation filter, join)
--         "Store"."name"           ILIKE '%token%'   (relation filter, join)
--   • AUTOCOMPLETE /api/market/search/suggest — same four columns via
--     buildTokenWhere + a direct "Store"."name" ILIKE on the store leg.
--   • RELATED      /api/market/search/related  — same four columns via
--     buildAnyTokenWhere.
-- Prisma `contains` + `mode:"insensitive"` compiles to ILIKE '%'||$x||'%',
-- which pg_trgm's gin_trgm_ops operator class accelerates (trigram extraction
-- of the pattern). These are the EXACT columns the live queries filter — no
-- speculative indexes on brand/slug/etc.
--
-- EXTENSION NOTE: CREATE EXTENSION requires superuser on some managed
-- databases. On Supabase (this project's provider — see schema.prisma
-- SUPABASE_DATABASE_URL) pg_trgm is in the allowed-extensions set and is
-- usually already enabled; if the role lacks rights, run the CREATE EXTENSION
-- once as owner/superuser out-of-band and keep only the CREATE INDEX
-- statements in this migration.
--
-- HONEST LIMITS (verify on staging — see work record):
--   • Trigram indexes only help tokens with ≥3 characters (a trigram needs 3
--     chars). 1–2 char tokens and single `%` wildcards fall back to seq scans
--     — acceptable at marketplace scale, and the relevance path is bounded by
--     the 200-row candidate window anyway.
--   • NULL description rows are simply not indexed by trigram ops (they can't
--     match ILIKE '%x%' anyway) — no partial-index needed.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Main search: Product.title / Product.description (ILIKE contains per token).
CREATE INDEX "Product_title_trgm_idx" ON "Product" USING gin ("title" gin_trgm_ops);
CREATE INDEX "Product_description_trgm_idx" ON "Product" USING gin ("description" gin_trgm_ops);

-- Relation legs of the tokenized WHERE: Store.name / Category.name.
-- Store.name also serves the suggest route's direct store-name ILIKE.
CREATE INDEX "Store_name_trgm_idx" ON "Store" USING gin ("name" gin_trgm_ops);
CREATE INDEX "Category_name_trgm_idx" ON "Category" USING gin ("name" gin_trgm_ops);

-- PRODUCTION DEPLOYMENT NOTE (same escape hatch as the Phase 2 / B migration):
-- Prisma wraps migrations in a transaction, and plain CREATE INDEX takes a
-- SHARE lock blocking writes for the build duration. At current table sizes
-- (dev/staging) this is sub-second. If "Product" or "Store" have grown past
-- ~1M rows at deployment time, run these statements OUT-OF-BAND as
-- CREATE INDEX CONCURRENTLY (same names), then mark this migration applied
-- (insert into _prisma_migrations) — the standard Prisma escape hatch for
-- hot tables. GIN builds are also slower than btree; CONCURRENTLY avoids the
-- write-block entirely at the cost of two table scans.
