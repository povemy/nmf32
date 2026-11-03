// ============================================================================
// PHASE 3 / WORK 3C — BACKUP & RECOVERY REHEARSAL (fresh-database drill)
// ----------------------------------------------------------------------------
// PROVES, against the authorized non-production Supabase project:
//   1. BACKUP — full logical backup of nomofee_staging (96 app tables, all
//      columns/rows, per-table checksums, FK-safe restore order) →
//      db/backup/phase3-work3-staging-backup.json
//   2. RESTORE — `prisma migrate deploy` onto a VIRGIN DATABASE
//      (nomofee_restore_drill; default public schema — the exact production
//      deploy mechanism; pg_trgm installs cleanly on a fresh DB) + rows
//      restored FROM THE BACKUP FILE (batched inserts, two-pass self-FK,
//      sequence resync).
//   3. VERIFY — migration ledger identical to source (names+checksums);
//      per-table row counts identical; drill ledger balanced (D==C, every
//      txn balanced); drill totals == source totals.
//   4. APP HEALTH — temporary app instance on :3300 pinned to the drill DB
//      boots healthy and reports the restored counts.
//   5. TEARDOWN — app killed, .next-drill removed, drill database dropped
//      (WITH FORCE), existence disproven.
//
// FINDING (recorded for the DR runbook): migration 20261109000000 references
// the pg_trgm operator class UNQUALIFIED (gin_trgm_ops). Replaying the
// migrations into a SECOND SCHEMA of a database where pg_trgm already lives
// in another schema fails with 42704 (CREATE EXTENSION IF NOT EXISTS no-ops
// database-wide; the unqualified opclass no longer resolves under the new
// search_path). A virgin DATABASE deploy — the real DR scenario — is
// unaffected, which is what this drill executes.
//
// Writes: db/backup/phase3-work3-staging-backup.json,
//         docs/staging/evidence/phase3-work3-backup-restore.json
// ============================================================================
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { Client } from "pg";

const SOURCE_SCHEMA = "nomofee_staging";
const DRILL_DB = "nomofee_restore_drill";
const BACKUP_FILE = "db/backup/phase3-work3-staging-backup.json";
const EVIDENCE_FILE = "docs/staging/evidence/phase3-work3-backup-restore.json";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const rawUrl = process.env.SUPABASE_DATABASE_URL ?? readFileSync(".env", "utf8").match(/SUPABASE_DATABASE_URL=(.+)/)?.[1]?.trim() ?? "";
if (new URL(rawUrl).searchParams.get("schema") !== SOURCE_SCHEMA) {
  console.error("[drill] REFUSED — URL must pin schema=nomofee_staging");
  process.exit(78);
}
const srcU = new URL(rawUrl);
srcU.searchParams.delete("sslmode");
// pg-Clients must use the sslmode-STRIPPED URL (the installed pg treats
// sslmode=require as verify-full and ignores the explicit ssl object — the
// pooler chain is self-signed from this box). Prisma keeps sslmode=require
// (its engine handles it — Step 3 deploy proven).
const drillUrlPrisma = (() => {
  const d = new URL(rawUrl);
  d.searchParams.delete("schema");
  d.pathname = `/${DRILL_DB}`;
  return d.toString();
})();
const drillUrlPg = (() => {
  const d = new URL(drillUrlPrisma);
  d.searchParams.delete("sslmode");
  return d.toString();
})();

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}: ${detail}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const src = new Client({ connectionString: srcU.toString(), ssl: { rejectUnauthorized: false } });
await src.connect();

// ── 0. refuse pre-existing drill database ────────────────────────────────────
if ((await src.query(`SELECT 1 FROM pg_database WHERE datname='${DRILL_DB}'`)).rowCount) {
  console.error(`[drill] REFUSED — database ${DRILL_DB} already exists (previous run not torn down?)`);
  process.exit(78);
}

// ── 1. BACKUP (schema-agnostic row serialization of the staging schema) ─────
const tables = (await src.query(`
  SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = '${SOURCE_SCHEMA}' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
  ORDER BY c.relname`)).rows.map((r) => r.t as string);
record("backup.tablesEnumerated", tables.length === 96, `${tables.length} app tables`);

const columnsByTable: Record<string, string[]> = {};
for (const t of tables) {
  columnsByTable[t] = (await src.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = '${SOURCE_SCHEMA}' AND table_name = '${t}' ORDER BY ordinal_position`)).rows.map((r) => r.column_name as string);
}
const fkRows = (await src.query(`
  SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent,
         a.attname AS child_col, af.attname AS parent_col
  FROM pg_constraint k
  JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
  JOIN pg_attribute af ON af.attrelid = k.confrelid AND af.attnum = ANY (k.confkey)
  WHERE k.connamespace = '${SOURCE_SCHEMA}'::regnamespace AND k.contype = 'f'`)).rows;
const plain = (q: string) => q.replace(/^.*\./, "").replace(/"/g, "");
const edges = fkRows.map((f) => ({ child: plain(f.child), parent: plain(f.parent), childCol: f.child_col, parentCol: f.parent_col }));
const selfRefs = edges.filter((e) => e.child === e.parent);
record("backup.selfRefsIdentified", selfRefs.length === 2, selfRefs.map((s) => `${s.child}.${s.childCol}`).join(", "));

const deps = new Map<string, string[]>();
for (const t of tables) deps.set(t, []);
for (const e of edges) if (e.child !== e.parent) deps.get(e.child)!.push(e.parent);
const order: string[] = [];
const visiting = new Set<string>();
function visit(t: string) {
  if (order.includes(t)) return;
  if (visiting.has(t)) throw new Error(`unexpected FK cycle at ${t}`);
  visiting.add(t);
  for (const p of deps.get(t)!) visit(p);
  visiting.delete(t);
  order.push(t);
}
for (const t of tables) visit(t);

function toParam(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === "object" && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}
const backup: Record<string, unknown> = { createdAt: new Date().toISOString(), sourceSchema: SOURCE_SCHEMA, order, tables: {} as Record<string, unknown> };
const tableData = backup.tables as Record<string, { columns: string[]; rows: unknown[][]; count: number; checksum: string }>;
let totalRows = 0;
for (const t of order) {
  const cols = columnsByTable[t];
  const sel = cols.map((c) => `"${c}"`).join(", ");
  const rows = (await src.query(`SELECT ${sel} FROM "${SOURCE_SCHEMA}"."${t}"`)).rows as Record<string, unknown>[];
  const matrix = rows.map((r) => cols.map((c) => toParam(r[c])));
  tableData[t] = { columns: cols, rows: matrix, count: matrix.length, checksum: sha256(JSON.stringify(matrix)) };
  totalRows += matrix.length;
}
record("backup.rowsCaptured", totalRows > 0, `${totalRows} rows across ${tables.length} tables → ${BACKUP_FILE}`);
writeFileSync(BACKUP_FILE, JSON.stringify(backup));

// ── 2. RESTORE — virgin database + prisma migrate deploy (production path) ──
await src.query(`CREATE DATABASE "${DRILL_DB}"`);
execSync(`bunx prisma migrate deploy`, {
  env: { ...process.env, SUPABASE_DATABASE_URL: drillUrlPrisma, NEXT_TELEMETRY_DISABLED: "1" },
  stdio: "pipe",
});
const drill = new Client({ connectionString: drillUrlPg, ssl: { rejectUnauthorized: false } });
await drill.connect();
const drillLedger = (await drill.query(`SELECT migration_name, checksum FROM public."_prisma_migrations" ORDER BY migration_name`)).rows;
record("restore.schemaRecreatedViaMigrations", drillLedger.length === 15, `prisma migrate deploy applied ${drillLedger.length}/15 migrations onto the virgin ${DRILL_DB} (public schema, production mechanism)`);
const trgm = (await drill.query(`SELECT n.nspname AS s FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm'`)).rows[0]?.s;
record("restore.pgTrgmCleanInstall", trgm === "public", `pg_trgm installed into ${trgm} on the virgin DB (unqualified gin_trgm_ops resolves — the same-database second-schema replay failure is documented as a DR-runbook note)`);

// rows from the BACKUP FILE (proves the artifact restorable)
const loaded = JSON.parse(readFileSync(BACKUP_FILE, "utf8")) as typeof backup;
const loadedTables = loaded.tables as typeof tableData;
let inserted = 0;
const BATCH = 50;
for (const t of (loaded.order as string[])) {
  const td = loadedTables[t];
  if (!td || td.rows.length === 0) continue;
  const selfCols = new Set(selfRefs.filter((s) => s.child === t).map((s) => s.childCol));
  const insertCols = td.columns.filter((c) => !selfCols.has(c));
  const colList = insertCols.map((c) => `"${c}"`).join(", ");
  for (let i = 0; i < td.rows.length; i += BATCH) {
    const batch = td.rows.slice(i, i + BATCH);
    const params: unknown[] = [];
    const values = batch.map((row) => {
      const placeholders = insertCols.map((c) => {
        params.push(row[td.columns.indexOf(c)]);
        return `$${params.length}`;
      });
      return `(${placeholders.join(", ")})`;
    }).join(", ");
    await drill.query(`INSERT INTO public."${t}" (${colList}) VALUES ${values}`, params);
    inserted += batch.length;
  }
  // second pass: self-references (Category.parentId, AffiliateProfile.sponsorId)
  if (selfCols.size > 0) {
    const key = td.columns[0];
    for (let i = 0; i < td.rows.length; i++) {
      for (let ci = 0; ci < td.columns.length; ci++) {
        if (selfCols.has(td.columns[ci]) && td.rows[i][ci] != null) {
          await drill.query(`UPDATE public."${t}" SET "${td.columns[ci]}" = $1 WHERE "${key}" = $2`, [td.rows[i][ci], td.rows[i][0]]);
        }
      }
    }
  }
}
record("restore.rowsInsertedFromBackupFile", true, `${inserted} rows into ${DRILL_DB}.public`);

// sequences resync to max(id)
const seqCols = (await drill.query(`
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema='public' AND column_default LIKE 'nextval%'`)).rows;
let seqResync = 0;
for (const s of seqCols) {
  const mx = (await drill.query(`SELECT coalesce(max("${s.column_name}"), 0)::int AS m FROM public."${s.table_name}"`)).rows[0].m;
  // pg_get_serial_sequence parses its TEXT arguments as identifiers — unquoted
  // mixed-case folds to lowercase (42P01 on "CommissionSetting" → commissionsetting).
  // Quote both the table and the column inside the argument strings.
  await drill.query(
    `SELECT setval(pg_get_serial_sequence('public."${s.table_name}"', $1), GREATEST($2,1), true)`,
    [s.column_name, mx],
  );
  seqResync++;
}
record("restore.sequencesResynced", true, `${seqResync} serial columns set to max(id)+1 semantics`);

// ── 3. VERIFY ────────────────────────────────────────────────────────────────
const srcLedger = (await src.query(`SELECT migration_name, checksum FROM ${SOURCE_SCHEMA}."_prisma_migrations" ORDER BY migration_name`)).rows;
record("verify.migrationLedgerIdentical", JSON.stringify(drillLedger) === JSON.stringify(srcLedger), `15 rows, names+checksums equal drill↔source`);

let countMismatch = 0; const diffs: string[] = [];
for (const t of tables) {
  const a = (await src.query(`SELECT count(*)::int AS n FROM "${SOURCE_SCHEMA}"."${t}"`)).rows[0].n;
  const b = (await drill.query(`SELECT count(*)::int AS n FROM public."${t}"`)).rows[0].n;
  if (a !== b) { countMismatch++; diffs.push(`${t}: ${a}→${b}`); }
}
record("verify.rowCountsIdentical", countMismatch === 0, countMismatch ? diffs.join(", ") : `all ${tables.length} tables match the source`);

const drillBal = (await drill.query(`
  SELECT count(*)::int AS n FROM (
    SELECT l."txnId" FROM public."LedgerLine" l GROUP BY l."txnId"
    HAVING sum(CASE WHEN l.direction='debit' THEN l."amountMinor" ELSE -l."amountMinor" END) <> 0) x`)).rows[0].n;
const drillTot = (await drill.query(`
  SELECT coalesce(sum(CASE WHEN direction='debit' THEN "amountMinor" ELSE 0 END),0)::int AS d,
         coalesce(sum(CASE WHEN direction='credit' THEN "amountMinor" ELSE 0 END),0)::int AS c
  FROM public."LedgerLine"`)).rows[0];
record("verify.drillLedgerBalanced", drillBal === 0 && drillTot.d === drillTot.c, `every txn balanced; D=${drillTot.d} == C=${drillTot.c}`);
const srcD = (await src.query(`SELECT coalesce(sum(CASE WHEN direction='debit' THEN "amountMinor" ELSE 0 END),0)::int AS d FROM "${SOURCE_SCHEMA}"."LedgerLine"`)).rows[0].d;
record("verify.drillLedgerEqualsSource", drillTot.d === srcD, `drill D ${drillTot.d} == source D ${srcD}`);
await src.end();

// ── 4. APP HEALTH against the drill database (temporary instance :3300) ─────
execSync(
  `bash -c 'cd /home/z/my-project && nohup env SUPABASE_DATABASE_URL="${drillUrlPrisma}" NEXT_DIST_DIR=.next-drill NEXT_TELEMETRY_DISABLED=1 node node_modules/.bin/next dev -p 3300 > .agent-tmp/drill-app.log 2>&1 &'`,
  { shell: "/bin/bash" },
);
let healthOk = false; let healthDetail = "";
for (let i = 0; i < 60; i++) {
  await sleep(3000);
  try {
    const r = await fetch("http://127.0.0.1:3300/api/health", { signal: AbortSignal.timeout(8000) });
    const h = ((await r.json()) as { data?: Record<string, unknown> }).data ?? {};
    if (h?.status === "healthy") {
      const counts = h.counts as Record<string, number>;
      const inv = h.ledgerInvariants as { ok?: boolean; txnCount?: number } | undefined;
      healthOk = true;
      healthDetail = `nodeEnv=${(h.deployment as Record<string, string>)?.nodeEnv} fp=${(h.deployment as Record<string, string>)?.dbFingerprint} stores=${counts?.stores} products=${counts?.products} orders=${counts?.orders} ledgerOk=${inv?.ok} txns=${inv?.txnCount}`;
      break;
    }
  } catch { /* retry */ }
}
record("verify.drillAppHealthy", healthOk, healthDetail || "health never reached healthy within 180s");

// ── 5. TEARDOWN ──────────────────────────────────────────────────────────────
// [n] bracket: prevents pkill's regex from matching this very command line
// (the first run killed its own wrapper shell → teardown "failed").
execSync(`bash -c 'pkill -f "[n]ext dev -p 3300" || true; sleep 2; rm -rf /home/z/my-project/.next-drill'`, { shell: "/bin/bash" });
await drill.end();
const admin = new Client({ connectionString: srcU.toString(), ssl: { rejectUnauthorized: false } });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS "${DRILL_DB}" WITH (FORCE)`);
const gone = (await admin.query(`SELECT 1 FROM pg_database WHERE datname='${DRILL_DB}'`)).rowCount === 0;
await admin.end();
record("teardown.drillDatabaseDropped", gone, `${DRILL_DB} dropped WITH FORCE; temp app killed; .next-drill removed`);

const failed = checks.filter((c) => !c.pass);
writeFileSync(EVIDENCE_FILE, JSON.stringify({
  createdAt: new Date().toISOString(), sourceSchema: SOURCE_SCHEMA, drillDatabase: DRILL_DB,
  backupFile: BACKUP_FILE, totalRows, checks,
  drRunbookNote: "Migration 20261109000000 references gin_trgm_ops UNQUALIFIED — same-database second-schema replay fails 42704 when pg_trgm already exists in another schema (verified live before this drill). Virgin-database deploy (the real DR path, executed here) is unaffected.",
  verdict: failed.length === 0 ? "ALL PASS" : `${failed.length} FAILURES`,
}, null, 2));
console.log(`\n[drill] ${checks.length - failed.length}/${checks.length} PASS${failed.length ? ` — FAILURES: ${failed.map((f) => f.name).join(", ")}` : ""}`);
process.exit(failed.length === 0 ? 0 : 1);
