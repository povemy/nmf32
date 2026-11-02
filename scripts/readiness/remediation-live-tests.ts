// ============================================================================
// REMEDIATION LIVE TESTS — F1 payment-confirmation storm, F2 checkout
// admission gate, F3 expiry sweep lifecycle (mission Phases 3.9 + 4 + 5).
// ----------------------------------------------------------------------------
// All data [LT]-tagged; stock restored; triggers dropped in finally; ledger
// rows kept for audit (established readiness-suite convention).
// Environment: dev-mode app on 127.0.0.1:3000, remote Supabase PG —
// DEVELOPMENT-MODE EVIDENCE, not production capacity (REPORT hard boundaries).
// Connection budget [Measured]: Supavisor session pooler rejects >15 clients
// (EMAXCONNSESSION) — dev server ≤10 + this script (prisma limit 2 + pg fault
// client only inside fault cases) stays under it.
// @ts-nocheck
import { readFileSync, writeFileSync } from "node:fs";

// (Phase 3/Step 4: env override first — staging runs pin schema=nomofee_staging.)
const rawUrl = process.env.SUPABASE_DATABASE_URL ?? readFileSync(".env", "utf8").match(/SUPABASE_DATABASE_URL=(.+)/)?.[1]?.trim();
const limitUrl = (n: number) => rawUrl + (rawUrl.includes("?") ? "&" : "?") + `connection_limit=${n}`;
process.env.SUPABASE_DATABASE_URL = limitUrl(2);

const { db } = await import("../../src/lib/db");
const { refreshWalletCache, walletTruth, ACCOUNTS } = await import("../../src/lib/ledger");
const { LT, ltShopperCookie, makeLtVariant, checkout, sendWebhook, restoreVariant, cleanupCarts, check, exitCode, pgClient } = await import("./lib");

const stamp = Date.now().toString(36);
const results = { runId: stamp, startedAt: new Date().toISOString(), tests: [] as any[] };
let failures = 0;
// Fault-injection hygiene: EVERY trigger/table created below is recorded here
// and dropped in the script-level finally — a mid-run crash must never leave
// a fault armed (lesson from the first run: a leftover W4 trigger faulted all
// wallet updates for subsequent runs).
const faultCleanup: string[] = [];
let faultConn: any = null;
async function dropFaultArtifacts() {
  try {
    if (faultConn) {
      for (const q of faultCleanup) await faultConn.query(q).catch(() => {});
    }
  } catch {}
}
const t = (name: string, ok: boolean, detail = "") => {
  check(name, ok, detail);
  results.tests.push({ name, ok, detail });
  if (!ok) failures++;
};
const BASE = process.env.LT_BASE ?? "http://127.0.0.1:3000"; // Phase 3/Step 4: staging instance override
const data = (b: any) => b?.data ?? {};

async function postSweep() {
  // Throttle-aware: the route self-throttles 1.5 s — wait and retry once so
  // back-to-back test sweeps actually execute instead of silently no-oping.
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${BASE}/api/cron/expiry-sweep`, { method: "POST" });
    const body = await r.json().catch(() => ({}));
    if (!body?.data?.throttled) return { status: r.status, body };
    await new Promise((res) => setTimeout(res, 1700));
  }
  return { status: 200, body: { data: { throttled: true, expired: 0 } } };
}
async function payableTxnCount(walletId: string) {
  return db.ledgerTransaction.count({ where: { lines: { some: { accountCode: ACCOUNTS.sellerPayable(walletId) } } } });
}
const emails = () => ({
  f1: Array.from({ length: 15 }, (_, i) => `lt-f1-${stamp}-${i}@lt.test`),
  f2: Array.from({ length: 40 }, (_, i) => `lt-f2-${stamp}-${i}@lt.test`),
  f3: [`lt-f3-${stamp}@lt.test`],
});

try {
  // ═══════════════════════════════ F1: webhook storm ═══════════════════════
  console.log("── F1: 15 concurrent same-seller payment confirmations (+ duplicates) ──");
  const f1Variant = await makeLtVariant(`f1-${stamp}`, 200);
  const bytebazaar = await db.store.findUnique({ where: { slug: "bytebazaar" }, select: { id: true } });
  const f1Seller = await db.seller.findFirst({ where: { store: { id: bytebazaar.id } }, include: { wallet: true } });
  const f1WalletId = f1Seller.wallet.id;

  const shopperCookies: string[] = [];
  const f1Emails = emails().f1;
  for (const email of f1Emails) shopperCookies.push(await ltShopperCookie(email, "LT F1 Buyer"));

  const created: { ref: string; total: number }[] = [];
  for (let i = 0; i < 15; i += 5) {
    const batch = await Promise.all(
      Array.from({ length: 5 }, (_, j) => checkout(shopperCookies[i + j], f1Variant.variantId, `f1-${stamp}-${i + j}`))
    );
    batch.forEach((r) => {
      const d = data(r.body);
      if (r.status === 201 && d.paymentRef) created.push({ ref: d.paymentRef, total: d.totalMinor });
    });
  }
  t("F1-pre: 15 checkouts created", created.length === 15, `${created.length}/15`);

  const preTxns = await payableTxnCount(f1WalletId);
  // THE MEASURED STORM — 0/15 succeeded before the remediation (REPORT §5.4).
  const storm = await Promise.all(created.map((c) => sendWebhook(c.ref, "payment.succeeded", c.total)));
  const stormOk = storm.filter((s) => s.status === 200 && data(s.body).ok && !data(s.body).duplicate).length;
  const storm5xx = storm.filter((s) => s.status >= 500).length;
  t("F1-a: ≥13/15 unique confirmations succeed first-try (was 0/15 pre-fix)", stormOk >= 13, `${stormOk}/15 ok, ${storm5xx} raw-5xx`);
  const postTxns = await payableTxnCount(f1WalletId);
  t("F1-b: exactly-once money movement (one T1 per succeeded confirmation)", postTxns - preTxns === stormOk, `postings=${postTxns - preTxns} successes=${stormOk}`);

  const dupes = await Promise.all(created.map((c) => sendWebhook(c.ref, "payment.succeeded", c.total)));
  const dupesOk = dupes.filter((s) => s.status === 200 && data(s.body).ok && data(s.body).duplicate).length;
  const dupes200 = dupes.filter((s) => s.status === 200 && data(s.body).ok).length;
  const postDupTxns = await payableTxnCount(f1WalletId);
  // PHASE 3 / STEP 4 assertion fix (staging evidence): the original form
  // demanded dupesOk===15 AND postDupTxns===postTxns — internally inconsistent
  // with F1-a, which TOLERATES a raw-5xx confirmation (bounded Serializable
  // retries). A duplicate of a NEVER-SUCCEEDED confirmation is a legitimate
  // first completion: it returns 200 (not marked duplicate) and posts its one
  // T1. The true invariant — verified in the staging DB after the 2026-11-02
  // run (15/15 orders paid, each with EXACTLY ONE order_paid dedupKey posting;
  // storm 14×T1 + duplicate-phase +1 for the rolled-back ref) — is: (a) every
  // duplicate answers 200 ok (graceful), (b) duplicates-of-succeeded are
  // duplicate-acks, (c) postings grow by at most the count of originals that
  // failed in F1-a (each completed exactly once — never more), (d) total
  // postings == total succeeded refs. No system behavior was changed.
  const originalsFailed = 15 - stormOk;
  t(
    "F1-c: 15 concurrent duplicates all graceful (200 ok); postings converge exactly-once per ref",
    dupes200 === 15 &&
      dupesOk === stormOk &&
      postDupTxns - postTxns <= originalsFailed &&
      postDupTxns - preTxns === 15, // every storm ref ended paid with exactly one T1
    `${dupesOk}/15 dup-ok (dup-acks), ${dupes200}/15 graceful-200, postings ${postTxns}→${postDupTxns} (+${postDupTxns - postTxns} ≤ failed ${originalsFailed}; total ${postDupTxns - preTxns}/15 exactly-once)`,
  );

  await refreshWalletCache(f1WalletId);
  const [wRow, truth] = await Promise.all([db.wallet.findUnique({ where: { id: f1WalletId } }), walletTruth(f1WalletId)]);
  t("F1-d: wallet cache == ledger truth after the storm (post-commit refresh)", wRow.availableMinor === truth.availableMinor && wRow.pendingMinor === truth.pendingMinor, `cache=${wRow.availableMinor}/${wRow.pendingMinor} truth=${truth.availableMinor}/${truth.pendingMinor}`);

  // ═══════════════════════════════ F2: admission gate ══════════════════════
  console.log("── F2: 40 concurrent checkouts on stock=25 → clean overload, zero raw 5xx ──");
  const f2Variant = await makeLtVariant(`f2-${stamp}`, 25);
  const f2Cookies: string[] = [];
  for (const email of emails().f2) f2Cookies.push(await ltShopperCookie(email, "LT F2 Buyer"));

  const f2Start = performance.now();
  const f2 = await Promise.all(
    f2Cookies.map((cookie, i) =>
      fetch(`${BASE}/api/checkout/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie, "Idempotency-Key": `f2-${stamp}-${i}` },
        body: JSON.stringify({
          items: [{ variantId: f2Variant.variantId, qty: 1 }],
          customer: { name: "LT F2 Buyer", email: emails().f2[i] },
          shippingAddress: { line1: "1 LT Jalan", city: "Kuala Lumpur", postcode: "50000", state: "Kuala Lumpur" },
          provider: "fpx_toyyibpay",
        }),
      }).then(async (r) => ({ status: r.status, retryAfter: r.headers.get("Retry-After"), queueMs: r.headers.get("X-Checkout-Queue-Ms"), body: await r.json().catch(() => ({})) }))
    )
  );
  const f2Ms = Math.round(performance.now() - f2Start);
  const f2By = (s: number) => f2.filter((r) => r.status === s).length;
  // Raw server errors = 5xx that are NOT the gate's clean, retryable 503
  // CHECKOUT_BUSY (that is the DESIRED overload response, counted separately).
  const serverErrors = f2.filter((r) => r.status >= 500 && r.body?.error?.code !== "CHECKOUT_BUSY").length;
  const busy = f2.filter((r) => r.status === 503);
  const busyWithRetryAfter = busy.filter((r) => r.retryAfter && Number(r.retryAfter) > 0).length;
  const created201 = f2By(201);
  const oos409 = f2By(409);
  t("F2-a: ZERO raw 5xx under a 40-wide rush (was 17/40 raw 500s pre-fix)", serverErrors === 0, `201=${created201} 409=${oos409} 503busy=${f2By(503)} raw5xx=${serverErrors} (${f2Ms}ms)`);
  t("F2-b: every 503 carries Retry-After", busy.length === 0 || busyWithRetryAfter === busy.length, `${busyWithRetryAfter}/${busy.length}`);
  t("F2-c: every 201 carries queue-time telemetry", f2.filter((r) => r.status === 201).every((r) => r.queueMs !== null && r.queueMs !== undefined));
  t("F2-d: stock bound respected (201s ≤ stock; no oversell)", created201 <= 25, `201=${created201} stock=25`);
  const f2StockAfter = (await db.productVariant.findUnique({ where: { id: f2Variant.variantId } }))?.stock ?? -1;
  t("F2-e: stock == 25 − successes (503/409 consumed nothing)", f2StockAfter === 25 - created201, `stock=${f2StockAfter}`);

  if (busy.length > 0) {
    const busyIdx = f2.findIndex((r) => r.status === 503);
    const retry = await checkout(f2Cookies[busyIdx], f2Variant.variantId, `f2-${stamp}-${busyIdx}`);
    const rd = data(retry.body);
    t("F2-f: retry after 503, SAME Idempotency-Key → clean outcome (never 5xx)", retry.status === 201 || retry.status === 409 || (retry.status === 200 && rd.duplicate), `${retry.status}`);
  } else {
    t("F2-f: (no 503 this run — gate absorbed all 40; Retry-After contract still verified structurally)", true);
  }
  await restoreVariant(f2Variant.variantId, 25);

  // ═══════════════════════════════ F3: expiry sweep ════════════════════════
  console.log("── F3: backlog drain (measured remediation), then lifecycle/race/fault cases ──");
  // DRAIN: 132 eligible groups accumulated from October's load tests (their
  // stock had been held since checkout). Draining is the F3 fix working as
  // designed — measure eligible count, sweeps needed, and wall time.
  const drainStart = performance.now();
  let drained = 0, drainRounds = 0, drainFailures = 0;
  let preBacklog = 0;
  for (let i = 0; i < 10; i++) {
    const s = await postSweep();
    const d = data(s.body);
    if (i === 0) preBacklog = (d.remainingBacklog ?? 0) + (d.expired ?? 0);
    drained += d.expired ?? 0;
    drainFailures += d.failures ?? 0;
    drainRounds++;
    if ((d.remainingBacklog ?? 1) === 0) break;
  }
  const drainMs = Math.round(performance.now() - drainStart);
  const drainedCheck = preBacklog > 0 ? drained >= preBacklog - 5 : true; // tiny margin for racing expiries
  t("F3-drain: pre-existing eligible backlog fully processed", drainedCheck && drainFailures === 0, `pre=${preBacklog} drained=${drained} rounds=${drainRounds} ${drainMs}ms (${Math.round(drained / (drainMs / 1000))}/min) failures=${drainFailures}`);

  console.log("── F3: expiry lifecycle, races, late payment, fault recovery ──");
  const eVariant = await makeLtVariant(`f3-${stamp}`, 5);
  const eShopper = await ltShopperCookie(`lt-f3-${stamp}@lt.test`, "LT F3 Buyer");
  async function expireableCheckout(idem: string) {
    const r = await checkout(eShopper, eVariant.variantId, idem);
    const d = data(r.body);
    if (r.status !== 201 || !d.paymentRef) throw new Error(`checkout ${idem} → ${r.status}`);
    const group = await db.paymentGroup.findUnique({ where: { ref: d.paymentRef } });
    await db.paymentGroup.update({ where: { id: group.id }, data: { expiresAt: new Date(Date.now() - 5000) } }); // force eligibility
    return { ref: group.ref, id: group.id, total: d.totalMinor as number };
  }
  const stockOf = async () => (await db.productVariant.findUnique({ where: { id: eVariant.variantId } }))!.stock;
  const expiryLogsFor = (orderId: string) => db.inventoryLog.count({ where: { refId: orderId, reason: { startsWith: "expiry:" } } });

  // E1 — expiry enforced, stock released atomically.
  const g1 = await expireableCheckout(`f3-e1-${stamp}`);
  const stockBeforeE1 = await stockOf();
  const s1 = await postSweep();
  const order1 = await db.order.findFirst({ where: { paymentGroupId: g1.id } });
  const log1 = await expiryLogsFor(order1.id);
  t("F3-E1: group expired, order payment_expired, stock restored +1, InventoryLog written", order1.status === "payment_expired" && (await stockOf()) === stockBeforeE1 + 1 && log1 === 1, `stock ${stockBeforeE1}→${await stockOf()} logs=${log1}`);

  // E2 — repeated sweep: no double restock.
  await postSweep();
  t("F3-E2: repeated sweep restocks nothing (stock stable, still one log)", (await stockOf()) === stockBeforeE1 + 1 && (await expiryLogsFor(order1.id)) === 1, `stock=${await stockOf()} logs=${await expiryLogsFor(order1.id)}`);

  // E3 — overlapping sweeps (3 concurrent; throttle makes extras no-ops).
  const g3 = await expireableCheckout(`f3-e3-${stamp}`);
  const stockBeforeE3 = await stockOf();
  await Promise.all([postSweep(), postSweep(), postSweep()]);
  const order3 = await db.order.findFirst({ where: { paymentGroupId: g3.id } });
  t("F3-E3: overlapping sweeps → exactly one restock", (await stockOf()) === stockBeforeE3 + 1 && (await expiryLogsFor(order3.id)) === 1, `stock=${await stockOf()} logs=${await expiryLogsFor(order3.id)}`);

  // E4 — a PAID order is never restocked by the sweep.
  const g4 = await expireableCheckout(`f3-e4-${stamp}`);
  const pay4 = await sendWebhook(g4.ref, "payment.succeeded", g4.total);
  const group4 = await db.paymentGroup.findUnique({ where: { ref: g4.ref } });
  const order4 = await db.order.findFirst({ where: { paymentGroupId: g4.id } });
  const stockAfterPay4 = await stockOf();
  const s4 = await postSweep();
  t("F3-E4: paid group not expired by sweep; order stays paid; stock NOT restored", pay4.status === 200 && group4.status === "succeeded" && order4.status === "paid" && (await stockOf()) === stockAfterPay4, `group=${group4.status} order=${order4.status} stock ${stockAfterPay4}→${await stockOf()}`);

  // E5 — late successful payment AFTER release → definitive refusal, no money.
  const g5 = await expireableCheckout(`f3-e5-${stamp}`);
  const s5 = await postSweep();
  const stockAfterRelease5 = await stockOf();
  const preE5Txns = await payableTxnCount(f1WalletId);
  const late = await sendWebhook(g5.ref, "payment.succeeded", g5.total);
  const postE5Txns = await payableTxnCount(f1WalletId);
  const order5 = await db.order.findFirst({ where: { paymentGroupId: g5.id } });
  t("F3-E5-pre: sweep actually claimed g5 before the late webhook", (data(s5.body)?.expired ?? 0) >= 1 && order5?.status === "payment_expired", `expired=${data(s5.body)?.expired}`);
  t("F3-E5: late payment after release → 409 GROUP_EXPIRED, NO T1, order stays expired, stock stays released", late.status === 409 && late.body?.error?.code === "GROUP_EXPIRED" && postE5Txns === preE5Txns && order5.status === "payment_expired" && (await stockOf()) === stockAfterRelease5, `${late.status} ${late.body?.error?.code} postings ${preE5Txns}→${postE5Txns} stock=${await stockOf()}`);

  // E6 — DB failure mid-sweep: claim rolls back, retry converges exactly-once.
  const g6 = await expireableCheckout(`f3-e6-${stamp}`);
  const stockBeforeE6 = await stockOf();
  const pg = await pgClient();
  faultConn = pg;
  await pg.query(`CREATE TABLE IF NOT EXISTS lt_fault_flags2 (k text primary key, v int not null default 1)`);
  faultCleanup.push(`DROP TRIGGER IF EXISTS lt_fault_invlog ON "InventoryLog"`, `DROP TABLE IF EXISTS lt_fault_flags2`);
  await pg.query(`CREATE OR REPLACE FUNCTION lt_fault_sweep() RETURNS trigger AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM lt_fault_flags2 WHERE k = 'invlog') THEN
        DELETE FROM lt_fault_flags2 WHERE k = 'invlog';
        RAISE EXCEPTION 'LT fault injection: sweep inventoryLog';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await pg.query(`DROP TRIGGER IF EXISTS lt_fault_invlog ON "InventoryLog"`);
  await pg.query(`CREATE TRIGGER lt_fault_invlog BEFORE INSERT ON "InventoryLog" FOR EACH ROW EXECUTE FUNCTION lt_fault_sweep()`);
  await pg.query(`INSERT INTO lt_fault_flags2 (k) VALUES ('invlog')`);
  await postSweep();
  const group6a = await db.paymentGroup.findUnique({ where: { ref: g6.ref } });
  const order6a = await db.order.findFirst({ where: { paymentGroupId: g6.id } });
  t("F3-E6a: DB fault mid-sweep → whole group tx rolled back (group unpaid, order pending, stock unchanged)", group6a.status === "requires_payment" && order6a.status === "payment_pending" && (await stockOf()) === stockBeforeE6, `group=${group6a.status} order=${order6a.status} stock=${await stockOf()}`);
  await pg.query(`DROP TRIGGER IF EXISTS lt_fault_invlog ON "InventoryLog"`);
  await pg.query(`DROP TABLE IF EXISTS lt_fault_flags2`);
  await pg.end();
  await postSweep();
  const order6b = await db.order.findFirst({ where: { paymentGroupId: g6.id } });
  t("F3-E6b: recovery sweep converges exactly-once (order expired, stock restored once)", order6b.status === "payment_expired" && (await stockOf()) === stockBeforeE6 + 1 && (await expiryLogsFor(order6b.id)) === 1, `stock ${stockBeforeE6}→${await stockOf()} logs=${await expiryLogsFor(order6b.id)}`);

  // E7 — backlog observability endpoint.
  const e7r = await fetch(`${BASE}/api/cron/expiry-sweep`);
  const e7 = await e7r.json();
  t("F3-E7: GET sweep telemetry returns backlog + durable lastRun", e7r.status === 200 && typeof e7?.data?.backlog === "number" && Boolean(e7?.data?.lastRun), `backlog=${e7?.data?.backlog} lastRun.at=${e7?.data?.lastRun?.at}`);

  // ═════════════════ W4: webhook-path cache-write fault (Phase 5) ══════════
  console.log("── W4: wallet-cache write fault on the REAL webhook path ──");
  const w4Checkout = await checkout(eShopper, eVariant.variantId, `w4-live-${stamp}`);
  const w4Ref = data(w4Checkout.body).paymentRef;
  const w4Total = data(w4Checkout.body).totalMinor;
  const pg2 = await pgClient();
  faultConn = pg2;
  await pg2.query(`CREATE TABLE IF NOT EXISTS lt_fault_flags3 (k text primary key, v int not null default 1)`);
  faultCleanup.push(`DROP TRIGGER IF EXISTS lt_fault_wallet_w4 ON "Wallet"`, `DROP TABLE IF EXISTS lt_fault_flags3`);
  await pg2.query(`CREATE OR REPLACE FUNCTION lt_fault_wallet_w4() RETURNS trigger AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM lt_fault_flags3) THEN
        RAISE EXCEPTION 'LT fault injection: wallet update (W4)';
      END IF;
      RETURN COALESCE(NEW, OLD);
    END $$ LANGUAGE plpgsql`);
  await pg2.query(`DROP TRIGGER IF EXISTS lt_fault_wallet_w4 ON "Wallet"`);
  await pg2.query(`CREATE TRIGGER lt_fault_wallet_w4 BEFORE UPDATE ON "Wallet" FOR EACH ROW EXECUTE FUNCTION lt_fault_wallet_w4()`);
  await pg2.query(`INSERT INTO lt_fault_flags3 (k) VALUES ('on')`);
  const preW4Txns = await payableTxnCount(f1WalletId);
  const w4 = await sendWebhook(w4Ref, "payment.succeeded", w4Total);
  const postW4Txns = await payableTxnCount(f1WalletId);
  const w4Group = await db.paymentGroup.findUnique({ where: { ref: w4Ref } });
  const w4Order = await db.order.findFirst({ where: { paymentGroupId: w4Group.id } });
  t("W4-a: webhook still succeeds (cache refresh failure caught post-commit)", w4.status === 200 && data(w4.body).ok, `${w4.status}`);
  t("W4-b: money moved exactly once despite the cache-write fault", postW4Txns - preW4Txns === 1 && w4Order.status === "paid", `postings ${preW4Txns}→${postW4Txns} order=${w4Order.status}`);
  await pg2.query(`DROP TRIGGER IF EXISTS lt_fault_wallet_w4 ON "Wallet"`);
  await pg2.query(`DROP TABLE IF EXISTS lt_fault_flags3`);
  await pg2.end();
  await refreshWalletCache(f1WalletId);
  const [wRow2, truth2] = await Promise.all([db.wallet.findUnique({ where: { id: f1WalletId } }), walletTruth(f1WalletId)]);
  t("W4-c: cache recovers to == truth after the fault clears", wRow2.availableMinor === truth2.availableMinor && wRow2.pendingMinor === truth2.pendingMinor);
} finally {
  // FAULT HYGIENE FIRST — never leave an armed trigger behind.
  await dropFaultArtifacts();
  try {
    if (faultConn) await faultConn.end().catch(() => {});
  } catch {}
  try {
    const variants = await db.productVariant.findMany({ where: { product: { title: { contains: "[LT]" } } }, select: { id: true, productId: true } });
    for (const v of variants) {
      await db.productVariant.update({ where: { id: v.id }, data: { stock: 200 } });
      await db.product.update({ where: { id: v.productId }, data: { salesCount: 0 } }).catch(() => {});
    }
    const all = emails();
    await cleanupCarts([...all.f1, ...all.f2, ...all.f3]);
    console.log("\n[cleanup] LT stock restored, carts removed (orders + ledger kept for audit)");
  } catch (e) {
    console.error("[cleanup] partial:", e instanceof Error ? e.message : e);
  }
}

results.finishedAt = new Date().toISOString();
results.failures = failures;
writeFileSync(`performance/runs/${new Date().toISOString().slice(0, 10)}-remediation-live.json`, JSON.stringify(results, null, 2)); // never clobber archived runs
console.log(failures === 0 ? "\nREMEDIATION-LIVE: ALL PASS" : `\nREMEDIATION-LIVE: ${failures} FAILURES`);
process.exit(exitCode());
