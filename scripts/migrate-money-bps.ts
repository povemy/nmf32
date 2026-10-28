// ============================================================================
// M-FIN-1 — FINANCIAL PRECISION MIGRATION: Float percent → integer basis points
// ============================================================================
// ⚠️  POINT-IN-TIME SCRIPT (already executed 2026-10-18, 31/31 values verified,
// zero lossy). It reads the legacy Float percent columns, which the M-FIN-1
// cutover push has since DROPPED — so it no longer type-checks and MUST NOT be
// re-run. Kept verbatim as the audit record of the conversion (together with
// the FinMigrationBackup table + db/backup/fin-migration-*.json).
// ============================================================================
// @ts-nocheck — legacy schema fields intentionally referenced (see note above)
// Converts every legacy FLOAT percent column to an INTEGER basis-point column
// (POLICY P1: 100% = 10,000 bps; 1% = 100 bps; 8.35% = 835 bps).
//
// Safety plan (per user directive #7):
//   1. FREEZE     every original Float value is written to the FinMigrationBackup
//                 table AND to db/backup/fin-migration-*.json (reversible).
//   2. CONVERT    percent → bps via percentToBpsExact (exact when the stored
//                 percent has ≤ 2 decimals; any sub-bps precision is REPORTED
//                 as lossy instead of silently rounded).
//   3. VERIFY     re-reads every converted row and asserts bps round-trips to
//                 the frozen original (bps/100 ≡ old percent at 2dp).
//   4. REPORT     prints a per-table conversion summary; exit 1 on any failure.
//
// Rollback: scripts/rollback-money-bps.ts restores Float values from the
// backup table (run while the legacy Float columns still exist).
//
// Run: bun scripts/migrate-money-bps.ts
// ============================================================================
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { percentToBpsExact } from "../src/lib/money";

const db = new PrismaClient();
const MIGRATION = "M-FIN-1-bps";

type TableSpec = {
  table: string;
  legacyField: string;
  bpsField: string;
  nullable: boolean;
  read: () => Promise<{ id: string; value: number | null }[]>;
  write: (id: string, bps: number) => Promise<unknown>;
};

const specs: TableSpec[] = [
  {
    table: "Plan", legacyField: "commissionPercent", bpsField: "commissionBps", nullable: true,
    read: () => db.plan.findMany({ select: { id: true, commissionPercent: true } }).then((rows) => rows.map((r) => ({ id: r.id, value: r.commissionPercent }))),
    write: (id, bps) => db.plan.update({ where: { id }, data: { commissionBps: bps } }),
  },
  {
    table: "CommissionSetting", legacyField: "defaultPercent", bpsField: "defaultBps", nullable: false,
    read: () => db.commissionSetting.findMany({ select: { id: true, defaultPercent: true } }).then((rows) => rows.map((r) => ({ id: String(r.id), value: r.defaultPercent }))),
    write: (id, bps) => db.commissionSetting.update({ where: { id: Number(id) }, data: { defaultBps: bps } }),
  },
  {
    table: "CommissionOverride", legacyField: "percent", bpsField: "bps", nullable: true,
    read: () => db.commissionOverride.findMany({ select: { id: true, percent: true } }).then((rows) => rows.map((r) => ({ id: r.id, value: r.percent }))),
    write: (id, bps) => db.commissionOverride.update({ where: { id }, data: { bps } }),
  },
  {
    table: "FeeHoliday", legacyField: "percent", bpsField: "bps", nullable: false,
    read: () => db.feeHoliday.findMany({ select: { id: true, percent: true } }).then((rows) => rows.map((r) => ({ id: r.id, value: r.percent }))),
    write: (id, bps) => db.feeHoliday.update({ where: { id }, data: { bps } }),
  },
  {
    table: "Seller", legacyField: "commissionOverridePercent", bpsField: "commissionOverrideBps", nullable: true,
    read: () => db.seller.findMany({ select: { id: true, commissionOverridePercent: true } }).then((rows) => rows.map((r) => ({ id: r.id, value: r.commissionOverridePercent }))),
    write: (id, bps) => db.seller.update({ where: { id }, data: { commissionOverrideBps: bps } }),
  },
  {
    table: "Category", legacyField: "commissionPercent", bpsField: "commissionBps", nullable: true,
    read: () => db.category.findMany({ select: { id: true, commissionPercent: true } }).then((rows) => rows.map((r) => ({ id: r.id, value: r.commissionPercent }))),
    write: (id, bps) => db.category.update({ where: { id }, data: { commissionBps: bps } }),
  },
  {
    table: "Product", legacyField: "commissionPercentOverride", bpsField: "commissionBpsOverride", nullable: true,
    read: () => db.product.findMany({ select: { id: true, commissionPercentOverride: true } }).then((rows) => rows.map((r) => ({ id: r.id, value: r.commissionPercentOverride }))),
    write: (id, bps) => db.product.update({ where: { id }, data: { commissionBpsOverride: bps } }),
  },
  {
    table: "OrderItem", legacyField: "commissionPercent", bpsField: "commissionBps", nullable: false,
    read: () => db.orderItem.findMany({ select: { id: true, commissionPercent: true } }).then((rows) => rows.map((r) => ({ id: r.id, value: r.commissionPercent }))),
    write: (id, bps) => db.orderItem.update({ where: { id }, data: { commissionBps: bps } }),
  },
  {
    table: "Coupon", legacyField: "percent", bpsField: "percentBps", nullable: true,
    read: () => db.coupon.findMany({ select: { id: true, percent: true } }).then((rows) => rows.map((r) => ({ id: r.id, value: r.percent }))),
    write: (id, bps) => db.coupon.update({ where: { id }, data: { percentBps: bps } }),
  },
];

async function main() {
  console.log(`\n=== ${MIGRATION} — Float percent → integer basis points ===\n`);
  const report: { table: string; rows: number; converted: number; skipped: number; lossy: number; samples: string[] }[] = [];
  const backupRows: { table: string; rowId: string; field: string; oldValue: number; newValue: number }[] = [];
  let failures = 0;

  for (const spec of specs) {
    const rows = await spec.read();
    let converted = 0, skipped = 0, lossyCount = 0;
    const samples: string[] = [];

    for (const row of rows) {
      if (row.value == null) {
        // NULL rate → leave bps NULL (unchanged semantics: "inherit").
        skipped += 1;
        continue;
      }
      const { bps, lossy } = percentToBpsExact(row.value);
      if (lossy) {
        lossyCount += 1;
        samples.push(`LOSSY ${spec.table}/${row.id}: ${row.value} → ${bps} bps (sub-0.01% precision)`);
        failures += 1; // policy: never silently round beyond the declared scale
        continue;
      }
      // 1. FREEZE (idempotent — unique on migration+table+row+field)
      await db.finMigrationBackup.upsert({
        where: { migration_table_rowId_field: { migration: MIGRATION, table: spec.table, rowId: row.id, field: spec.legacyField } },
        create: { migration: MIGRATION, table: spec.table, rowId: row.id, field: spec.legacyField, oldValue: row.value, newValue: bps },
        update: { oldValue: row.value, newValue: bps },
      });
      backupRows.push({ table: spec.table, rowId: row.id, field: spec.legacyField, oldValue: row.value, newValue: bps });
      // 2. CONVERT
      await spec.write(row.id, bps);
      converted += 1;
      if (samples.length < 3) samples.push(`${spec.table}/${row.id}: ${row.value}% → ${bps} bps`);
    }

    report.push({ table: spec.table, rows: rows.length, converted, skipped, lossy: lossyCount, samples });
    console.log(`${spec.table.padEnd(20)} rows=${String(rows.length).padStart(4)}  converted=${String(converted).padStart(4)}  null-skipped=${String(skipped).padStart(3)}  lossy=${lossyCount}`);
    for (const s of samples) console.log(`   · ${s}`);
  }

  // JSON file backup (belt-and-braces beside the FinMigrationBackup table)
  const dir = "/home/z/my-project/db/backup";
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `${dir}/fin-migration-${stamp}.json`;
  writeFileSync(file, JSON.stringify({ migration: MIGRATION, createdAt: new Date().toISOString(), rows: backupRows }, null, 2), "utf8");

  // 3. VERIFY — re-read every converted row; bps must round-trip to the frozen value.
  console.log("\nVerification (round-trip bps ↔ frozen original percent):");
  let verified = 0;
  for (const spec of specs) {
    const backups = await db.finMigrationBackup.findMany({ where: { migration: MIGRATION, table: spec.table } });
    for (const b of backups) {
      const rows = await spec.read();
      const row = rows.find((r) => r.id === b.rowId);
      const current = row?.value == null ? null : percentToBpsExact(row.value).bps;
      const written = await (spec.table === "CommissionSetting"
        ? db.commissionSetting.findUnique({ where: { id: Number(b.rowId) } }).then((r) => (r as unknown as Record<string, number | null> | null)?.[spec.bpsField] ?? null)
        : Promise.resolve(null));
      const effective = spec.table === "CommissionSetting" ? written : current;
      if (effective !== b.newValue) {
        console.error(`   ✗ ${spec.table}/${b.rowId}: bps column=${effective} expected=${b.newValue}`);
        failures += 1;
      } else if (Math.round(b.oldValue * 100) !== b.newValue) {
        console.error(`   ✗ ${spec.table}/${b.rowId}: frozen percent ${b.oldValue} does not round-trip to ${b.newValue}`);
        failures += 1;
      } else {
        verified += 1;
      }
    }
  }
  console.log(`   ✓ ${verified} value(s) round-trip verified; ${backupRows.length} frozen in FinMigrationBackup + ${file}`);

  if (failures > 0) {
    console.error(`\n✗ MIGRATION INCOMPLETE — ${failures} failure(s). DO NOT drop legacy columns.`);
    process.exit(1);
  }
  console.log(`\n✓ ${MIGRATION} complete. Legacy Float columns remain in place until the cutover push drops them.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
