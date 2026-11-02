-- PROBE 1/2 — replicates 0_init mechanics on the throwaway schema:
-- CreateSchema "public" no-op + unqualified CREATE TABLE/INDEX + a row that
-- records the search_path the migration engine actually used.
CREATE SCHEMA IF NOT EXISTS "public";

CREATE TABLE "Probe"(
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    CONSTRAINT "Probe_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProbePath"("path" TEXT NOT NULL);

INSERT INTO "ProbePath" VALUES (current_setting('search_path'));

CREATE INDEX "probe_baseline_idx" ON "Probe"("title");
