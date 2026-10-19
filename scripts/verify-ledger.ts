// Post-migration financial integrity gate: run the ledger's own invariants
// (double-entry balance) + wallet-truth vs cache consistency for every wallet,
// straight against the Supabase Postgres database.
import { runLedgerInvariants, walletTruth, refreshWalletCache } from "../src/lib/ledger";
import { db } from "../src/lib/db";

let failures = 0;

const inv = await runLedgerInvariants();
const invOk = Array.isArray(inv) ? inv.every((i: unknown) => (i as { ok: boolean }).ok) : Boolean(inv);
console.log(`ledger invariants: ${invOk ? "PASS" : "FAIL"}`);
if (!invOk) { failures++; console.log(JSON.stringify(inv, null, 2).slice(0, 800)); }

const wallets = await db.wallet.findMany({ include: { seller: { select: { displayName: true } } } });
for (const w of wallets) {
  await refreshWalletCache(w.id);
  const fresh = await db.wallet.findUnique({ where: { id: w.id } });
  const truth = await walletTruth(w.id);
  const cacheOk =
    fresh?.pendingMinor === truth.pendingMinor &&
    fresh?.availableMinor === truth.availableMinor;
  if (!cacheOk) failures++;
  console.log(
    `wallet ${w.seller?.displayName ?? w.id}: truth(pending=${truth.pendingMinor}, available=${truth.availableMinor}) cache(pending=${fresh?.pendingMinor}, available=${fresh?.availableMinor}) → ${cacheOk ? "PASS" : "FAIL"}`
  );
}

const txns = await db.ledgerTransaction.count();
const lines = await db.ledgerLine.count();
console.log(`ledger txns: ${txns}, lines: ${lines}`);
console.log(failures === 0 ? "FINANCIAL-GATE: ALL PASS" : `FINANCIAL-GATE: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
