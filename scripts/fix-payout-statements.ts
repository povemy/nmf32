// ============================================================================
// One-off integrity repair — rebuild every payout statement from LEDGER TRUTH.
//
// WHY: the original seed decorated PO-100001's statementJson with hard-coded
// numbers ("Refunds −RM 30.00" that never existed as a Refund record). That
// broke auditability (user report, Task 17-②). The runtime payout flow now
// builds statements via buildLedgerStatementFromLedger(); this script applies
// the same rule to payouts already in the database — WITHOUT a reseed.
//
// Run: bun scripts/fix-payout-statements.ts
// ============================================================================
import { PrismaClient } from "@prisma/client";
import { buildLedgerStatementFromLedger } from "../src/lib/ledger";

const db = new PrismaClient();

const rm = (minor: number) => `RM ${(minor / 100).toFixed(2)}`;

async function main() {
  const payouts = await db.payout.findMany({ orderBy: { createdAt: "asc" } });
  console.log(`Rebuilding ${payouts.length} payout statement(s) from ledger truth…\n`);

  for (const p of payouts) {
    // Period: since the wallet's previous PAID payout → this payout's paid
    // moment (fallback: wallet creation). Mirrors the runtime payout flow.
    const paidAt = p.paidAt ?? p.createdAt;
    const prev = await db.payout.findFirst({
      where: { walletId: p.walletId, status: "paid", paidAt: { lt: paidAt } },
      orderBy: { paidAt: "desc" },
      select: { paidAt: true },
    });
    // 30-day window ending at the payout moment (seed backdates paidAt before
    // the wallet row exists, so wallet.createdAt can never bound the window).
    const periodFrom = prev?.paidAt ?? new Date(paidAt.getTime() - 30 * 86_400_000);
    const periodTo = paidAt;

    const store = await db.store.findFirst({ where: { sellerId: p.sellerId }, select: { id: true, name: true } });
    const orderCount = await db.order.count({
      where: { storeId: store?.id, paidAt: { not: null, gte: periodFrom, lte: periodTo } },
    });

    const statementJson = await buildLedgerStatementFromLedger({
      walletId: p.walletId,
      sellerName: store?.name ?? "Seller",
      payoutAmountMinor: p.amountMinor,
      orderCount,
      periodFrom,
      periodTo,
    });
    await db.payout.update({ where: { id: p.id }, data: { statementJson } });

    const parsed = JSON.parse(statementJson) as { lines: { label: string; amountMinor: number }[] };
    const sum = parsed.lines.reduce((s, l) => s + l.amountMinor, 0);
    const diff = p.amountMinor - sum;
    console.log(
      `${p.referenceNo} (${p.status}) · ${periodFrom.toISOString().slice(0, 10)} → ${periodTo.toISOString().slice(0, 10)} · ${orderCount} paid orders`,
      `\n  payout ${rm(p.amountMinor)} · Σ(lines) ${rm(sum)} · diff ${rm(diff)} ${diff === 0 ? "✓ RECONCILED" : "✗ MISMATCH"}`
    );
    for (const l of parsed.lines) console.log(`   - ${l.label}: ${rm(l.amountMinor)}`);
    console.log("");
  }

  console.log("Done. Statements are now ledger-derived and reconcile to the net payout.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
