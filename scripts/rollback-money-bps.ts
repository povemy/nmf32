// ============================================================================
// M-FIN-1 ROLLBACK — restore legacy Float percent columns from frozen backup
// ============================================================================
// ⚠️  EMERGENCY ROLLBACK ONLY. The forward migration (scripts/migrate-money-bps.ts)
// converted every Float percent to integer basis points and froze the original
// values in the FinMigrationBackup table + db/backup/fin-migration-*.json.
//
// This script reverses the SCHEMA + DATA:
//   1. Re-adds the 9 legacy Float percent columns (raw SQLite ALTER TABLE).
//   2. Restores each row's original percent from FinMigrationBackup
//      (newValue bps → oldValue percent; lossless because the frozen value IS
//      the original bit-for-bit Float).
//   3. Prints the code-revert checklist (application code must also revert to
//      the pre-M-FIN-1 commit — data rollback alone is not enough).
//
// NOTE: values written back come from the FinMigrationBackup table, so any
// percent written AFTER the migration (new orders use commissionBps only) will
// have NULL legacy columns — the restored schema matches the pre-migration
// application code, which recomputes rates from settings anyway.
//
// Run: bun scripts/rollback-money-bps.ts --yes
// ============================================================================
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const MIGRATION = "M-FIN-1-bps";

type Spec = {
  table: string; // SQLite table name
  pk: string; // primary key column
  legacyField: string;
  bpsField: string;
};

const SPECS: Spec[] = [
  { table: "Plan", pk: "id", legacyField: "commissionPercent", bpsField: "commissionBps" },
  { table: "CommissionSetting", pk: "id", legacyField: "defaultPercent", bpsField: "defaultBps" },
  { table: "CommissionOverride", pk: "id", legacyField: "percent", bpsField: "bps" },
  { table: "FeeHoliday", pk: "id", legacyField: "percent", bpsField: "bps" },
  { table: "Seller", pk: "id", legacyField: "commissionOverridePercent", bpsField: "commissionOverrideBps" },
  { table: "Category", pk: "id", legacyField: "commissionPercent", bpsField: "commissionBps" },
  { table: "Product", pk: "id", legacyField: "commissionPercentOverride", bpsField: "commissionBpsOverride" },
  { table: "OrderItem", pk: "id", legacyField: "commissionPercent", bpsField: "commissionBps" },
  { table: "Coupon", pk: "id", legacyField: "percent", bpsField: "percentBps" },
];

async function columnExists(table: string, column: string): Promise<boolean> {
  const cols = await db.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info(${table})`);
  return cols.some((c) => c.name === column);
}

async function main() {
  if (!process.argv.includes("--yes")) {
    console.error("Refusing to run without --yes. Read the script header first.");
    process.exit(1);
  }

  console.log(`\n=== ${MIGRATION} ROLLBACK — restoring legacy Float percent columns ===\n`);
  const backups = await db.finMigrationBackup.findMany({ where: { migration: MIGRATION } });
  console.log(`FinMigrationBackup rows: ${backups.length}`);
  if (backups.length === 0) {
    console.error("No backup rows found — nothing to roll back (or backup was lost). Aborting.");
    process.exit(1);
  }

  // JSON cross-check (belt and braces)
  console.log("Tip: a file copy also exists under db/backup/fin-migration-*.json\n");

  for (const spec of SPECS) {
    const hasLegacy = await columnExists(spec.table, spec.legacyField);
    if (!hasLegacy) {
      await db.$executeRawUnsafe(`ALTER TABLE ${spec.table} ADD COLUMN ${spec.legacyField} REAL`);
      console.log(`+ ${spec.table}.${spec.legacyField} column re-added (REAL)`);
    } else {
      console.log(`· ${spec.table}.${spec.legacyField} already exists`);
    }

    const rows = backups.filter((b) => b.table === spec.table);
    for (const b of rows) {
      await db.$executeRawUnsafe(
        `UPDATE ${spec.table} SET ${spec.legacyField} = ? WHERE ${spec.pk} = ?`,
        b.oldValue,
        b.rowId
      );
    }
    console.log(`  restored ${rows.length} value(s) into ${spec.table}.${spec.legacyField}`);
  }

  console.log("\n✓ Data rollback complete. CODE ROLLBACK CHECKLIST:");
  console.log("  1. git revert the M-FIN-1 commit (schema.prisma + all code reverts to Float percent).");
  console.log("  2. bun run db:generate (regenerate the Prisma client for the reverted schema).");
  console.log("  3. Restart the dev server and re-run scripts/fin-reconcile.ts adapted to the legacy fields.");
  console.log("  4. Keep FinMigrationBackup — it remains the audit record of the migration.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
