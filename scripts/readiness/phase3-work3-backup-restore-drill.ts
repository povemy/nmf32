// ============================================================================
// PHASE 3 / WORK 3C — BACKUP & RECOVERY REHEARSAL (isolated schema drill)
// ----------------------------------------------------------------------------
// PROVES, against the authorized staging database:
//   1. BACKUP — a full logical backup of nomofee_staging (all app tables:
//      columns, rows, per-table checksums; self-FK columns handled) is created
//      and verified → db/backup/phase3-work3-staging-backup.json
//   2. RESTORE — schema recreated via `prisma migrate deploy` into the isolated
//      nomofee_restore_drill schema (same mechanism as the Step 3 deploy,
//      search_path-scoped), rows restored from the BACKUP FILE in FK-safe
//      order (topological + two-pass self-references + sequence resync).
//   3. VERIFY — _prisma_migrations ledger identical (15 rows, names+checksums);
//      per-table row counts restored == source; ledger invariants in the drill
//      schema (every txn balanced, global D==C).
//   4. APP HEALTH — a temporary app instance pinned to the drill schema boots
//      (dev-mode watcher-free check via health endpoint) and reports the
//      restored counts.
//   5. TEARDOWN — drill schema dropped, temp app killed, artifacts documented.
//
// The hashed-Session-token compatibility rule is exercised implicitly: the
// restored Session rows carry today's hashed tokens and the CURRENT build
// reads them (rollback rule documented in the runbook).
//
// Writes: db/backup/phase3-work3-staging-backup.json,
//         docs/staging/evidence/phase3-work3-backup-restore.json
// ============================================================================
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { Client } from "pg";

const SOURCE = "nomofee_staging";
const DRILL = "nomofee_restore_drill";
const BACKUP_FILE = "db/backup/phase3-work3-staging-backup.json";
const EVIDENCE_FILE = "docs/staging/evidence/phase3-work3-backup-restore.json";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const rawUrl = process.env.SUPABASE_DATABASE_URL ?? readFileSync(".env", "utf8").match(/SUPABASE_DATABASE_URL=(.+)/)?.[1]?.trim() ?? "";
if (new URL(rawUrl).searchParams.get("schema") !== SOURCE) {
  console.error("[drill] REFUSED — URL must pin schema=nomofee_staging");
  process.exit(78);
}
const u = new URL(rawUrl);
u.searchParams.delete("sslmode");
const CONN = { connectionString: u.toString(), ssl: { rejectUnauthorized: false } };

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}: ${detail}`);
}

const src = new Client(CONN);
await src.connect();

// ── 0. refuse a pre-existing drill schema ────────────────────────────────────
const existing = (await src.query(`SELECT 1 FROM pg_namespace WHERE nspname = '${DRILL}'`)).rowCount;
if (existing) { console.error(`[drill] REFUSED — ${DRILL} already exists (previous run not torn down?)`); process.exit(78); }

// ── 1. BACKUP ────────────────────────────────────────────────────────────────
const tables = (await src.query(`
  SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = '${SOURCE}' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
  ORDER BY c.relname`)).rows.map((r) => r.t as string);
record("backup.tablesEnumerated", tables.length === 96, `${tables.length} app tables`);

const columnsByTable: Record<string, string[]> = {};
for (const t of tables) {
  columnsByTable[t] = (await src.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = '${SOURCE}' AND table_name = '${t}' ORDER BY ordinal_position`)).rows.map((r) => r.column_name as string);
}
// FK graph (child→parent), self-edges captured separately
const fkRows = (await src.query(`
  SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent,
         a.attname AS child_col, af.attname AS parent_col
  FROM pg_constraint k
  JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
  JOIN pg_attribute af ON af.attrelid = k.confrelid AND af.attnum = ANY (k.confkey)
  WHERE k.connamespace = '${SOURCE}'::regnamespace AND k.contype = 'f'`)).rows;
const plainName = (q: string) => q.replace(/^.*\./, "").replace(/"/g, "");
const edges = fkRows.map((f) => ({ child: plainName(f.child), parent: plainName(f.parent), childCol: f.child_col, parentCol: f.parent_col }));
const selfRefs = edges.filter((e) => e.child === e.parent);
record("backup.selfRefsIdentified", selfRefs.length === 2, selfRefs.map((s) => `${s.child}.${s.childCol}`).join(", "));

// topological order ignoring self-edges (self-FK cycles are the only cycles)
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

// serialize values for INSERT (pg parameter binding handles types; json needs stringify)
function toParam(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array)) return JSON.stringify(v);
  if (Array.isArray(v)) return JSON.stringify(v);
  return v;
}
const backup: Record<string, unknown> = { createdAt: new Date().toISOString(), source: SOURCE, tables: {} as Record<string, unknown>, order };
const tableData = backup.tables as Record<string, { columns: string[]; rows: unknown[][]; count: number; checksum: string }>;
let totalRows = 0;
for (const t of order) {
  const cols = columnsByTable[t];
  const sel = cols.map((c) => `"${c}"`).join(", ");
  const rows = (await src.query(`SELECT ${sel} FROM "${SOURCE}"."${t}"`)).rows as Record<string, unknown>[];
  const matrix = rows.map((r) => cols.map((c) => toParam(r[c])));
  tableData[t] = { columns: cols, rows: matrix, count: matrix.length, checksum: sha256(JSON.stringify(matrix)) };
  totalRows += matrix.length;
}
record("backup.rowsCaptured", totalRows > 0, `${totalRows} rows across ${tables.length} tables → ${BACKUP_FILE}`);
writeFileSync(BACKUP_FILE, JSON.stringify(backup));

// ── 2. RESTORE — schema via migrations, rows from the backup file ───────────
execSync(`bunx prisma migrate deploy`, {
  env: { ...process.env, SUPABASE_DATABASE_URL: rawUrl.replace(`schema=${SOURCE}`, `schema=${DRILL}`) },
  stdio: "pipe",
});
const drillLedger = (await src.query(`SELECT migration_name, checksum FROM ${DRILL}."_prisma_migrations" ORDER BY migration_name`)).rows;
record("restore.schemaRecreatedViaMigrations", drillLedger.length === 15, `prisma migrate deploy applied ${drillLedger.length}/15 migrations into ${DRILL}`);

// rows from the BACKUP FILE (not from the live source — proves the artifact restorable)
const loaded = JSON.parse(readFileSync(BACKUP_FILE, "utf8")) as typeof backup;
const loadedTables = loaded.tables as typeof tableData;
let inserted = 0;
for (const t of (loaded.order as string[])) {
  const td = loadedTables[t];
  if (!td || td.rows.length === 0) continue;
  const selfCols = new Set(selfRefs.filter((s) => s.child === t).map((s) => s.childCol));
  const insertCols = td.columns.filter((c) => !selfCols.has(c));
  const colList = insertCols.map((c) => `"${c}"`).join(", ");
  const placeholders = `(${insertCols.map((_, i) => `$${i + 1}`).join(", ")})`;
  const selfIdx = td.columns.map((c, i) => (selfCols.has(c) ? i : -1)).filter((i) => i >= 0);
  for (let i = 0; i < td.rows.length; i++) {
    const row = td.rows[i];
    const params = td.columns.map((c, ci) => (selfCols.has(c) ? null : row[ci]));
    await src.query(`INSERT INTO "${DRILL}"."${t}" (${colList}) VALUES ${placeholders}`, params.slice(0, insertCols.length));
    inserted++;
  }
  // second pass: restore self-references
  if (selfCols.size > 0) {
    const key = td.columns[0]; // first column is the PK (cuid) in every self-referencing table here
    for (let i = 0; i < td.rows.length; i++) {
      for (const si of selfIdx) {
        const ref = td.rows[i][si];
        if (ref != null) {
          await src.query(`UPDATE "${DRILL}"."${t}" SET "${td.columns[si]}" = $1 WHERE "${key}" = $2`, [ref, td.rows[i][0]]);
        }
      }
    }
  }
}
record("restore.rowsInserted", true, `${inserted} rows from the backup file into ${DRILL}`);

// sequences: resync any nextval-default columns to max(id)
const seqCols = (await src.query(`
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema = '${DRILL}' AND column_default LIKE 'nextval%'`)).rows;
let seqResync = 0;
for (const s of seqCols) {
  const mx = (await src.query(`SELECT coalesce(max("${s.column_name}"), 0)::int AS m FROM "${DRILL}"."${s.table_name}"`)).rows[0].m;
  await src.query(`SELECT setval(pg_get_serial_sequence('${DRILL}.${s.table_name}', '${s.column_name}'), GREATEST($1, 1), true)`, [mx]);
  seqResync++;
}
record("restore.sequencesResynced", true, `${seqResync} serial columns set to max(id)`);

// ── 3. VERIFY ────────────────────────────────────────────────────────────────
const srcLedger = (await src.query(`SELECT migration_name, checksum FROM ${SOURCE}."_prisma_migrations" ORDER BY migration_name`)).rows;
const ledgerEqual = JSON.stringify(drillLedger) === JSON.stringify(srcLedger);
record("verify.migrationLedgerIdentical", ledgerEqual, `15 rows, names+checksums equal between drill and source`);

let countMismatch = 0; const countDiffs: string[] = [];
for (const t of tables) {
  const a = (await src.query(`SELECT count(*)::int AS n FROM "${SOURCE}"."${t}"`)).rows[0].n;
  const b = (await src.query(`SELECT count(*)::int AS n FROM "${DRILL}"."${t}"`)).rows[0].n;
  if (a !== b) { countMismatch++; countDiffs.push(`${t}: ${a}→${b}`); }
}
record("verify.rowCountsIdentical", countMismatch === 0, countMismatch ? countDiffs.join(", ") : `all ${tables.length} tables match the source`);

const drillBal = (await src.query(`
  SELECT count(*)::int AS n FROM (
    SELECT l."txnId" FROM "${DRILL}"."LedgerLine" l GROUP BY l."txnId"
    HAVING sum(CASE WHEN l.direction='debit' THEN l."amountMinor" ELSE -l."amountMinor" END) <> 0) x`)).rows[0].n;
const drillTotals = (await src.query(`
  SELECT coalesce(sum(CASE WHEN direction='debit' THEN "amountMinor" ELSE 0 END),0)::int AS d,
         coalesce(sum(CASE WHEN direction='credit' THEN "amountMinor" ELSE 0 END),0)::int AS c
  FROM "${DRILL}"."LedgerLine"`)).rows[0];
record("verify.drillLedgerBalanced", drillBal === 0 && drillTotals.d === drillTotals.c, `every txn balanced; D=${drillTotals.d} == C=${drillTotals.c}`);
const srcTotals = (await src.query(`
  SELECT coalesce(sum(CASE WHEN direction='debit' THEN "amountMinor" ELSE 0 END),0)::int AS d FROM "${SOURCE}"."LedgerLine"`)).rows[0].d;
record("verify.drillLedgerEqualsSource", drillTotals.d === srcTotals, `drill D ${drillTotals.d} == source D ${srcTotals}`);

await src.end();

// ── 4. APP HEALTH against the drill schema (temporary instance :3300) ───────
const drillUrl = rawUrl.replace(`schema=${SOURCE}`, `schema=${DRILL}`);
const { BASE } = { BASE: process.env.LT_BASE ?? "http://127.0.0.1:3300" };
execSync(
  `bash -c 'cd /home/z/my-project && nohup env SUPABASE_DATABASE_URL="${drillUrl}" NEXT_DIST_DIR=.next-drill NEXT_TELEMETRY_DISABLED=1 node node_modules/.bin/next dev -p 3300 > .agent-tmp/drill-app.log 2>&1 &'`,
  { shell: "/bin/bash" },
);
let healthOk = false; let healthDetail = "";
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(8000) });
    const h = ((await r.json()) as { data?: Record<string, unknown> }).data ?? {};
    if (h?.status === "healthy") {
      const counts = h.counts as Record<string, number>;
      healthOk = true;
      healthDetail = `nodeEnv=${(h.deployment as Record<string, string>)?.nodeEnv} fp=${(h.deployment as Record<string, string>)?.dbFingerprint} stores=${counts?.stores} products=${counts?.products} orders=${counts?.orders}`;
      break;
    }
  } catch { /* retry */ }
}
record("verify.drillAppHealthy", healthOk, healthDetail || "health never reached healthy within 120s");

// ── 5. TEARDOWN ──────────────────────────────────────────────────────────────
execSync(`bash -c 'pkill -f "next dev -p 3300" || true; sleep 2'`, { shell: "/bin/bash" });
execSync(`bash -c 'rm -rf /home/z/my-project/.next-drill'`, { shell: "/bin/bash" });
const drop = new Client(CONN);
await drop.connect();
await drop.query(`DROP SCHEMA IF EXISTS "${DRILL}" CASCADE`);
const gone = (await drop.query(`SELECT 1 FROM pg_namespace WHERE nspname = '${DRILL}'`)).rowCount === 0;
await drop.end();
record("teardown.drillSchemaDropped", gone, `${DRILL} dropped (CASCADE); temp app killed; .next-drill removed`);

const failed = checks.filter((c) => !c.pass);
writeFileSync(EVIDENCE_FILE, JSON.stringify({
  createdAt: new Date().toISOString(), source: SOURCE, drill: DRILL, backupFile: BACKUP_FILE,
  totalRows: totalRows, checks, verdict: failed.length === 0 ? "ALL PASS" : `${failed.length} FAILURES`,
}, null, 2));
console.log(`\n[drill] ${checks.length - failed.length}/${checks.length} PASS${failed.length ? ` — FAILURES: ${failed.map((f) => f.name).join(", ")}` : ""}`);
process.exit(failed.length === 0 ? 0 : 1);
