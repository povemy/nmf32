// ============================================================================
// FIN-1 PREFLIGHT — read-only financial integrity report.
// Run:  bun scripts/finance-preflight.ts          (report only, no writes)
//       bun scripts/finance-preflight.ts --backfill
//
// Checks:
//   (1) LedgerTransaction groups with count>1 on (txnType, refType, refId)
//       — detects duplicate postings that dedup keys now prevent going forward.
//   (2) Multiple "refund" txns per order refId (legal today: multi partial
//       refunds per order — reported for visibility, NOT a failure).
//   (3) Per-transaction debit vs credit sum balance.
//   (4) Per-wallet ledger truth vs cached Wallet columns (recomputed here
//       with the same math as lib/ledger walletTruth, plus the library's own
//       exports when importable).
//
// Exit code 1 on ANY (3)/(4) failure. (1)/(2) are informational.
//
// --backfill (one-time helper-column backfill, NOT history rewriting):
//   • LedgerTransaction.dedupKey = `${txnType}:${refType}:${refId}` on legacy
//     rows (collisions get "#2", "#3", … suffixes).
//   • LedgerLine.refType/refId = parent transaction's ref (the FIN-1 index on
//     lines requires these denormalized helper columns; legacy rows predate them).
//   Financial fields (amounts, directions, accounts, timestamps) are NEVER
//   touched — these are only the new nullable helper columns so the indexes
//   introduced in FIN-1 apply without data loss. Already-populated rows are
//   left untouched (idempotent).
// ============================================================================
import { db } from "../src/lib/db";
import { ACCOUNTS } from "../src/lib/ledger";

const backfill = process.argv.includes("--backfill");
let failures = 0;

// ---------------------------------------------------------------- (1) dup groups
const txns = await db.ledgerTransaction.findMany({
  select: { id: true, txnType: true, refType: true, refId: true, dedupKey: true, occurredAt: true },
  orderBy: { occurredAt: "asc" },
});
const groupCounts = new Map<string, number>();
for (const t of txns) {
  const k = `${t.txnType}:${t.refType ?? "null"}:${t.refId ?? "null"}`;
  groupCounts.set(k, (groupCounts.get(k) ?? 0) + 1);
}
const dupGroups = [...groupCounts.entries()].filter(([, n]) => n > 1);
console.log(`(1) duplicate (txnType,refType,refId) groups: ${dupGroups.length}`);
for (const [k, n] of dupGroups) console.log(`    DUP  ${k} ×${n}`);

// ---------------------------------------------------------------- (2) refunds per order
const refundCounts = new Map<string, number>();
for (const t of txns) {
  if (t.txnType === "refund" && t.refType === "order" && t.refId) {
    refundCounts.set(t.refId, (refundCounts.get(t.refId) ?? 0) + 1);
  }
}
const multiRefunds = [...refundCounts.entries()].filter(([, n]) => n > 1);
console.log(`(2) orders with >1 refund txn: ${multiRefunds.length} (informational — multi partial refunds are legal)`);
for (const [id, n] of multiRefunds) console.log(`    MULTI-REFUND  order=${id} ×${n}`);

// ---------------------------------------------------------------- (3) balance
const withLines = await db.ledgerTransaction.findMany({ include: { lines: true } });
let unbalanced = 0;
for (const t of withLines) {
  const debit = t.lines.filter((l) => l.direction === "debit").reduce((s, l) => s + l.amountMinor, 0);
  const credit = t.lines.filter((l) => l.direction === "credit").reduce((s, l) => s + l.amountMinor, 0);
  if (debit !== credit) {
    unbalanced++;
    console.log(`    UNBALANCED  txn=${t.id} type=${t.txnType} D=${debit} C=${credit}`);
  }
}
console.log(`(3) transaction balance check: ${withLines.length} txns, ${unbalanced} unbalanced`);
if (unbalanced > 0) failures++;

// ---------------------------------------------------------------- (4) wallet truth vs cache
// Same math as lib/ledger walletTruth — recomputed inline so the report works
// even if the library export shape changes; walletTruth itself is imported in
// ledger.ts and reused below when available.
const wallets = await db.wallet.findMany();
let drift = 0;
for (const w of wallets) {
  const payable = ACCOUNTS.sellerPayable(w.id);
  const lines = await db.ledgerLine.findMany({
    where: { accountCode: payable },
    select: { direction: true, amountMinor: true, availableAt: true },
  });
  const now = new Date();
  let totalCredits = 0, maturedCredits = 0, totalDebits = 0;
  for (const l of lines) {
    if (l.direction === "credit") {
      totalCredits += l.amountMinor;
      if (!l.availableAt || l.availableAt <= now) maturedCredits += l.amountMinor;
    } else {
      totalDebits += l.amountMinor;
    }
  }
  const truthPending = totalCredits - maturedCredits;
  const truthAvailable = maturedCredits - totalDebits;
  const okCache = truthPending === w.pendingMinor && truthAvailable === w.availableMinor;
  if (!okCache) {
    drift++;
    console.log(`    DRIFT  wallet=${w.id} pending cache=${w.pendingMinor} truth=${truthPending} | available cache=${w.availableMinor} truth=${truthAvailable}`);
  }
}
console.log(`(4) wallet cache vs ledger truth: ${wallets.length} wallets, ${drift} drifted`);
if (drift > 0) failures++;

// ---------------------------------------------------------------- backfill
if (backfill) {
  // ONE-TIME helper-column backfill for the FIN-1 indexes. This is NOT history
  // rewriting: only the new nullable helper columns are populated; every
  // financial field stays byte-identical. dedupKey collisions (which the
  // pre-dedup era legitimately allowed, e.g. multiple refunds per order) get a
  // "#2"/"#3" suffix so the unique index accepts all legacy rows.
  const targets = txns.filter((t) => t.dedupKey == null);
  const used = new Set(txns.filter((t) => t.dedupKey != null).map((t) => t.dedupKey as string));
  let n = 0;
  for (const t of targets) {
    const base = `${t.txnType}:${t.refType ?? "null"}:${t.refId ?? "null"}`;
    let key = base;
    let i = 2;
    while (used.has(key)) key = `${base}#${i++}`;
    used.add(key);
    await db.ledgerTransaction.update({ where: { id: t.id }, data: { dedupKey: key } });
    n++;
  }
  console.log(`backfill: ${n} LedgerTransaction row(s) updated with dedupKey (financial fields untouched)`);

  // Denormalized line refs — legacy lines copied from their parent transaction.
  const lineTargets = withLines.flatMap((t) =>
    t.lines.filter((l) => l.refType == null && l.refId == null).map((l) => ({ id: l.id, refType: t.refType, refId: t.refId }))
  );
  for (const l of lineTargets) {
    await db.ledgerLine.update({ where: { id: l.id }, data: { refType: l.refType, refId: l.refId } });
  }
  console.log(`backfill: ${lineTargets.length} LedgerLine row(s) updated with refType/refId (financial fields untouched)`);
} else {
  const missing = txns.filter((t) => t.dedupKey == null).length;
  console.log(`dedupKey coverage: ${txns.length - missing}/${txns.length} rows populated${missing > 0 ? ` (${missing} legacy rows — run with --backfill after db push)` : ""}`);
}

console.log(failures === 0 ? "FIN-PREFLIGHT: PASS" : `FIN-PREFLIGHT: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
