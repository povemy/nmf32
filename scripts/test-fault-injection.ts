// ============================================================================
// test-fault-injection.ts — EXECUTED fault-injection rollback tests at the
// real transaction boundaries of order / inventory / payment-state / ledger
// (PROD-READY mission Phase 2.1 + 2.2).
//
// METHOD (real injection, not structural reasoning):
//   A separate Prisma client opens its own connection and takes a genuine
//   PostgreSQL row lock (`SELECT … FOR UPDATE`) on ONE [LT]-owned row that
//   sits exactly at a chosen application transaction boundary. The real HTTP
//   path is then driven (create / simulate / expiry tick); the application's
//   transaction blocks on that row, exceeds its interactive-tx budget and
//   dies with Prisma P2028 — the same transient-DB-failure class production
//   would see under pool exhaustion or a killed backend. The test then
//   asserts FULL ROLLBACK (no partial order / stock / ledger / payment
//   state), releases the lock, redelivers (PSP-contract retry) and asserts
//   exactly-once convergence.
//
// Boundaries covered:
//   A  checkout-create tx        (order + inventory + group)      lock: ProductVariant
//   B  payment-confirm CLAIM     (payment state gate)             lock: PaymentGroup
//   C  payment-confirm POST-T1   (ledger T1 already inserted)     lock: CartItem
//   D  inventory-release CAS     (expiry sweep release)           lock: Order
//
// Safety: [LT] data only (lt-main-store / lt-buyer-* / storm variant); locks
// held ≤ 14 s on rows no other traffic touches; total client connections
// app(≤10) + lock(1) + probe(1) < Supavisor 15; no OOM, no destructive ops.
// Evidence: performance/prod-ready/fault-injection-<ts>.json
// ============================================================================
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "fs";
import { db } from "../src/lib/db";
import { BASE, LT_PASSWORD, loginShopper, createCheckout } from "./loadtest/util";

const lockDb = new PrismaClient(); // dedicated connection for fault injection
const RUN = `fi-${Date.now().toString(36)}`;
const OUT_DIR = "performance/prod-ready";
mkdirSync(OUT_DIR, { recursive: true });

type Check = { name: string; pass: boolean; detail?: string };
type TestResult = { test: string; boundary: string; status: "PASS" | "FAIL"; checks: Check[]; notes: string[] };
const results: TestResult[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function record(test: string, boundary: string, checks: Check[], notes: string[]): TestResult {
  const status = checks.every((c) => c.pass) ? "PASS" : "FAIL";
  const r: TestResult = { test, boundary, status, checks, notes };
  results.push(r);
  console.log(`\n${status === "PASS" ? "✅" : "❌"} ${test} [${boundary}] — ${checks.filter((c) => c.pass).length}/${checks.length} checks`);
  for (const c of checks) if (!c.pass) console.log(`   FAIL: ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  for (const n of notes) console.log(`   note: ${n}`);
  return r;
}
const check = (name: string, pass: boolean, detail?: string): Check => ({ name, pass, detail });

/** Lock one row and hold it until release() is called. Uses a dedicated
 *  connection so the app pool is untouched. Returns the release fn. */
async function holdRowLock(table: string, id: string, holdMs: number): Promise<() => Promise<void>> {
  let release!: () => void;
  const done = new Promise<void>((res) => (release = res));
  const holder = lockDb
    .$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`, id);
        await done; // hold the row lock
      },
      { timeout: holdMs + 60_000, maxWait: 10_000 }
    )
    .catch(() => {}); // release path ends the tx — expected
  await sleep(1_200); // give the holder time to acquire
  // Deterministic proof the lock is REALLY held: NOWAIT from a second session must fail 55P03.
  let lockHeld = false;
  try {
    await lockDb.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE NOWAIT`, id);
  } catch (e) {
    lockHeld = String((e as Error).message).includes("Could not obtain lock") || String((e as Error).message).includes("55P03");
  }
  if (!lockHeld) throw new Error(`fault-injection setup: could not verify row lock on ${table}.${id}`);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    release();
    await holder;
    await sleep(300);
  };
}

async function variantId(): Promise<string> {
  const v = await db.productVariant.findFirst({
    where: { product: { slug: "lt-perf-storm-item", store: { slug: "lt-main-store" } } },
    select: { id: true, stock: true },
  });
  if (!v) throw new Error("missing [LT] storm variant — run scripts/loadtest/seed.ts first");
  return v.id;
}

async function buyer(): Promise<{ cookie: string; email: string }> {
  const row = await db.shopperUser.findFirst({
    where: { email: { startsWith: "lt-buyer-", endsWith: "@lt.test" } },
    select: { email: true },
    orderBy: { email: "asc" },
  });
  if (!row) throw new Error("no [LT] buyers — run scripts/loadtest/seed.ts first");
  return { cookie: await loginShopper(row.email), email: row.email };
}

async function addToCart(cookie: string, vid: string, qty = 1): Promise<string> {
  const res = await fetch(`${BASE}/api/cart/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ variantId: vid, qty }),
  });
  if (res.status !== 200 && res.status !== 201) throw new Error(`cart add failed ${res.status}`);
  const row = await db.cartItem.findFirst({
    where: { variantId: vid, cart: { shopper: { email: { startsWith: "lt-buyer-" } } } },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  if (!row) throw new Error("cart row not found after add");
  return row.id;
}

async function simulate(ref: string): Promise<{ status: number; code?: string }> {
  const res = await fetch(`${BASE}/api/checkout/payments/${encodeURIComponent(ref)}/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ result: "succeeded" }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
  return { status: res.status, code: body.error?.code };
}

async function tick(): Promise<{ status: number; body: { released?: number; errors?: { orderId: string }[]; throttled?: boolean } }> {
  const res = await fetch(`${BASE}/api/orders/expiry/tick`, { method: "POST" });
  const body = (await res.json().catch(() => ({}))) as { data?: { released?: number; errors?: { orderId: string }[]; throttled?: boolean } };
  return { status: res.status, body: body.data ?? {} };
}

const t1Count = (orderId: string) => db.ledgerTransaction.count({ where: { dedupKey: `order_paid:order:${orderId}` } });
const invLogsSince = (vid: string, since: Date) =>
  db.inventoryLog.findMany({ where: { variantId: vid, createdAt: { gte: since } }, select: { delta: true, reason: true, refId: true }, orderBy: { createdAt: "asc" } });
const groupByKey = (key: string) =>
  db.paymentGroup.findUnique({ where: { idemKey: key }, include: { orders: { select: { id: true, orderNumber: true, status: true } } } });

// ---------------------------------------------------------------------------
async function testA_createBoundary() {
  const test = "A", boundary = "checkout-create tx (order+inventory+group)";
  const notes: string[] = [];
  const vid = await variantId();
  const { cookie, email } = await buyer();
  const key = `${RUN}-a`;
  const t0 = new Date();
  const before = await db.productVariant.findUnique({ where: { id: vid }, select: { stock: true } });

  const release = await holdRowLock("ProductVariant", vid, 9_000);
  try {
    const res = await createCheckout({ cookie, variantId: vid, qty: 1, idemKey: key, email });
    notes.push(`create under lock → HTTP ${res.status} (${res.body.error?.code ?? "created"}) — expect 5xx transient (P2028)`);
    const injected = res.status >= 500 || res.status === 0;
    await sleep(2_500); // let any zombie tx settle
    const g = await groupByKey(key);
    const logs = await invLogsSince(vid, t0);
    const after = await db.productVariant.findUnique({ where: { id: vid }, select: { stock: true } });
    const rollbackChecks = [
      check("injected transient DB failure observed (5xx)", injected, `got ${res.status}`),
      check("no PaymentGroup committed for the aborted tx", !g, g ? `group ${g.ref} exists` : undefined),
      check("stock unchanged after abort", after?.stock === before?.stock, `${before?.stock} → ${after?.stock}`),
      check("no inventoryLog rows written by aborted tx", logs.length === 0, JSON.stringify(logs)),
    ];

    await release();
    const retry = await createCheckout({ cookie, variantId: vid, qty: 1, idemKey: key, email });
    const g2 = await groupByKey(key);
    const logs2 = await invLogsSince(vid, t0);
    const final = await db.productVariant.findUnique({ where: { id: vid }, select: { stock: true } });
    const convergeChecks = [
      check("retry with SAME Idempotency-Key succeeds after transient failure", retry.status === 201 || retry.status === 200, `got ${retry.status}`),
      check("exactly ONE group for the key (no duplicates)", g2 !== null && retry.body.data?.paymentRef === g2.ref),
      check("exactly one order row", g2?.orders.length === 1, JSON.stringify(g2?.orders.map((o) => o.status))),
      check("stock decremented exactly once", final?.stock === (before?.stock ?? 0) - 1, `${before?.stock} → ${final?.stock}`),
      check("exactly one reserve inventoryLog", logs2.length === 1 && logs2[0].delta === -1, JSON.stringify(logs2)),
    ];
    return record(`Test ${test}`, boundary, [...rollbackChecks, ...convergeChecks], notes);
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------
async function testB_claimBoundary() {
  const test = "B", boundary = "payment-confirm claim (payment state gate)";
  const notes: string[] = [];
  const vid = await variantId();
  const { cookie, email } = await buyer();
  const key = `${RUN}-b`;
  const created = await createCheckout({ cookie, variantId: vid, qty: 1, idemKey: key, email });
  const ref = created.body.data?.paymentRef;
  if (!ref) throw new Error(`create did not return a paymentRef (status ${created.status})`);
  const g0 = await groupByKey(key);
  const gid = g0!.id;
  const oid = g0!.orders[0].id;
  await sleep(300);

  const release = await holdRowLock("PaymentGroup", gid, 15_000);
  try {
    const sim = await simulate(ref);
    notes.push(`simulate under PaymentGroup lock → HTTP ${sim.status} (${sim.code ?? "ok"}) — expect 5xx transient (P2028)`);
    const injected = sim.status >= 500 || sim.status === 0;
    await sleep(2_500);
    const g1 = await groupByKey(key);
    const log = await db.paymentWebhookLog.findFirst({ where: { providerRef: ref }, orderBy: { createdAt: "desc" } });
    const rollbackChecks = [
      check("injected transient DB failure observed (5xx)", injected, `got ${sim.status}`),
      check("payment group NOT claimed (still requires_payment)", g1?.status === "requires_payment", g1?.status),
      check("order NOT paid", g1?.orders.every((o) => o.status === "payment_pending"), JSON.stringify(g1?.orders.map((o) => o.status))),
      check("NO ledger T1 posted for the aborted tx", (await t1Count(oid)) === 0),
      check("delivery left unprocessed for the FIN-1 sweep (PSP retry contract)", log?.processed === false, `processed=${log?.processed}`),
    ];

    await release();
    const sim2 = await simulate(ref);
    const g2 = await groupByKey(key);
    const convergeChecks = [
      check("PSP redelivery converges to 200", sim2.status === 200, `got ${sim2.status}`),
      check("group flipped to succeeded exactly once", g2?.status === "succeeded", g2?.status),
      check("order paid", g2?.orders.every((o) => o.status === "paid")),
      check("exactly ONE ledger T1 after redelivery", (await t1Count(oid)) === 1),
    ];
    const sim3 = await simulate(ref);
    const convergeChecks2 = [
      check("second redelivery is an idempotent duplicate", sim3.status === 200),
      check("still exactly ONE ledger T1 (no duplicate money)", (await t1Count(oid)) === 1),
    ];
    return record(`Test ${test}`, boundary, [...rollbackChecks, ...convergeChecks, ...convergeChecks2], notes);
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------
async function testC_ledgerBoundary() {
  const test = "C", boundary = "payment-confirm POST-T1 (ledger rollback after money insert)";
  const notes: string[] = [];
  const vid = await variantId();
  const { cookie, email } = await buyer();
  const key = `${RUN}-c`;
  const cartItemId = await addToCart(cookie, vid, 1);
  const store = await db.store.findUnique({ where: { slug: "lt-main-store" }, select: { sellerId: true } });
  const walletBefore = await db.wallet.findFirst({
    where: { sellerId: store!.sellerId! },
    select: { id: true, pendingMinor: true, availableMinor: true },
  });
  const created = await createCheckout({ cookie, variantId: vid, qty: 1, idemKey: key, email });
  const ref = created.body.data?.paymentRef;
  if (!ref) throw new Error(`create did not return a paymentRef (status ${created.status})`);
  const g0 = await groupByKey(key);
  const oid = g0!.orders[0].id;
  await sleep(300);

  // Lock the shopper's cart row — the confirmation tx's LAST write is the
  // cart clear, AFTER the ledger T1 insert. Blocking there aborts a tx that
  // has already moved money → proves the ledger write is inside the tx.
  const release = await holdRowLock("CartItem", cartItemId, 16_000);
  try {
    const sim = await simulate(ref);
    notes.push(`simulate with cart-clear blocked AFTER T1 insert → HTTP ${sim.status} (${sim.code ?? "ok"}) — expect 5xx (P2028)`);
    const injected = sim.status >= 500 || sim.status === 0;
    await sleep(2_500);
    const g1 = await groupByKey(key);
    const cartRow = await db.cartItem.findUnique({ where: { id: cartItemId }, select: { id: true } });
    const walletAfter = await db.wallet.findUnique({ where: { id: walletBefore!.id }, select: { pendingMinor: true, availableMinor: true } });
    const rollbackChecks = [
      check("injected transient DB failure observed (5xx)", injected, `got ${sim.status}`),
      check("order ROLLED BACK to payment_pending (paid transition aborted)", g1?.orders.every((o) => o.status === "payment_pending"), JSON.stringify(g1?.orders.map((o) => o.status))),
      check("ledger T1 ROLLED BACK (no money effect from aborted tx)", (await t1Count(oid)) === 0),
      check("seller wallet balances unchanged (truth = ledger)", walletAfter?.pendingMinor === walletBefore?.pendingMinor && walletAfter?.availableMinor === walletBefore?.availableMinor, JSON.stringify({ before: walletBefore, after: walletAfter })),
      check("cart item still present (clear aborted)", cartRow !== null),
      check("group still requires_payment", g1?.status === "requires_payment", g1?.status),
    ];

    await release();
    const sim2 = await simulate(ref);
    const g2 = await groupByKey(key);
    const cartAfter = await db.cartItem.findUnique({ where: { id: cartItemId }, select: { id: true } });
    const convergeChecks = [
      check("redelivery after post-T1 abort converges to 200", sim2.status === 200, `got ${sim2.status}`),
      check("order paid after redelivery", g2?.orders.every((o) => o.status === "paid")),
      check("exactly ONE ledger T1 (aborted copy left no residue)", (await t1Count(oid)) === 1),
      check("cart cleared exactly once (row gone)", cartAfter === null),
    ];
    return record(`Test ${test}`, boundary, [...rollbackChecks, ...convergeChecks], notes);
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------
async function testD_releaseBoundary() {
  const test = "D", boundary = "inventory-release CAS (expiry sweep)";
  const notes: string[] = [];
  const vid = await variantId();
  const { cookie, email } = await buyer();
  const key = `${RUN}-d`;
  const t0 = new Date();
  const created = await createCheckout({ cookie, variantId: vid, qty: 1, idemKey: key, email });
  const ref = created.body.data?.paymentRef;
  if (!ref) throw new Error(`create did not return a paymentRef (status ${created.status})`);
  const g0 = await groupByKey(key);
  const oid = g0!.orders[0].id;
  const stock0 = (await db.productVariant.findUnique({ where: { id: vid }, select: { stock: true } }))!.stock;
  await db.paymentGroup.update({ where: { ref }, data: { expiresAt: new Date(Date.now() - 31 * 60 * 1000) } });
  await sleep(300);

  const release = await holdRowLock("Order", oid, 9_000);
  try {
    const t1 = await tick();
    notes.push(`tick under Order-row lock → HTTP ${t1.status}, errors=${JSON.stringify(t1.body.errors ?? [])} — sweep must survive (error-collecting)`);
    await sleep(2_500);
    const g1 = await groupByKey(key);
    // PROD-READY lesson (run fi-mvkp4p9d): assert PER-ORDER, not per-variant-window —
    // the lazy sweep may legitimately release OTHER eligible [LT] orders (older runs'
    // aged reservations) on the same variant inside the measurement window.
    const restocksOid = (await invLogsSince(vid, t0)).filter((l) => l.delta > 0 && l.refId === oid);
    const rollbackChecks = [
      check("order NOT released while lock held", g1?.orders.every((o) => o.status === "payment_pending"), JSON.stringify(g1?.orders.map((o) => o.status))),
      check("no restock inventoryLog for THIS order from aborted release", restocksOid.length === 0, JSON.stringify(restocksOid)),
      check("no history row to cancelled", (await db.orderStatusHistory.count({ where: { orderId: oid, toStatus: "cancelled" } })) === 0),
    ];

    await release();
    const t2 = await tick();
    const g2 = await groupByKey(key);
    const restocksOid2 = (await invLogsSince(vid, t0)).filter((l) => l.delta > 0 && l.refId === oid);
    const convergeChecks = [
      check("sweep after lock release releases the reservation", g2?.orders.every((o) => o.status === "cancelled") === true, JSON.stringify(g2?.orders.map((o) => o.status))),
      check("exactly one restock inventoryLog for THIS order (+qty)", restocksOid2.length === 1 && restocksOid2[0].delta === 1, JSON.stringify(restocksOid2)),
      check("variant stock grew by at least qty (other [LT] releases may interleave)", (await db.productVariant.findUnique({ where: { id: vid }, select: { stock: true } }))!.stock >= stock0 + 1),
    ];
    await tick();
    await tick();
    const restocksOid3 = (await invLogsSince(vid, t0)).filter((l) => l.delta > 0 && l.refId === oid);
    const repeatChecks = [
      check("repeated sweeps NEVER double-restock THIS order (exactly-once)", restocksOid3.length === 1, `restockLogs=${restocksOid3.length}`),
      check("order stays cancelled after repeated sweeps", (await groupByKey(key))?.orders.every((o) => o.status === "cancelled") === true),
    ];
    return record(`Test ${test}`, boundary, [...rollbackChecks, ...convergeChecks, ...repeatChecks], notes);
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------
async function main() {
  console.log(`=== fault-injection rollback suite ${RUN} @ ${BASE} ===`);
  console.log(`method: real PG row locks held at chosen tx boundaries → P2028 → rollback assertions → redelivery convergence\n`);
  await testA_createBoundary();
  await testB_claimBoundary();
  await testC_ledgerBoundary();
  await testD_releaseBoundary();

  const pass = results.filter((r) => r.status === "PASS").length;
  console.log(`\n=== SUMMARY: ${pass}/${results.length} boundary tests PASS ===`);
  for (const r of results) console.log(`  ${r.status}  ${r.test} — ${r.boundary}`);

  const negativeStock = await db.productVariant.count({ where: { stock: { lt: 0 }, product: { store: { slug: "lt-main-store" } } } });
  console.log(`negative-stock gate: ${negativeStock === 0 ? "PASS" : "FAIL"}`);

  writeFileSync(`${OUT_DIR}/fault-injection-${RUN}.json`, JSON.stringify({ run: RUN, base: BASE, results, negativeStockGate: negativeStock === 0 }, null, 2));
  console.log(`evidence → ${OUT_DIR}/fault-injection-${RUN}.json`);
  await lockDb.$disconnect();
  process.exit(pass === results.length && negativeStock === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("suite crashed:", e);
  process.exit(2);
});
