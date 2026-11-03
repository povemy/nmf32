// ============================================================================
// PHASE 3 / WORK 2 — STAGING RECONFIRMATION + PUBLIC UNTOUCHED GUARD
// ----------------------------------------------------------------------------
// Re-runs the still-applicable Step 4 pre-flight gates for a NEW staging test
// run (the empty-slate check is dropped — Step 4 legitimately populated the
// schema; identity, search-path mechanics, migration ledger, and Prisma
// targeting remain mandatory), and captures/verifies the `public` schema
// baseline so every run can PROVE public was untouched afterwards.
//
// Modes:
//   bun scripts/readiness/phase3-work2-reconfirm.ts baseline
//     → gates + write docs/staging/evidence/phase3-work2-public-baseline.json
//   bun scripts/readiness/phase3-work2-reconfirm.ts verify
//     → gates + compare against the stored baseline (fail on any delta)
//
// Refuses (exit 78) unless SUPABASE_DATABASE_URL pins schema=nomofee_staging.
// APP_BASE (default http://127.0.0.1:3100) must be the ISOLATED staging app.
// ============================================================================
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { Client } from "pg";

const STAGING = "nomofee_staging";
const APP_BASE = process.env.APP_BASE ?? "http://127.0.0.1:3100";
const BASELINE_FILE = "docs/staging/evidence/phase3-work2-public-baseline.json";
const mode = process.argv[2] === "verify" ? "verify" : "baseline";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const fingerprint = (host: string, oid: string, maxc: string) =>
  sha256(`${host}|${oid}|${maxc}`).slice(0, 16);

function refuse(reason: string): never {
  console.error(`[reconfirm] REFUSED — ${reason}`);
  process.exit(78);
}
const rawUrl = process.env.SUPABASE_DATABASE_URL ?? "";
if (!rawUrl) refuse("SUPABASE_DATABASE_URL is not set in the runner environment");
const u = new URL(rawUrl);
if (u.searchParams.get("schema") !== STAGING) {
  refuse(`the run URL must pin schema=${STAGING} (got "${u.searchParams.get("schema")}")`);
}

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`[reconfirm:${mode}] ${pass ? "PASS" : "FAIL"} — ${name}: ${detail}`);
}

// ── app identity (the isolated staging instance must be healthy + same DB) ──
let health: { deployment?: { nodeEnv?: string; dbFingerprint?: string }; status?: string; db?: string; counts?: Record<string, number> };
try {
  const r = await fetch(`${APP_BASE}/api/health`, { signal: AbortSignal.timeout(10_000) });
  health = ((await r.json()) as { data?: typeof health }).data ?? {};
} catch (e) {
  refuse(`cannot read app identity from ${APP_BASE}/api/health — ${e instanceof Error ? e.message : String(e)}`);
}
if (health.deployment?.nodeEnv === "production") refuse("the app answering /api/health reports NODE_ENV=production");
if (health.status !== "healthy" || health.db !== "up") refuse(`app is not healthy (status=${health.status} db=${health.db})`);

const client = new Client({
  host: u.hostname, port: Number(u.port) || 5432,
  user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
  database: u.pathname.replace(/^\//, ""), ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
});
await client.connect();

const identity = (
  await client.query<{ db: string; oid: string; maxc: string; search_path: string; addr: string; port: number }>(`
    SELECT current_database() AS db,
           (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS oid,
           current_setting('max_connections') AS maxc,
           current_setting('search_path') AS search_path,
           coalesce(inet_server_addr()::text,'') AS addr, inet_server_port() AS port
  `)
).rows[0];
const dbFp = fingerprint(u.host, identity.oid, identity.maxc);
const appFp = health.deployment?.dbFingerprint ?? "";
record("identity.fingerprintMatch", dbFp === appFp, `connection fp=${dbFp} == app fp=${appFp} (db=${identity.db} @ ${identity.addr}:${identity.port})`);
record("searchpath.rawIgnored", !identity.search_path.includes(STAGING), `raw search_path="${identity.search_path}" (node-postgres ignores the pin — pgClient guards it)`);
await client.query(`SET search_path TO "${STAGING}"`);
const guardedSp = (await client.query("SHOW search_path")).rows[0].search_path;
record("searchpath.guardedResolvesStaging", guardedSp === STAGING, `SET search_path TO ${STAGING} → "${guardedSp}"`);
const stagingTablesHere = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='${STAGING}'`)).rows[0].n;
record("searchpath.stagingTablesVisible", stagingTablesHere === 97, `${stagingTablesHere} tables in ${STAGING} (96 app + _prisma_migrations)`);

// ── migration ledger ─────────────────────────────────────────────────────────
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

// ── Prisma targeting (the staging app's Prisma must read the staging schema) ─
const stgStoreCount = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${STAGING}."Store"`)).rows[0].n;
record("prisma.targetsStaging", (health.counts?.stores ?? -1) === stgStoreCount, `app health stores=${health.counts?.stores} == ${STAGING}."Store"=${stgStoreCount}`);

// ── PUBLIC baseline capture / verify ─────────────────────────────────────────
const pubTables = (await client.query<{ table: string }>(`
  SELECT c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname
`)).rows.map((r) => r.table);
const pubRowCount: Record<string, number> = {};
for (const t of pubTables) {
  pubRowCount[t] = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public."${t.replace(/"/g, '""')}"`)).rows[0].n;
}
const pubIndexes = (await client.query(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename, indexname`)).rows;
const pubConstraints = (await client.query(`
  SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
  FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY tbl, conname
`)).rows;
const pubViews = (await client.query(`SELECT viewname, definition FROM pg_views WHERE schemaname='public' ORDER BY viewname`)).rows;
const pubFunctions = (await client.query(`SELECT p.proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='public' ORDER BY p.proname`)).rows;
const pubTriggers = (await client.query(`SELECT event_object_table, trigger_name, action_statement, action_timing, event_manipulation FROM information_schema.triggers WHERE trigger_schema='public' ORDER BY event_object_table, trigger_name`)).rows;
const pubHash = sha256(JSON.stringify({ tables: pubTables, rowCount: pubRowCount, indexes: pubIndexes, constraints: pubConstraints, views: pubViews, functions: pubFunctions, triggers: pubTriggers }));

if (mode === "baseline") {
  writeFileSync(BASELINE_FILE, JSON.stringify({
    capturedAt: new Date().toISOString(), appBase: APP_BASE, fingerprint: dbFp,
    structuralHash: pubHash, tableCount: pubTables.length, rowCount: pubRowCount,
  }, null, 2));
  record("public.baselineCaptured", true, `structural sha256=${pubHash.slice(0, 20)}… over ${pubTables.length} tables → ${BASELINE_FILE}`);
} else {
  let baseline: { structuralHash?: string; tableCount?: number; rowCount?: Record<string, number> };
  try {
    baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  } catch {
    refuse(`cannot read ${BASELINE_FILE} — run baseline mode first`);
  }
  record("public.structureUnchanged", pubHash === baseline.structuralHash,
    `structural sha256 now=${pubHash.slice(0, 16)}… vs baseline=${(baseline.structuralHash ?? "").slice(0, 16)}…`);
  const deltas = Object.keys({ ...baseline.rowCount, ...pubRowCount })
    .filter((t) => (baseline.rowCount?.[t] ?? 0) !== (pubRowCount[t] ?? 0))
    .map((t) => `${t}: ${baseline.rowCount?.[t] ?? 0}→${pubRowCount[t] ?? 0}`);
  record("public.rowCountDeltas", deltas.length === 0, deltas.length ? deltas.join(", ") : "zero row-count deltas vs baseline");
  record("public.tableCount", pubTables.length === baseline.tableCount, `${pubTables.length} == ${baseline.tableCount}`);
}

await client.end();
const failed = checks.filter((c) => !c.pass);
console.log(`\n[reconfirm:${mode}] ${checks.length - failed.length}/${checks.length} PASS${failed.length ? ` — FAILURES: ${failed.map((f) => f.name).join(", ")}` : ""}`);
process.exit(failed.length === 0 ? 0 : 1);
