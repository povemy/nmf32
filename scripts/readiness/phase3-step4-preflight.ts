// ============================================================================
// PHASE 3 / STEP 4 — STAGING TEST PRE-FLIGHT (READ-ONLY SAFETY GATE)
// ----------------------------------------------------------------------------
// Mandatory gate before ANY Step 4 financial/marketplace test runs, per the
// authorized plan ("Mandatory Pre-flight Safety Check"):
//
//   1. DATABASE IDENTITY + FINGERPRINT — the staging connection resolves the
//      SAME database the healthy non-production dev app reports, via the same
//      sha256(host|oid|maxConn) fingerprint formula as /api/health.
//   2. TARGET SCHEMA — the run URL MUST pin schema=nomofee_staging. A URL
//      without a schema pin, or pinning public, is REFUSED (exit 78).
//   3. SEARCH-PATH MECHANICS — proves, live, that (a) a raw node-postgres
//      connection IGNORES the Prisma-only schema= parameter (search_path stays
//      "$user", public — the exact hazard lib.ts pgClient() now guards with an
//      explicit SET + hard-fail), and (b) the guarded connection (SET
//      search_path TO nomofee_staging) resolves the staging schema.
//   4. PRISMA TARGETS STAGING — boots src/lib/db PrismaClient under the run
//      env and proves it resolves nomofee_staging (0 stores) while the public
//      schema holds the dev dataset (49 stores) — the two schemas are provably
//      distinct and the client provably sees staging.
//   5. MIGRATION LEDGER — 15 rows in nomofee_staging._prisma_migrations, all
//      finished, checksums == sha256(local migration.sql).
//   6. PUBLIC BASELINE — full structural + row-count snapshot hashed, the
//      non-modification proof to re-verify after ALL Step 4 suites complete.
//
// Writes: docs/staging/evidence/phase3-step4-preflight.json
// Exit: 0 = all green; 78 = REFUSED (target ambiguity); 1 = verification failure.
// ============================================================================
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { Client } from "pg";

const EVIDENCE_DIR = "docs/staging/evidence";
const STAGING = "nomofee_staging";
const APP_HEALTH = process.env.APP_HEALTH_URL ?? "http://127.0.0.1:3000/api/health";

function refuse(reason: string): never {
  console.error(`\n[step4-preflight] REFUSED — ${reason}`);
  console.error("[step4-preflight] No test was executed. Nothing was written to the database.");
  process.exit(78);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const fingerprint = (host: string, oid: string, maxc: string) =>
  sha256(`${host}|${oid}|${maxc}`).slice(0, 16);

function runUrl(): string {
  const url = process.env.SUPABASE_DATABASE_URL ?? "";
  if (!url) refuse("SUPABASE_DATABASE_URL is not set in the runner environment");
  return url;
}

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`[step4-preflight] ${pass ? "PASS" : "FAIL"} — ${name}: ${detail}`);
}

async function main(): Promise<void> {
  // ── 1. Run URL + schema pin ─────────────────────────────────────────────
  const rawUrl = runUrl();
  const u = new URL(rawUrl);
  const pinnedSchema = u.searchParams.get("schema");
  if (!pinnedSchema) {
    refuse("the run URL has NO schema= pin — an unpinned connection resolves the role default (public). Step 4 requires schema=nomofee_staging");
  }
  if (pinnedSchema !== STAGING) {
    refuse(`the run URL pins schema=${pinnedSchema}, not ${STAGING}`);
  }
  record("url.schemaPinned", true, `schema=${pinnedSchema} (host ${u.host})`);

  // ── 2. Dev app identity (must be healthy, non-production, same DB) ──────
  let health: { deployment?: { nodeEnv?: string; dbFingerprint?: string }; status?: string; db?: string; counts?: Record<string, number> };
  try {
    const r = await fetch(APP_HEALTH, { signal: AbortSignal.timeout(10_000) });
    const j = (await r.json()) as { data?: typeof health };
    health = j.data ?? {};
  } catch (e) {
    refuse(`cannot read app identity from ${APP_HEALTH} — ${e instanceof Error ? e.message : String(e)}`);
  }
  if (health.deployment?.nodeEnv === "production") refuse("the app answering /api/health reports NODE_ENV=production");
  if (health.status !== "healthy" || health.db !== "up") {
    refuse(`app is not healthy (status=${health.status} db=${health.db})`);
  }
  const appFp = health.deployment?.dbFingerprint ?? "";
  console.log(`[step4-preflight] app :3000 nodeEnv=${health.deployment?.nodeEnv} dbFingerprint=${appFp} status=${health.status} stores=${health.counts?.stores}`);

  // ── 3. Staging connection identity + search-path mechanics ──────────────
  const client = new Client({
    host: u.hostname, port: Number(u.port) || 5432,
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ""), ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();

  const identity = (
    await client.query<{ db: string; usr: string; oid: string; maxc: string; search_path: string; addr: string; port: number }>(`
      SELECT current_database() AS db, current_user AS usr,
             (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS oid,
             current_setting('max_connections') AS maxc,
             current_setting('search_path') AS search_path,
             coalesce(inet_server_addr()::text,'') AS addr, inet_server_port() AS port
    `)
  ).rows[0];
  const dbFp = fingerprint(u.host, identity.oid, identity.maxc);
  record("identity.fingerprintMatch", dbFp === appFp,
    `connection fp=${dbFp} == app fp=${appFp} (db=${identity.db} oid=${identity.oid} @ ${identity.addr}:${identity.port})`);

  // (a) RAW session search_path — node-postgres ignores the schema= param:
  const rawSp = identity.search_path;
  record("searchpath.rawIgnored", !rawSp.includes(STAGING),
    `raw connection search_path="${rawSp}" — the Prisma-only schema= param is IGNORED by node-postgres (the hazard lib.ts pgClient() guards with an explicit SET + hard-fail)`);

  // (b) Guarded session (what pgClient() now does):
  await client.query(`SET search_path TO "${STAGING}"`);
  const guardedSp = (await client.query("SHOW search_path")).rows[0].search_path;
  record("searchpath.guardedResolvesStaging", guardedSp === STAGING, `SET search_path TO ${STAGING} → "${guardedSp}" ✓`);
  const stagingTablesHere = (
    await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='${STAGING}'`)
  ).rows[0].n;
  record("searchpath.stagingTablesVisible", stagingTablesHere === 97, `${stagingTablesHere} tables in ${STAGING} under the guarded session (96 app tables + _prisma_migrations)`);

  // ── 4. Migration ledger ─────────────────────────────────────────────────
  const ledger = (
    await client.query<{ migration_name: string; checksum: string; finished_at: Date | null }>(
      `SELECT migration_name, checksum, finished_at FROM ${STAGING}."_prisma_migrations" ORDER BY migration_name`,
    )
  ).rows;
  record("ledger.count", ledger.length === 15, `${ledger.length} recorded (expected 15)`);
  record("ledger.allFinished", ledger.every((l) => l.finished_at), `${ledger.filter((l) => !l.finished_at).length} unfinished`);
  const localFiles = readdirSync("prisma/migrations").filter((d) => !d.startsWith(".") && d !== "migration_lock.toml");
  let checksumMatches = 0;
  const checksumMismatches: string[] = [];
  for (const l of ledger) {
    try {
      const local = readFileSync(`prisma/migrations/${l.migration_name}/migration.sql`);
      if (sha256(local.toString("utf8")) === l.checksum) checksumMatches++;
      else checksumMismatches.push(l.migration_name);
    } catch {
      checksumMismatches.push(`${l.migration_name} (file missing)`);
    }
  }
  record("ledger.checksums", checksumMatches === 15 && checksumMismatches.length === 0,
    `${checksumMatches}/15 checksums == sha256(local file)${checksumMismatches.length ? ` MISMATCH: ${checksumMismatches.join(",")}` : ""}`);
  record("ledger.namesMatchRepo", localFiles.length === 15 && localFiles.every((f) => ledger.some((l) => l.migration_name === f)), "recorded names == repo migration dirs");

  // ── 5. Staging current row counts (baseline for the test run) ───────────
  const stagingTables = (
    await client.query<{ table: string }>(`
      SELECT c.relname AS table FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${STAGING}' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
      ORDER BY c.relname
    `)
  ).rows.map((r) => r.table);
  const stagingRowCount: Record<string, number> = {};
  const nonEmpty: string[] = [];
  for (const t of stagingTables) {
    const n = (await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${STAGING}."${t.replace(/"/g, '""')}"`,
    )).rows[0].n;
    stagingRowCount[t] = n;
    if (n > 0) nonEmpty.push(`${t}:${n}`);
  }
  record("staging.preTestState", nonEmpty.length === 0,
    nonEmpty.length ? `PRE-EXISTING ROWS: ${nonEmpty.join(", ")}` : `all ${stagingTables.length} staging tables empty (clean slate, matches Step 3 post-verify)`);
  const pubStoreCount = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public."Store"`)).rows[0].n;
  const stgStoreCount = stagingRowCount["Store"] ?? 0;
  record("staging.schemaDistinctFromPublic", pubStoreCount !== stgStoreCount || (pubStoreCount === 0 && stgStoreCount === 0),
    `public."Store"=${pubStoreCount} rows vs ${STAGING}."Store"=${stgStoreCount} rows — schemas are distinct namespaces`);

  // ── 6. PUBLIC baseline (non-modification proof for post-run) ────────────
  const pubTables = (
    await client.query<{ table: string }>(`
      SELECT c.relname AS table FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname
    `)
  ).rows.map((r) => r.table);
  const pubRowCount: Record<string, number> = {};
  for (const t of pubTables) {
    pubRowCount[t] = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public."${t.replace(/"/g, '""')}"`)).rows[0].n;
  }
  const pubIndexes = (await client.query(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename, indexname`)).rows;
  const pubConstraints = (await client.query(`
    SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY tbl, conname
  `)).rows;
  const pubViews = (await client.query(`SELECT viewname FROM pg_views WHERE schemaname='public' ORDER BY 1`)).rows.map((r) => r.viewname);
  const pubFunctions = (await client.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY 1`)).rows.map((r) => r.proname);
  const pubTriggers = (await client.query(`SELECT event_object_table AS tbl, trigger_name AS name FROM information_schema.triggers WHERE trigger_schema='public' ORDER BY 1,2`)).rows;
  const publicBaselineHash = sha256(JSON.stringify({
    tables: Object.keys(pubRowCount).sort(), rowCount: pubRowCount,
    indexes: pubIndexes, constraints: pubConstraints,
    views: pubViews, functions: pubFunctions, triggers: pubTriggers,
  }));

  await client.end();

  // ── 7. Prisma client provably targets staging ───────────────────────────
  // Boot src/lib/db under THIS process env (schema=nomofee_staging pinned) —
  // the exact client every readiness suite uses.
  const { db } = await import("../../src/lib/db");
  const prismaStoreCount = await db.store.count();
  record("prisma.targetsStaging", prismaStoreCount === stgStoreCount,
    `src/lib/db (env URL) sees Store.count()=${prismaStoreCount} == ${STAGING}."Store"=${stgStoreCount} (public has ${pubStoreCount})`);
  await db.$disconnect?.();

  // ── Write evidence ──────────────────────────────────────────────────────
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const failed = checks.filter((c) => !c.pass);
  const out = {
    capturedAt: new Date().toISOString(),
    run: { urlHost: u.host, database: identity.db, pinnedSchema: pinnedSchema, user: identity.usr, oid: identity.oid },
    app: { healthUrl: APP_HEALTH, nodeEnv: health.deployment?.nodeEnv, dbFingerprint: appFp, status: health.status, db: health.db, counts: health.counts },
    searchPathMechanics: {
      rawSession: rawSp,
      guardedSession: guardedSp,
      note: "node-postgres ignores the Prisma-only schema= URL param; readiness lib.ts pgClient() now forces SET search_path + hard-fails on mismatch. Fault-injection DDL can only land in nomofee_staging under the staged run env.",
    },
    migrations: { recorded: ledger.length, allFinished: ledger.every((l) => l.finished_at), checksumMatches },
    stagingBaseline: { tableCount: stagingTables.length, rowCount: stagingRowCount, nonEmpty },
    publicBaseline: {
      tableCount: pubTables.length, rowCount: pubRowCount,
      storeCount: pubStoreCount, structureHash: publicBaselineHash,
      note: "re-capture and re-hash after ALL Step 4 suites; must be byte-identical (row counts may only grow via the live dev app's own writes to hot tables — any decrease is a violation).",
    },
    checks,
    verdict: failed.length === 0 ? `GREEN — all ${checks.length} pre-flight checks passed.` : `RED — ${failed.length}/${checks.length} FAILED: ${failed.map((f) => f.name).join(", ")}`,
  };
  writeFileSync(`${EVIDENCE_DIR}/phase3-step4-preflight.json`, JSON.stringify(out, null, 2));
  console.log(`\n[step4-preflight] ${checks.length - failed.length}/${checks.length} checks passed.`);
  console.log(`[step4-preflight] public baseline hash: ${publicBaselineHash.slice(0, 16)}…`);
  console.log(`[step4-preflight] VERDICT: ${out.verdict}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`[step4-preflight] ERROR — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
