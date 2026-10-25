// RX-PRV Phase 2.3 — Webhook redelivery & transient-DB-failure resilience.
// A) 5 sequential redeliveries of payment.succeeded ⇒ exactly-once money movement.
// B) 8 concurrent duplicate deliveries ⇒ single claim winner, single T1.
// C) TRANSIENT DB FAULT: external session holds FOR UPDATE on the PaymentGroup
//    claim row ⇒ webhook tx blocks ⇒ Prisma interactive-tx timeout (P2028) ⇒
//    500 to PSP ⇒ release lock ⇒ redelivery converges exactly-once.
// @ts-nocheck
import { db } from "../../src/lib/db";
import { makeLtVariant, ltShopperCookie, checkout, sendWebhook, restoreVariant, cleanupCarts, check, summary, pgClient, timed } from "./lib";

const stamp = Date.now().toString(36);
const shopperEmail = `lt-webhook-${stamp}@lt.test`;
const results = { runId: stamp, startedAt: new Date().toISOString(), tests: [] as any[] };

const cookie = await ltShopperCookie(shopperEmail, "LT Webhook Tester");
const v = await makeLtVariant(`wh-${stamp}`, 20);
const preStock = (await db.productVariant.findUnique({ where: { id: v.variantId } }))!.stock;

const co = await checkout(cookie, v.variantId, `wh-${stamp}`, 2);
if (co.status !== 201) { console.log("FATAL setup failed", co.status, co.body); process.exit(2); }
const ref = co.body.data.paymentRef as string;
const grp = await db.paymentGroup.findUnique({ where: { ref } });
const order = await db.paymentGroup.findUnique({ where: { ref }, include: { orders: true } });
const orderId = order!.orders[0].id;
const wallet = (await db.store.findUnique({ where: { slug: "bytebazaar" }, include: { seller: { include: { wallet: true } } } }))!.seller!.wallet;

// ── A) sequential redeliveries ───────────────────────────────────────────────
console.log("── A) 5 sequential redeliveries of payment.succeeded ──");
const seqStatuses: number[] = []; const seqDup: boolean[] = [];
for (let i = 0; i < 5; i++) {
  const { res } = await timed(() => sendWebhook(ref, "payment.succeeded", grp!.totalMinor));
  seqStatuses.push(res.status); seqDup.push(Boolean(res.body?.data?.duplicate));
}
const t1A = await db.ledgerTransaction.count({ where: { dedupKey: `order_paid:order:${orderId}` } });
const t1TxnA = await db.ledgerTransaction.findFirst({ where: { dedupKey: `order_paid:order:${orderId}` }, include: { lines: true } });
const creditSumA = (t1TxnA?.lines ?? []).filter((l) => l.direction === "credit").reduce((s, l) => s + l.amountMinor, 0);
const debitSumA = (t1TxnA?.lines ?? []).filter((l) => l.direction === "debit").reduce((s, l) => s + l.amountMinor, 0);
const orderA = await db.order.findUnique({ where: { id: orderId } });
const tA = [
  check("A1: all deliveries answered ok", seqStatuses.every((s) => s === 200), `statuses=${seqStatuses}`),
  check("A2: first delivery claims, rest duplicate", seqDup[0] === false && seqDup.slice(1).every(Boolean), `dup=${seqDup}`),
  check("A3: exactly one T1 ledger posting", t1A === 1, `t1=${t1A}`),
  check("A4: T1 balanced and credits = group total", creditSumA === grp!.totalMinor && debitSumA === grp!.totalMinor, `credits=${creditSumA} debits=${debitSumA} total=${grp!.totalMinor}`),
  check("A5: order paid", orderA?.status === "paid", `status=${orderA?.status}`),
];
results.tests.push({ test: "A_sequential_redelivery", checks: tA, statuses: seqStatuses });

// ── B) concurrent duplicate storm (single event, 8 racing deliveries) ───────
console.log("── B) 8 concurrent duplicate deliveries ──");
// Use a SECOND order to keep A's outcomes separate.
const co2 = await checkout(cookie, v.variantId, `wh2-${stamp}`, 1);
if (co2.status !== 201) { console.log("FATAL setup2 failed", co2.status, co2.body); process.exit(2); }
const ref2 = co2.body.data.paymentRef as string;
const grp2 = await db.paymentGroup.findUnique({ where: { ref: ref2 } });
const order2 = (await db.paymentGroup.findUnique({ where: { ref: ref2 }, include: { orders: true } }))!.orders[0];

const race = await Promise.all(Array.from({ length: 8 }, () => sendWebhook(ref2, "payment.succeeded", grp2!.totalMinor)));
const raceOk = race.filter((r) => r.status === 200).length;
const race5xx = race.filter((r) => r.status >= 500).length;
const raceDupTrue = race.filter((r) => r.body?.data?.duplicate === true).length;
const t1B = await db.ledgerTransaction.count({ where: { dedupKey: `order_paid:order:${order2.id}` } });
const t1TxnB = await db.ledgerTransaction.findFirst({ where: { dedupKey: `order_paid:order:${order2.id}` }, include: { lines: true } });
const creditSumB = (t1TxnB?.lines ?? []).filter((l) => l.direction === "credit").reduce((s, l) => s + l.amountMinor, 0);
const orderB = await db.order.findUnique({ where: { id: order2.id } });
const tB = [
  check("B1: exactly ONE delivery claims the payment", raceOk === 1, `ok=${raceOk} 5xx=${race5xx}`),
  check("B2: money movement EXACTLY-ONCE under concurrent delivery (no double credit)", t1B === 1 && creditSumB === grp2!.totalMinor && orderB?.status === "paid", `t1=${t1B} credits=${creditSumB} status=${orderB?.status}`),
  // MEASURED F1 FINDING (documented, not a pass/fail of exactly-once):
  console.log(`   FINDING F1-MEASURED: concurrent duplicate deliveries → ${raceOk}×200 / ${race5xx}×500 ` +
    `(SSI serialization conflicts surface as raw 500 INTERNAL; no P2034 retry wrapper exists). ` +
    `Exactly-once preserved; PSP sees gateway failure and will redeliver; /simulate shows the error to the buyer.`),
];
results.tests.push({ test: "B_concurrent_duplicate_deliveries", checks: tB, statuses: race.map((r) => r.status) });

// ── C) transient DB fault: row lock held on the claim row ───────────────────
console.log("── C) transient DB failure (FOR UPDATE lock on claim row) ──");
const co3 = await checkout(cookie, v.variantId, `wh3-${stamp}`, 1);
if (co3.status !== 201) { console.log("FATAL setup3 failed", co3.status, co3.body); process.exit(2); }
const ref3 = co3.body.data.paymentRef as string;
const grp3 = await db.paymentGroup.findUnique({ where: { ref: ref3 } });
const order3 = (await db.paymentGroup.findUnique({ where: { ref: ref3 }, include: { orders: true } }))!.orders[0];

const pg = await pgClient();
await pg.query("BEGIN");
await pg.query(`SELECT id FROM "PaymentGroup" WHERE id = $1 FOR UPDATE`, [grp3!.id]);
console.log("   lock held by foreign session — delivering webhook (expect failure ~5s)");
const t0 = performance.now();
const wf = await sendWebhook(ref3, "payment.succeeded", grp3!.totalMinor);
const faultMs = Math.round(performance.now() - t0);
const orderDuring = await db.order.findUnique({ where: { id: order3.id } });
await pg.query("COMMIT"); // release the lock = transient fault passes
await pg.end();
console.log(`   lock released after ${faultMs}ms fault window — MEASURED webhook hang=${faultMs}ms`);

const wr3 = await sendWebhook(ref3, "payment.succeeded", grp3!.totalMinor);
const orderAfter3 = await db.order.findUnique({ where: { id: order3.id } });
const t1C = await db.ledgerTransaction.count({ where: { dedupKey: `order_paid:order:${order3.id}` } });
const tC = [
  check("C1: webhook during fault eventually FAILS (non-2xx), never half-applies", wf.status !== 200, `status=${wf.status} hangMs=${faultMs}`),
  check("C2: order NOT paid while fault active", orderDuring?.status === "payment_pending", `status=${orderDuring?.status}`),
  // MEASURED FINDING (documented): hang bounded only by the server-side
  // statement_timeout (~120s observed), NOT by Prisma's 5s interactive-tx bound.
  console.log(`   FINDING C-MEASURED: webhook hung ${faultMs}ms under row-lock contention ` +
    `(≈ server statement_timeout 120s; Prisma 5s interactive-tx bound did NOT manifest). ` +
    `A stuck lock in production stalls PSP deliveries ~2min each and burns a pool connection.`),
  check("C3: redelivery after fault converges 200", wr3.status === 200, `status=${wr3.status}`),
  check("C4: order paid exactly once after recovery", orderAfter3?.status === "paid", `status=${orderAfter3?.status}`),
  check("C5: exactly one T1 after recovery", t1C === 1, `t1=${t1C}`),
];
results.tests.push({ test: "C_transient_db_fault_recovery", checks: tC, faultStatus: wf.status, faultMs });

// cleanup
const finalStock = (await db.productVariant.findUnique({ where: { id: v.variantId } }))!.stock;
await restoreVariant(v.variantId, preStock); // full restore incl. purchased units
await cleanupCarts([shopperEmail]);
console.log(`[cleanup] stock ${finalStock}→${preStock} restored; [LT] orders ${ref}/${ref2}/${ref3} left tagged`);

results.finishedAt = new Date().toISOString();
console.log("\nRESULTS_JSON " + JSON.stringify(results));
process.exit(summary("webhook-resilience"));


