// ============================================================================
// M-FIN-1 FREEZE VERIFICATION (ISSUE D) — READ-ONLY, SAFE TO RUN ANYTIME
// ============================================================================
// scripts/migrate-money-bps.ts is a FROZEN point-in-time audit record: it was
// executed once (2026-10-18, 31/31 values verified) and MUST NEVER be re-run —
// its legacy Float percent columns no longer exist. Per the issue-D directive
// the frozen file's contents are preserved VERBATIM (no guard added inside
// it); this companion script provides the PROTECTION EVIDENCE instead:
//
//   1. The legacy Float percent columns are absent from the live DB schema
//      (PRAGMA table_info — a re-run's first read() would throw
//      PrismaClientValidationError before ANY write could occur).
//   2. The FinMigrationBackup table still holds the frozen conversion rows
//      and every row round-trips (oldValue × 100 ≡ newValue, no sub-bps).
//   3. The JSON backup file matches the table rows 1:1.
//   4. package.json has no script that invokes the frozen migration.
//   5. The schema workflow is `prisma db push` (no prisma/migrations ledger) —
//      no standard workflow (dev/build/db:push/generate/lint) can execute
//      scripts/*.ts; the migration is manual-invocation only.
//   6. The generated Prisma client no longer exposes the legacy fields
//      (Prisma.dmmf reflection — the runtime guard against accidental re-runs).
//
// Run: bun scripts/verify-migration-freeze.ts   (exit 0 = freeze intact)
// It writes nothing and never mutates state.
// ============================================================================
import { PrismaClient, Prisma } from "@prisma/client";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const db = new PrismaClient();
const MIGRATION = "M-FIN-1-bps";

const LEGACY_COLUMNS: { table: string; column: string }[] = [
  { table: "Plan", column: "commissionPercent" },
  { table: "CommissionSetting", column: "defaultPercent" },
  { table: "CommissionOverride", column: "percent" },
  { table: "FeeHoliday", column: "percent" },
  { table: "Seller", column: "commissionOverridePercent" },
  { table: "Category", column: "commissionPercent" },
  { table: "Product", column: "commissionPercentOverride" },
  { table: "OrderItem", column: "commissionPercent" },
  { table: "Coupon", column: "percent" },
];

const EXPECTED_BPS_COLUMNS: { table: string; column: string }[] = [
  { table: "Plan", column: "commissionBps" },
  { table: "CommissionSetting", column: "defaultBps" },
  { table: "CommissionOverride", column: "bps" },
  { table: "FeeHoliday", column: "bps" },
  { table: "Seller", column: "commissionOverrideBps" },
  { table: "Category", column: "commissionBps" },
  { table: "Product", column: "commissionBpsOverride" },
  { table: "OrderItem", column: "commissionBps" },
  { table: "Coupon", column: "percentBps" },
];

let failures = 0;
function check(ok: boolean, label: string, detail: string) {
  if (ok) console.log(`  ✓ ${label}: ${detail}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}: ${detail}`);
  }
}

async function sqliteColumns(table: string): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info("${table}")`);
  return rows.map((r) => r.name);
}

async function main() {
  console.log(`\n=== ${MIGRATION} FREEZE VERIFICATION (read-only) ===\n`);

  // 1 + 6. Legacy columns absent from DB and from the generated client.
  console.log("[1/6] Legacy Float percent columns");
  for (const { table, column } of LEGACY_COLUMNS) {
    const cols = await sqliteColumns(table);
    check(!cols.includes(column), `${table}.${column} absent`, cols.includes(column) ? "STILL PRESENT — cutover incomplete?" : "removed from live schema");
  }
  console.log("\n[6] Generated Prisma client (runtime re-run guard)");
  for (const { table, column } of LEGACY_COLUMNS) {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === table);
    const has = !!model?.fields.some((f) => f.name === column);
    check(!has, `Prisma.dmmf ${table}.${column} absent`, has ? "client still exposes legacy field" : "re-run would fail validation on first read, before any write");
  }

  // Reverse check: the bps columns must exist.
  console.log("\n[reverse] BPS columns present");
  for (const { table, column } of EXPECTED_BPS_COLUMNS) {
    const cols = await sqliteColumns(table);
    check(cols.includes(column), `${table}.${column} present`, cols.includes(column) ? "bps storage live" : "MISSING — schema regression");
  }

  // 2. FinMigrationBackup rows intact + round-trip.
  console.log("\n[2] FinMigrationBackup round-trip");
  const backups = await db.finMigrationBackup.findMany({ where: { migration: MIGRATION } });
  check(backups.length >= 31, "backup row count", `${backups.length} rows frozen (expected ≥ 31)`);
  let roundTrips = 0;
  for (const b of backups) {
    const exact = Number.isInteger(b.oldValue * 100);
    const expected = Math.round(b.oldValue * 100);
    if (exact && expected === b.newValue && Math.abs(b.oldValue * 100 - expected) < 1e-9) roundTrips += 1;
    else check(false, `backup ${b.table}/${b.rowId}.${b.field}`, `frozen ${b.oldValue}% → ${b.newValue}bps does not round-trip`);
  }
  check(roundTrips === backups.length, "round-trip", `${roundTrips}/${backups.length} frozen values verified`);

  // 3. JSON backup file matches the table.
  console.log("\n[3] JSON backup file");
  const files = readdirSync("db/backup").filter((f) => /^fin-migration-.*\.json$/.test(f)).map((f) => `db/backup/${f}`);
  check(files.length >= 1, "backup file exists", files.length === 0 ? "NO fin-migration-*.json found" : files.join(", "));
  if (files.length >= 1) {
    const json = JSON.parse(readFileSync(files[0], "utf8")) as {
      migration: string;
      rows: { table: string; rowId: string; field: string; oldValue: number; newValue: number }[];
    };
    check(json.migration === MIGRATION, "json.migration", json.migration);
    const keyOf = (r: { table: string; rowId: string; field: string }) => `${r.table}/${r.rowId}/${r.field}`;
    const tableMap = new Map(backups.map((b) => [keyOf(b), b]));
    let matched = 0;
    for (const r of json.rows) {
      const t = tableMap.get(keyOf(r));
      if (t && t.oldValue === r.oldValue && t.newValue === r.newValue) matched += 1;
      else check(false, `json↔table ${keyOf(r)}`, "mismatch between JSON backup and FinMigrationBackup table");
    }
    check(matched === json.rows.length && json.rows.length === backups.length, "json↔table 1:1", `${matched}/${json.rows.length} json rows match ${backups.length} table rows`);
  }

  // 4. package.json scripts cannot invoke the frozen migration.
  console.log("\n[4] package.json scripts");
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  const offenders = Object.entries(pkg.scripts).filter(([, cmd]) => /migrate-money-bps/.test(cmd));
  check(offenders.length === 0, "no npm script references the frozen migration", offenders.length === 0 ? "dev/build/db:push/generate/lint never execute it" : offenders.map(([k]) => k).join(", "));

  // 5. Migration framework: prisma db push (no migrations ledger to poison).
  console.log("\n[5] Migration framework");
  const hasMigrationsDir = existsSync("prisma/migrations");
  check(!hasMigrationsDir, "prisma/migrations absent", "schema workflow = `prisma db push` (bun run db:push) — no migration ledger; the frozen script is manual-invocation only (`bun scripts/migrate-money-bps.ts`) and protected by [1]/[6]");

  // ------------------------------------------------------------------ report
  console.log("\n────────────────────────────────────────────────────");
  if (failures > 0) {
    console.error(`\n✗ FREEZE INTEGRITY FAILED — ${failures} check(s). Do NOT proceed with schema work until resolved.`);
    process.exit(1);
  }
  console.log(`\n✓ ${MIGRATION} freeze intact — applied once, verified, and unreachable by every standard workflow.`);
  console.log("  Procedure for future schema changes: edit prisma/schema.prisma → `bun run db:push` (forward-only).");
  console.log("  Never re-run, rewrite, or 'repair' scripts/migrate-money-bps.ts; never reset migration state.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
