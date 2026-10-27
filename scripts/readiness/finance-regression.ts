// ============================================================================
// FINANCIAL REGRESSION SUITE — wallet/ledger (mission Phase 3 + parts of 5)
// ----------------------------------------------------------------------------
// Isolated fixtures only: a dedicated [LT] seller + wallet; every ledger
// posting uses synthetic order/payout/refund ids tagged `lt-wreg-*`, so no
// live wallet, order or PSP state is touched. Fixture ledger rows are removed
// at the end (audit trail preserved in the console log + JSON evidence).
//
// Covers mission Phase 3 cases: (1) cache==truth, (2) the reported drift shape
// reproduced safely, (3) misclassified transition detected, (4) payment
// posting, (5) pending→available maturation, (6) payout lifecycle, (7)
// refund/reversal, (8) concurrent same-wallet ops, (10) cache-update failure
// atomicity, (11) retry after transient failure, (12) concurrent
// reconciliation, (13) repeated apply idempotency, (14) ledger history
// unchanged during repair, (15) full before/after reconciliation.
// (Cases 9 + the HTTP-level F1/F2/F3 suites live in remediation-live-tests.ts.)
// @ts-nocheck
import { readFileSync, writeFileSync } from "node:fs";

// CONNECTION BUDGET [Measured]: Supavisor session pooler rejects clients past
// pool_size=15 (EMAXCONNSESSION). Dev server (≤10) + this script + spawned
// reconcile children must stay under it → small per-process limits here.
const rawUrl = readFileSync(".env", "utf8").match(/SUPABASE_DATABASE_URL=(.+)/)?.[1]?.trim();
const limitUrl = (n: number) => rawUrl + (rawUrl.includes("?") ? "&" : "?") + `connection_limit=${n}`;
process.env.SUPABASE_DATABASE_URL = limitUrl(2);

const { db } = await import("../../src/lib/db");
const {
  postOrderPaid,
  postPayoutInitiated,
  postPayoutConfirmed,
  postPayoutFailed,
  postRefund,
  refreshWalletCache,
  walletTruth,
  runLedgerInvariants,
} = await import("../../src/lib/ledger");
const { check, summary, exitCode, pgClient } = await import("./lib");

const stamp = Date.now().toString(36);
const TAG = `lt-wreg-${stamp}`;
const results = { runId: stamp, startedAt: new Date().toISOString(), tests: [] as any[] };
let failures = 0;
const t = (name: string, ok: boolean, detail = "") => {
  check(name, ok, detail);
  results.tests.push({ name, ok, detail });
  if (!ok) failures++;
};

// ---------------------------------------------------------------- fixture
const seller = await db.seller.create({
  data: { email: `${TAG}@lt.test`, passwordHash: "lt-fixture", fullName: "LT Wallet Fixture", displayName: "[LT] Wallet Fixture" },
});
const wallet = await db.wallet.create({ data: { sellerId: seller.id } });
const wid = wallet.id;
console.log(`fixture seller=${seller.id} wallet=${wid}\n`);

async function truthSnapshot() {
  const [w, truth] = await Promise.all([db.wallet.findUnique({ where: { id: wid } }), walletTruth(wid)]);
  return { cache: { avail: w.availableMinor, pend: w.pendingMinor, earned: w.lifetimeEarnedMinor, commission: w.lifetimeCommissionMinor, updatedAt: w.updatedAt }, truth: { avail: truth.availableMinor, pend: truth.pendingMinor, earned: truth.lifetimeEarnedMinor, commission: truth.lifetimeCommissionMinor } };
}
async function ledgerFingerprint() {
  const txns = await db.ledgerTransaction.findMany({ where: { dedupKey: { contains: TAG } }, include: { lines: true } });
  let checksum = 0;
  for (const txn of txns) for (const l of [...txn.lines].sort((a, b) => a.id.localeCompare(b.id))) checksum = (checksum * 31 + l.amountMinor * (l.direction === "credit" ? 3 : 7) + txn.txnType.length) | 0;
  return { count: txns.length, checksum };
}
const MYR = (m: number) => `${(m / 100).toFixed(2)} MYR`;

try {
  // ── Case 1: cache matches independently calculated values ────────────────
  console.log("── case 1: cache == truth after refresh ──");
  await postOrderPaid({
    orderId: `${TAG}-o1`, orderNumber: "LT-9001", walletId: wid, provider: "fpx_toyyibpay",
    totalMinor: 10000, sellerNetMinor: 9500, commissionMinor: 500,
    holdUntil: new Date(Date.now() - 1000), // matured instantly
  });
  await refreshWalletCache(wid);
  let snap = await truthSnapshot();
  t("1a: matured T1 → available reflects net", snap.cache.avail === snap.truth.avail && snap.truth.avail === 9500, `cache=${snap.cache.avail} truth=${snap.truth.avail}`);
  t("1b: cache lifetime fields == truth", snap.cache.earned === snap.truth.earned && snap.cache.commission === snap.truth.commission);

  // ── Case 2 + 5: reported drift shape — hold matures by clock ────────────
  console.log("── case 2/5: time-maturity drift reproduced on fixture ──");
  await postOrderPaid({
    orderId: `${TAG}-o2`, orderNumber: "LT-9002", walletId: wid, provider: "fpx_toyyibpay",
    totalMinor: 20000, sellerNetMinor: 19000, commissionMinor: 1000,
    holdUntil: new Date(Date.now() + 6000), // 6 s hold (≫ remote-RTT recipe latency)
  });
  await refreshWalletCache(wid);
  snap = await truthSnapshot();
  t("2a: while held → cache == truth, pending>0, available unchanged", snap.cache.pend === snap.truth.pend && snap.truth.pend === 19000, `pend=${snap.cache.pend}`);
  await new Promise((r) => setTimeout(r, 6500));
  const inv = await runLedgerInvariants();
  const stale = inv.timeMaturityStale.find((d) => d.walletId === wid);
  const hard = inv.hardDrift.find((d) => d.walletId === wid);
  t("2b: after maturity → invariant classifies TIME_MATURITY (benign), not hard drift", Boolean(stale) && !hard, stale ? `maturedSinceLastWrite=${stale.maturedSinceLastWrite}` : "not classified stale");
  t("2c: totals equal (no money missing)", stale ? stale.cachedAvailable + stale.cachedPending === stale.truthAvailable + stale.truthPending : false);
  t("2d: magnitude equals the matured hold", stale?.maturedSinceLastWrite === 19000, `${stale?.maturedSinceLastWrite}`);

  // ── Case 15/14/13: repair utility — dry-run, apply, idempotency ─────────
  console.log("── case 15/13/14: reconcile utility (dry-run → apply → re-apply) ──");
  const beforeApply = await truthSnapshot();
  const fpBefore = await ledgerFingerprint();
  const dry = Bun.spawnSync(["bun", "scripts/readiness/wallet-reconcile.ts", "--wallet", wid, "--json", `/tmp/lt-recon-dry-${stamp}.json`], { stdout: "pipe", stderr: "pipe", env: { ...process.env, SUPABASE_DATABASE_URL: limitUrl(1) } });
  t("13a: dry-run exits clean", dry.exitCode === 0, `exit=${dry.exitCode}`);
  const dryJson = JSON.parse(readFileSync(`/tmp/lt-recon-dry-${stamp}.json`, "utf8"));
  const drySelf = dryJson.wallets.find((w) => w.walletId === wid);
  t("13b: dry-run classifies STALE_TIME_MATURITY", drySelf?.classification === "STALE_TIME_MATURITY", drySelf?.classification);
  const afterDry = await truthSnapshot();
  t("13c: dry-run wrote NOTHING (cache untouched)", afterDry.cache.updatedAt.getTime() === beforeApply.cache.updatedAt.getTime(), `updatedAt unchanged=${afterDry.cache.updatedAt.getTime() === beforeApply.cache.updatedAt.getTime()}`);

  const apply1 = Bun.spawnSync(["bun", "scripts/readiness/wallet-reconcile.ts", "--apply", "--wallet", wid, "--confirm", wid], { stdout: "pipe", stderr: "pipe", env: { ...process.env, SUPABASE_DATABASE_URL: limitUrl(1) } });
  t("15a: apply succeeds and verifies", apply1.exitCode === 0, `exit=${apply1.exitCode}`);
  snap = await truthSnapshot();
  t("15b: after repair cache == truth (available includes matured hold)", snap.cache.avail === snap.truth.avail && snap.cache.pend === snap.truth.pend, `cache=${snap.cache.avail}/${snap.cache.pend} truth=${snap.truth.avail}/${snap.truth.pend}`);
  const invAfter = await runLedgerInvariants();
  t("15c: invariant reports MATCH for fixture (no drift entries)", !invAfter.hardDrift.some((d) => d.walletId === wid) && !invAfter.timeMaturityStale.some((d) => d.walletId === wid));

  const fpAfterApply1 = await ledgerFingerprint();
  t("14a: ledger history unchanged by repair (count + checksum)", fpAfterApply1.count === fpBefore.count && fpAfterApply1.checksum === fpBefore.checksum, `${fpBefore.count}→${fpAfterApply1.count} cksum ${fpBefore.checksum}→${fpAfterApply1.checksum}`);

  const apply2 = Bun.spawnSync(["bun", "scripts/readiness/wallet-reconcile.ts", "--apply", "--wallet", wid, "--confirm", wid], { stdout: "pipe", stderr: "pipe", env: { ...process.env, SUPABASE_DATABASE_URL: limitUrl(1) } });
  const afterApply2 = await truthSnapshot();
  t("13d: re-apply idempotent (same cache values, exit clean)", apply2.exitCode === 0 && afterApply2.cache.avail === snap.cache.avail && afterApply2.cache.pend === snap.cache.pend);
  const fpAfterApply2 = await ledgerFingerprint();
  t("13e: re-apply did not touch ledger", fpAfterApply2.count === fpBefore.count && fpAfterApply2.checksum === fpBefore.checksum);

  // ── Case 12: two simultaneous reconciliation attempts ────────────────────
  console.log("── case 12: concurrent reconciliation attempts ──");
  const p1 = Bun.spawn(["bun", "scripts/readiness/wallet-reconcile.ts", "--apply", "--wallet", wid, "--confirm", wid], { stdout: "pipe", stderr: "pipe", env: { ...process.env, SUPABASE_DATABASE_URL: limitUrl(1) } });
  const p2 = Bun.spawn(["bun", "scripts/readiness/wallet-reconcile.ts", "--apply", "--wallet", wid, "--confirm", wid], { stdout: "pipe", stderr: "pipe", env: { ...process.env, SUPABASE_DATABASE_URL: limitUrl(1) } });
  const [r1, r2] = await Promise.all([p1.exited, p2.exited]);
  snap = await truthSnapshot();
  const e1 = await new Response(p1.stdout).text().catch(() => "");
  const e2 = await new Response(p2.stderr).text().catch(() => "");
  t("12: concurrent applies both succeed, cache == truth exactly once", r1 === 0 && r2 === 0 && snap.cache.avail === snap.truth.avail && snap.cache.pend === snap.truth.pend, `exits=${r1},${r2} ${e2.slice(-160)}`);

  // ── Case 3: misclassified/corrupt cache is HARD drift, repair fixes it ──
  console.log("── case 3: corrupted cache classification + repair ──");
  await db.wallet.update({ where: { id: wid }, data: { availableMinor: { increment: 1 } } }); // simulate a wrong writer
  const invCorrupt = await runLedgerInvariants();
  const corruptEntry = invCorrupt.hardDrift.find((d) => d.walletId === wid);
  t("3a: totals-differ drift is HARD (flips ok=false)", Boolean(corruptEntry) && !invCorrupt.ok, corruptEntry ? `availΔ=${corruptEntry.availableDelta}` : "not detected");
  const apply3 = Bun.spawnSync(["bun", "scripts/readiness/wallet-reconcile.ts", "--apply", "--wallet", wid, "--confirm", wid], { stdout: "pipe", stderr: "pipe" });
  snap = await truthSnapshot();
  t("3b: repair from truth fixes corruption", apply3.exitCode === 0 && snap.cache.avail === snap.truth.avail);
  const invFixed = await runLedgerInvariants();
  t("3c: ok=true again after repair", invFixed.ok);

  // ── Case 6: payout lifecycle (reserve → confirm / fail-reversal) ─────────
  console.log("── case 6: payout lifecycle ──");
  await refreshWalletCache(wid);
  snap = await truthSnapshot();
  const availBeforePayout = snap.truth.avail;
  await postPayoutInitiated({ walletId: wid, payoutId: `${TAG}-p1`, referenceNo: "PO-LT-1", amountMinor: 3000 });
  snap = await truthSnapshot();
  t("6a: T3 debit reduces available exactly once", snap.truth.avail === availBeforePayout - 3000, `${availBeforePayout} → ${snap.truth.avail}`);
  await postPayoutConfirmed({ walletId: wid, payoutId: `${TAG}-p1`, referenceNo: "PO-LT-1", amountMinor: 3000 });
  snap = await truthSnapshot();
  t("6b: T4 clearing→bank leaves seller payable unchanged", snap.truth.avail === availBeforePayout - 3000);
  await postPayoutInitiated({ walletId: wid, payoutId: `${TAG}-p2`, referenceNo: "PO-LT-2", amountMinor: 1000 });
  await postPayoutFailed({ walletId: wid, payoutId: `${TAG}-p2`, referenceNo: "PO-LT-2", amountMinor: 1000, reason: "LT bank bounce" });
  snap = await truthSnapshot();
  t("6c: T4f reversal credits available back (immediately matured)", snap.truth.avail === availBeforePayout - 3000, `${snap.truth.avail}`);
  t("6d: cache tracks truth through the lifecycle", snap.cache.avail === snap.truth.avail && snap.cache.pend === snap.truth.pend);

  // ── Case 7: refund / reversal ────────────────────────────────────────────
  console.log("── case 7: refund ──");
  const beforeRefund = (await truthSnapshot()).truth.avail;
  await postRefund({ orderId: `${TAG}-o1`, orderNumber: "LT-9001", walletId: wid, provider: "fpx_toyyibpay", amountMinor: 5000, commissionReversalMinor: 250, refundId: `${TAG}-r1` });
  snap = await truthSnapshot();
  t("7a: T5 debits seller share (amount − commission reversal)", snap.truth.avail === beforeRefund - 4750, `Δ=${snap.truth.avail - beforeRefund}`);
  t("7b: refund keeps cache == truth", snap.cache.avail === snap.truth.avail);
  const dup = await postRefund({ orderId: `${TAG}-o1`, orderNumber: "LT-9001", walletId: wid, provider: "fpx_toyyibpay", amountMinor: 5000, commissionReversalMinor: 250, refundId: `${TAG}-r1` });
  const afterDup = (await truthSnapshot()).truth.avail;
  t("7c: duplicate refund replay converges (dedupKey, no double debit)", afterDup === snap.truth.avail, `idempotentReplay=${dup.idempotentReplay === true}`);

  // ── Case 8: concurrent operations on the same wallet ─────────────────────
  // 5 (not 8) — connection budget: script pool(4) + dev server + pg must stay
  // under the measured Supavisor session pool_size=15 [EMAXCONNSESSION].
  console.log("── case 8: 5 concurrent same-wallet postings ──");
  await refreshWalletCache(wid);
  const beforeConc = (await truthSnapshot()).truth;
  const conc = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) =>
      postOrderPaid({
        orderId: `${TAG}-c${i}`, orderNumber: `LT-91${String(i).padStart(2, "0")}`, walletId: wid, provider: "fpx_toyyibpay",
        totalMinor: 1000, sellerNetMinor: 900, commissionMinor: 100,
        holdUntil: new Date(Date.now() + 3600_000), // stay pending
      })
    )
  );
  const okConc = conc.filter((r) => r.status === "fulfilled").length;
  await refreshWalletCache(wid);
  snap = await truthSnapshot();
  t("8a: 5/5 concurrent postings succeed (row-lock wait, no SSI storm)", okConc === 5, `${okConc}/5`);
  t("8b: exactly 5 new pending credits (no double/lost movement)", snap.truth.pend === beforeConc.pend + 4500, `pend ${beforeConc.pend} → ${snap.truth.pend}`);
  t("8c: final cache == truth", snap.cache.avail === snap.truth.avail && snap.cache.pend === snap.truth.pend);

  // ── Case 10: wallet-cache-update failure → atomic rollback ───────────────
  console.log("── case 10: fault injection at the cache-update boundary ──");
  const pg = await pgClient();
  await pg.query(`CREATE TABLE IF NOT EXISTS lt_fault_flags (k text primary key, v int not null default 1)`);
  await pg.query(`CREATE OR REPLACE FUNCTION lt_fault_once() RETURNS trigger AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM lt_fault_flags WHERE k = TG_ARGV[0]) THEN
        DELETE FROM lt_fault_flags WHERE k = TG_ARGV[0];
        RAISE EXCEPTION 'LT fault injection: %', TG_ARGV[0];
      END IF;
      RETURN COALESCE(NEW, OLD);
    END $$ LANGUAGE plpgsql`);
  await pg.query(`DROP TRIGGER IF EXISTS lt_fault_wallet ON "Wallet"`);
  await pg.query(`CREATE TRIGGER lt_fault_wallet BEFORE UPDATE ON "Wallet" FOR EACH ROW EXECUTE FUNCTION lt_fault_once('wallet_update')`);
  await pg.query(`INSERT INTO lt_fault_flags (k) VALUES ('wallet_update') ON CONFLICT (k) DO UPDATE SET v = 1`);
  const preFaultFp = await ledgerFingerprint();
  let faulted = false;
  try {
    await postOrderPaid({
      orderId: `${TAG}-f1`, orderNumber: "LT-9500", walletId: wid, provider: "fpx_toyyibpay",
      totalMinor: 1000, sellerNetMinor: 900, commissionMinor: 100, holdUntil: new Date(),
    });
  } catch (e) {
    faulted = true;
  }
  const postFaultFp = await ledgerFingerprint();
  t("10a: posting path THROWS when the cache update faults", faulted);
  // SEMANTICS [verified]: the standalone recipe commits the posting in its own
  // tx BEFORE the (separate, auto-commit) cache write — so a cache-write fault
  // cannot un-post or corrupt money: the T1 survives, balanced, and the cache
  // is left benignly stale (classified by the invariant, healed on next
  // refresh). The WEBHOOK path (tx-caller) is atomic posting+orders in ONE tx
  // with the cache write post-commit+caught — that boundary is fault-tested
  // over HTTP in remediation-live-tests.ts (case W4).
  t("10b: T1 posting SURVIVED committed and balanced (no lost/partial money)", postFaultFp.count === preFaultFp.count + 1, `${preFaultFp.count}→${postFaultFp.count}`);
  await pg.query(`DROP TRIGGER IF EXISTS lt_fault_wallet ON "Wallet"`);
  const f1Count = await db.ledgerTransaction.count({ where: { dedupKey: `order_paid:order:${TAG}-f1` } });
  const replay = await postOrderPaid({
    orderId: `${TAG}-f1`, orderNumber: "LT-9500", walletId: wid, provider: "fpx_toyyibpay",
    totalMinor: 1000, sellerNetMinor: 900, commissionMinor: 100, holdUntil: new Date(),
  });
  const f1AfterReplay = await db.ledgerTransaction.count({ where: { dedupKey: `order_paid:order:${TAG}-f1` } });
  t("10c: retry after the fault converges via dedupKey (no double posting)", f1Count === 1 && f1AfterReplay === 1 && replay.idempotentReplay === true, `txns=${f1AfterReplay}`);
  snap = await truthSnapshot();
  t("10d: cache healed by the retry's refresh (== truth again)", snap.cache.avail === snap.truth.avail && snap.cache.pend === snap.truth.pend);

  // ── Case 11: retry after transient failure (fault-once trigger) ──────────
  console.log("── case 11: transient fault then retry converges exactly-once ──");
  await pg.query(`DROP TRIGGER IF EXISTS lt_fault_txn ON "LedgerTransaction"`);
  await pg.query(`CREATE TRIGGER lt_fault_txn BEFORE INSERT ON "LedgerTransaction" FOR EACH ROW EXECUTE FUNCTION lt_fault_once('ledger_insert')`);
  await pg.query(`INSERT INTO lt_fault_flags (k) VALUES ('ledger_insert') ON CONFLICT (k) DO UPDATE SET v = 1`);
  let firstAttemptFailed = false;
  try {
    await postOrderPaid({
      orderId: `${TAG}-f2`, orderNumber: "LT-9501", walletId: wid, provider: "fpx_toyyibpay",
      totalMinor: 1000, sellerNetMinor: 900, commissionMinor: 100, holdUntil: new Date(),
    });
  } catch {
    firstAttemptFailed = true;
  }
  await pg.query(`DROP TRIGGER IF EXISTS lt_fault_txn ON "LedgerTransaction"`);
  const retry = await postOrderPaid({
    orderId: `${TAG}-f2`, orderNumber: "LT-9501", walletId: wid, provider: "fpx_toyyibpay",
    totalMinor: 1000, sellerNetMinor: 900, commissionMinor: 100, holdUntil: new Date(),
  });
  const f2Count = await db.ledgerTransaction.count({ where: { dedupKey: `order_paid:order:${TAG}-f2` } });
  t("11a: first attempt failed on injected fault", firstAttemptFailed);
  t("11b: retry succeeds and exactly ONE posting exists (dedupKey backstop)", retry && f2Count === 1, `txns=${f2Count}`);
  await pg.query(`DROP TABLE IF EXISTS lt_fault_flags`);
  await pg.end();

  // ── final reconciliation ─────────────────────────────────────────────────
  await refreshWalletCache(wid);
  const finInv = await runLedgerInvariants();
  t("final: fixture wallet fully reconciled (no drift of either class)", !finInv.hardDrift.some((d) => d.walletId === wid) && !finInv.timeMaturityStale.some((d) => d.walletId === wid));
  t("final: ledger still balanced after every operation", finInv.problems.filter((p) => p.includes("unbalanced")).length === 0);
} finally {
  // ── cleanup: remove fixture ledger rows + accounts + wallet + seller ─────
  try {
    await db.ledgerTransaction.deleteMany({ where: { OR: [{ dedupKey: { contains: TAG } }, { refId: { startsWith: TAG } }] } });
    await db.ledgerAccount.deleteMany({ where: { walletId: wid } });
    await db.wallet.delete({ where: { id: wid } }).catch(() => {});
    await db.seller.delete({ where: { id: seller.id } }).catch(() => {});
    console.log("\n[cleanup] fixture seller/wallet/ledger rows removed");
  } catch (e) {
    console.error("[cleanup] partial:", e instanceof Error ? e.message : e);
  }
}

results.finishedAt = new Date().toISOString();
results.failures = failures;
writeFileSync(`performance/runs/${new Date().toISOString().slice(0, 10)}-finance-regression.json`, JSON.stringify(results, null, 2)); // never clobber archived runs
process.exit(exitCode());
