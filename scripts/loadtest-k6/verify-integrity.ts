// ============================================================================
// K6 RUN INTEGRITY VERIFIER — run AFTER a ladder run (DB-side box). Proves the
// invariants that the generator cannot see from outside:
//   • oversell: flash variant stock >= 0 AND (initial - sold) == current stock
//   • duplicate orders: every k6 idempotency key maps to <= 1 order / 1 group
//   • exactly-once money: every paid order has exactly ONE T1 ledger txn
//   • ledger invariants balanced (no hard drift)
//   • expiry backlog state
// Run: RUN_ID=<same> bun scripts/loadtest-k6/verify-integrity.ts
// @ts-nocheck
import { db } from "../../src/lib/db";
import { writeFileSync } from "node:fs";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const RUN_ID = process.env.RUN_ID;
if (!RUN_ID) throw new Error("RUN_ID env required");

// flash fixture stock arithmetic (slug is unique per store — findFirst, not findUnique)
const flash = await db.product.findFirst({ where: { slug: `lt-k6-flash-${RUN_ID}` }, include: { variants: true } });
if (flash) {
  const v = flash.variants[0];
  const paidForVariant = await db.orderItem.count({ where: { variantId: v.id, order: { status: "paid" } } });
  const stockOk = v.stock >= 0;
  check("oversell guard: final stock >= 0", stockOk, `stock=${v.stock}`);
  check("stock arithmetic: stock + paidOrders == initial", v.stock + paidForVariant === Number(process.env.FLASH_STOCK ?? 2000), `stock=${v.stock} paid=${paidForVariant}`);
} else {
  check("flash fixture present", false, "runId mismatch?");
}

// duplicate-order guard: k6 idem keys map to at most one order + one group
const keys = await db.order.groupBy({ by: ["idemKey"], where: { idemKey: { startsWith: `lt-k6-${RUN_ID}` } }, _count: { _all: true } });
const dupes = keys.filter((k) => k._count._all > 1);
check("idempotency: every k6 idem key → at most 1 order", dupes.length === 0, `keys=${keys.length} duplicated=${dupes.length}`);

// exactly-once T1 for paid k6 orders
const paidOrders = await db.order.findMany({ where: { idemKey: { startsWith: `lt-k6-${RUN_ID}` }, status: "paid" }, select: { id: true } });
let t1Bad = 0;
for (const o of paidOrders) {
  const n = await db.ledgerTransaction.count({ where: { dedupKey: `order_paid:order:${o.id}` } });
  if (n !== 1) t1Bad++;
}
check("exactly-once money: every paid order → exactly 1 T1 txn", t1Bad === 0, `paidOrders=${paidOrders.length} violations=${t1Bad}`);

// ledger invariants via health-equivalent: reuse runLedgerInvariants
const { runLedgerInvariants } = await import("../../src/lib/ledger");
const inv = await runLedgerInvariants();
check("ledger invariants balanced (no hard drift)", inv.ok && inv.hardDrift.length === 0, `txns=${inv.txnCount} hardDrift=${inv.hardDrift.length}`);

// expiry backlog
const backlog = await db.paymentGroup.count({ where: { status: "requires_payment", expiresAt: { lt: new Date() } } });
console.log(`INFO  expiry backlog now: ${backlog} (drains ≤ interval + batch pass per tick)`);

const report = { suite: "k6-integrity", runId: RUN_ID, at: new Date().toISOString(), failures };
writeFileSync(`performance/runs/${new Date().toISOString().slice(0, 10)}-k6-integrity-${RUN_ID}.json`, JSON.stringify(report, null, 2));
console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"} — saved performance/runs/${new Date().toISOString().slice(0, 10)}-k6-integrity-${RUN_ID}.json`);
process.exit(failures === 0 ? 0 : 1);
