-- PROBE 2/2 — replicates 20261109000000_phase24_search_indexes mechanics:
-- CREATE EXTENSION IF NOT EXISTS pg_trgm (NOT pre-installed on this project),
-- a gin_trgm_ops index (opclass resolution under the migration search_path),
-- and an unqualified DROP INDEX (must stay scoped to the probe schema).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "probe_trgm_idx" ON "Probe" USING gin ("title" gin_trgm_ops);

DROP INDEX "probe_baseline_idx";
