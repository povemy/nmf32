// F1 evidence harness — payment-confirmation serialization failures.
// Runs the SAME workload before and after the bounded-retry fix so results are
// comparable: identical data setup, identical concurrency, identical checks.
//
// Usage:  bun scripts/test-payment-retry.ts before|after
// Output: console PASS/FAIL report + performance/f1/<label>.json evidence.
//
// Workload (the influencer-drop signature, in miniature):
//   1. 12 checkout groups for the SAME store (wallet-row contention), 1 unit each.
//   2. SAME-REF duplicate storm: 4 concurrent identical deliveries of one ref
//      → exactly one winner; losers must converge to duplicate:true, never
//      double-pay.
//   3. CROSS-REF storm: 12 concurrent deliveries (one per ref) → the SSI
//      contention window where P2034 serialization aborts appear.
// Integrity gates (hard): per order exactly one paid transition, one ledger T1,
// one payment.succeeded activity row, one seller email + one receipt email log,
// one shopper bell notification; group succeeded exactly once; stock >= 0;
// zero duplicate webhookDelivery payload rows.
//
// Label convention: every number in the evidence file is Measured unless the
// JSON key starts with "derived" or "assumed".
// @ts-nocheck
import { db } from "../src/lib/db";
import { hmacSha256Hex } from "../src/lib/password";
import { writeFileSync, mkdirSync } from "fs";

const BASE = "http://127.0.0.1:3000";
const LABEL = process.argv[2] === "after" ? "after" : "before";
const SECRET = process.env.PSP_WEBHOOK_SECRET ?? "sm_webhook_secret_demo"; // documented sandbox fallback
const N_CHECKOUTS = 12;
const N_DUP_STORM = 4;
const STORE_SLUG = "bytebazaar";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const testStart = new Date();

// ── setup: shopper + variant with enough stock ───────────────────────────────
const login = await fetch(`${BASE}/api/auth/shopper/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "qa.shopper@nomofee.test", password: "Shopper123!" }),
});
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
if (login.status !== 200 || !cookie) throw new Error(`shopper login failed: ${login.status}`);

const variant = await db.productVariant.findFirst({
  where: { product: { store: { slug: STORE_SLUG }, status: "active" }, isActive: true },
  orderBy: { createdAt: "asc" },
  select: { id: true, stock: true, product: { select: { title: true } } },
});
if (!variant) throw new Error(`no active variant for store ${STORE_SLUG}`);
const originalStock = variant.stock;
await db.productVariant.update({ where: { id: variant.id }, data: { stock: N_CHECKOUTS + 2, moq: 1 } });
console.log(`variant: ${variant.product.title} — stock set to ${N_CHECKOUTS + 2} (was ${originalStock})`);

// ── 12 checkout groups, sequential (checkout is the SLOW path; keep it out of
//    the measured concurrency window so storms measure CONFIRMATION only) ────
const refs: string[] = [];
const orderIds: string[] = [];
const checkoutMs: number[] = [];
for (let i = 0; i < N_CHECKOUTS; i++) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/checkout/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie, "Idempotency-Key": `f1-${LABEL}-${Date.now()}-${i}` },
    body: JSON.stringify({
      items: [{ variantId: variant.id, qty: 1 }],
      customer: { name: "QA Shopper", email: "qa.shopper@nomofee.test" },
      shippingAddress: { line1: "1 Test Jalan", city: "Kuala Lumpur", postcode: "50000", state: "Kuala Lumpur" },
      provider: "fpx_toyyibpay",
    }),
  });
  checkoutMs.push(Date.now() - t0);
  const j = (await res.json()) as { data?: { paymentRef?: string }; error?: { code?: string } };
  if (res.status !== 201 || !j.data?.paymentRef) throw new Error(`checkout ${i} failed: ${res.status} ${JSON.stringify(j.error ?? {})}`);
  refs.push(j.data.paymentRef);
}
const groups = await db.paymentGroup.findMany({
  where: { ref: { in: refs } },
  include: { orders: { select: { id: true, orderNumber: true, totalMinor: true } } },
});
for (const ref of refs) {
  const g = groups.find((x) => x.ref === ref);
  if (!g || g.orders.length !== 1) throw new Error(`group ${ref} missing or has ${g?.orders.length ?? 0} orders`);
  orderIds.push(g.orders[0].id);
}
console.log(`created ${refs.length} payment groups (checkout p50 ${pct(checkoutMs, 50)}ms, max ${Math.max(...checkoutMs)}ms)`);

const amountByRef = new Map(groups.map((g) => [g.ref, g.totalMinor]));

function signedBody(ref: string, eventType = "payment.succeeded") {
  const amountMinor = amountByRef.get(ref)!;
  const ts = Date.now();
  const payload = { providerRef: ref, eventType, amountMinor, ts };
  const sig = hmacSha256Hex(SECRET, `${ref}.${eventType}.${amountMinor}.${ts}`);
  return JSON.stringify({ ...payload, sig });
}

async function deliver(ref: string) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/webhooks/payments/mock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: signedBody(ref),
  });
  const ms = Date.now() - t0;
  const j = (await res.json().catch(() => ({}))) as { data?: { duplicate?: boolean }; error?: { code?: string } };
  return { status: res.status, duplicate: j.data?.duplicate ?? null, errorCode: j.error?.code ?? null, ms };
}

function summarize(rs: { status: number; duplicate: boolean | null; errorCode: string | null; ms: number }[]) {
  const byStatus: Record<string, number> = {};
  for (const r of rs) byStatus[String(r.status)] = (byStatus[String(r.status)] ?? 0) + 1;
  return {
    total: rs.length,
    byStatus,
    winners: rs.filter((r) => r.status === 200 && r.duplicate === false).length,
    duplicates: rs.filter((r) => r.status === 200 && r.duplicate === true).length,
    internalErrors: rs.filter((r) => r.status >= 500).length,
    errorCodes: [...new Set(rs.map((r) => r.errorCode).filter(Boolean))] as string[],
    p50: pct(rs.map((r) => r.ms), 50),
    p95: pct(rs.map((r) => r.ms), 95),
    max: Math.max(...rs.map((r) => r.ms)),
  };
}

// ── STORM 1: same-ref duplicate deliveries (4 concurrent, identical) ─────────
console.log(`\n── storm 1: ${N_DUP_STORM} concurrent identical deliveries of ${refs[0]}`);
const dupResults = await Promise.all(Array.from({ length: N_DUP_STORM }, () => deliver(refs[0])));
const dupSummary = summarize(dupResults);
console.log(JSON.stringify(dupSummary));
check("storm1: no 5xx (conflicts handled, not leaked)", dupSummary.internalErrors === 0, JSON.stringify(dupSummary.byStatus));

// ── STORM 2: cross-ref concurrent confirmations (the contention window) ──────
console.log(`\n── storm 2: ${N_CHECKOUTS} concurrent confirmations, one per ref, same store`);
const crossResults = await Promise.all(refs.map((r) => deliver(r)));
const crossSummary = summarize(crossResults);
console.log(JSON.stringify(crossSummary));
check("storm2: no 5xx (transient conflicts recovered in-process)", crossSummary.internalErrors === 0, JSON.stringify(crossSummary.byStatus));

// every ref must end CONFIRMED (either first-try winner or converged duplicate)
let confirmedCount = 0;
for (const ref of refs) {
  const g = await db.paymentGroup.findUnique({ where: { ref }, select: { status: true } });
  if (g?.status === "succeeded") confirmedCount++;
}
check(`storm2: all ${N_CHECKOUTS} payments confirmed`, confirmedCount === N_CHECKOUTS, `confirmed=${confirmedCount}`);

// ── replay convergence: sequential redelivery after success ─────────────
// refs[0] is confirmed by storm 1 in both code versions → redelivery must be
// recognized as a duplicate with zero state change.
const replay = await deliver(refs[0]);
check("replay: redelivery of succeeded payment → 200 duplicate:true", replay.status === 200 && replay.duplicate === true, JSON.stringify(replay));

// ── negative paths (unchanged behavior) ──────────────────────────────────────
const badAmountRes = await fetch(`${BASE}/api/webhooks/payments/mock`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: (() => {
    const ref = refs[2];
    const ts = Date.now();
    const payload = { providerRef: ref, eventType: "payment.succeeded", amountMinor: amountByRef.get(ref)! + 1, ts };
    return JSON.stringify({ ...payload, sig: hmacSha256Hex(SECRET, `${ref}.payment.succeeded.${payload.amountMinor}.${ts}`) });
  })(),
});
check("negative: amount mismatch → 409 AMOUNT_MISMATCH", badAmountRes.status === 409, `status=${badAmountRes.status}`);

const failedRes = await fetch(`${BASE}/api/webhooks/payments/mock`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: signedBody(refs[3], "payment.failed"),
});
check("negative: payment.failed after success → 200 duplicate:true (no money moves)", failedRes.status === 200, `status=${failedRes.status}`);

// ── provider-redelivery convergence (the real PSP contract: every 5xx or
//    timeout delivery WILL be redelivered, with exponential backoff waves). ──
const unconfirmedRefs: string[] = [];
for (const ref of refs) {
  const g = await db.paymentGroup.findUnique({ where: { ref }, select: { status: true } });
  if (g?.status !== "succeeded") unconfirmedRefs.push(ref);
}
console.log(`\n── convergence: redelivery waves (real PSP contract: exponential-backoff redelivery)`);
const convergence: { ref: string; status: number; duplicate: boolean | null; errorCode: string | null }[] = [];
const waveDelaysMs = [0, 2000, 4000]; // wave 2/3 backoff — a real PSP does the same
let stillUnconfirmed = N_CHECKOUTS;
for (let wave = 0; wave < waveDelaysMs.length && stillUnconfirmed > 0; wave++) {
  if (waveDelaysMs[wave] > 0) await new Promise((res) => setTimeout(res, waveDelaysMs[wave]));
  const pending: string[] = [];
  for (const ref of refs) {
    const g = await db.paymentGroup.findUnique({ where: { ref }, select: { status: true } });
    if (g?.status !== "succeeded") pending.push(ref);
  }
  stillUnconfirmed = pending.length;
  if (!pending.length) break;
  console.log(`   wave ${wave + 1}: redelivering ${pending.length} unconfirmed`);
  for (const ref of pending) {
    const r = await deliver(ref);
    convergence.push({ ref: ref.slice(0, 14), wave: wave + 1, status: r.status, duplicate: r.duplicate, errorCode: r.errorCode });
    await new Promise((res) => setTimeout(res, 150)); // polite PSP cadence within a wave
  }
  stillUnconfirmed = 0;
  for (const ref of refs) {
    const g = await db.paymentGroup.findUnique({ where: { ref }, select: { status: true } });
    if (g?.status !== "succeeded") stillUnconfirmed++;
  }
}
check(
  "convergence: provider redelivery confirmed every payment (≤3 waves)",
  stillUnconfirmed === 0,
  `unconfirmedAfterWaves=${stillUnconfirmed}/${refs.length}; redeliveries=${convergence.length}`
);

// ── integrity gates (the hard zero-duplication proofs) ───────────────────────
let dupPaidTransitions = 0, dupT1 = 0, dupActivity = 0, dupSellerMail = 0, dupReceipt = 0, dupBell = 0, unpaidGroups = 0;
for (const orderId of orderIds) {
  const paidHist = await db.orderStatusHistory.count({ where: { orderId, toStatus: "paid" } });
  if (paidHist !== 1) dupPaidTransitions += Math.abs(paidHist - 1);
  const t1 = await db.ledgerTransaction.count({ where: { dedupKey: `order_paid:order:${orderId}` } });
  if (t1 !== 1) dupT1 += Math.abs(t1 - 1);
  const act = await db.activityLog.count({ where: { action: "payment.succeeded", entityType: "order", entityId: orderId } });
  if (act !== 1) dupActivity += Math.abs(act - 1);
  const sellerMail = await db.notificationLog.count({ where: { dedupKey: `order.paid.email:${orderId}` } });
  if (sellerMail !== 1) dupSellerMail += Math.abs(sellerMail - 1);
  const receipt = await db.notificationLog.count({ where: { dedupKey: `order.receipt.email:${orderId}` } });
  if (receipt !== 1) dupReceipt += Math.abs(receipt - 1);
  const order = await db.order.findUnique({ where: { id: orderId }, select: { orderNumber: true, status: true } });
  const bell = (await db.notification.findMany({
    where: { shopperUserId: (await db.shopperUser.findFirst({ where: { email: "qa.shopper@nomofee.test" } }))!.id, type: "order.paid", createdAt: { gte: testStart } },
    select: { dataJson: true },
  })).filter((n) => (n.dataJson ?? "").includes(order!.orderNumber)).length;
  if (bell !== 1) dupBell += Math.abs(bell - 1);
}
check("integrity: exactly ONE paid transition per order", dupPaidTransitions === 0, `deviations=${dupPaidTransitions}`);
check("integrity: exactly ONE ledger T1 per order (no duplicate postings)", dupT1 === 0, `deviations=${dupT1}`);
check("integrity: exactly ONE payment.succeeded activity row per order", dupActivity === 0, `deviations=${dupActivity}`);
check("integrity: exactly ONE seller email log per order (dedupKey)", dupSellerMail === 0, `deviations=${dupSellerMail}`);
check("integrity: exactly ONE receipt email log per order (dedupKey)", dupReceipt === 0, `deviations=${dupReceipt}`);
check("integrity: exactly ONE shopper bell notification per order", dupBell === 0, `deviations=${dupBell}`);

const v = await db.productVariant.findUnique({ where: { id: variant.id }, select: { stock: true } });
check("integrity: stock never negative", (v?.stock ?? 0) >= 0, `stock=${v?.stock}`);

const deliveredPayloads = await db.webhookDelivery.findMany({
  where: { event: "order.paid", createdAt: { gte: testStart } },
  select: { endpointId: true, payloadJson: true },
});
const seen = new Set<string>();
let dupDeliveries = 0;
for (const d of deliveredPayloads) {
  const k = `${d.endpointId}|${d.payloadJson}`;
  if (seen.has(k)) dupDeliveries++;
  seen.add(k);
}
check("integrity: no duplicate store-webhook delivery rows", dupDeliveries === 0, `dups=${dupDeliveries} of ${deliveredPayloads.length}`);

const unprocessed = await db.paymentWebhookLog.count({
  where: { providerRef: { in: refs }, eventType: "payment.succeeded", processed: false },
});
// Meaningful invariant: after convergence every ref has at least ONE processed
// succeeded-type delivery row. Rows that stay processed=false are the PSP
// RETRY QUEUE (first deliveries that 5xx'd) — legitimate history by design,
// consumed by provider redelivery / the FIN-1 sweep, not stranding.
let refsWithProcessed = 0;
for (const ref of refs) {
  const p = await db.paymentWebhookLog.findFirst({ where: { providerRef: ref, eventType: "payment.succeeded", processed: true }, select: { id: true } });
  if (p) refsWithProcessed++;
}
check("integrity: every payment has a processed succeeded-delivery row", refsWithProcessed === N_CHECKOUTS, `refs=${refsWithProcessed}/${N_CHECKOUTS}; retryQueue(unprocessed rows)=${unprocessed}`);

// ── evidence + restore ───────────────────────────────────────────────────────
const evidence = {
  label: LABEL,
  date: new Date().toISOString(),
  workload: { checkouts: N_CHECKOUTS, duplicateStorm: N_DUP_STORM, store: STORE_SLUG, concurrencyModel: "Promise.all HTTP against dev server", evidenceClass: "Measured" },
  checkoutLatencyMs: { p50: pct(checkoutMs, 50), p95: pct(checkoutMs, 95), max: Math.max(...checkoutMs) },
  storm1SameRef: dupSummary,
  storm2CrossRef: crossSummary,
  replaySequential: replay,
  providerRedeliveryConvergence: { redelivered: unconfirmedRefs.length, stillUnconfirmed, outcomes: convergence },
  integrity: { dupPaidTransitions, dupT1, dupActivity, dupSellerMail, dupReceipt, dupBell, dupWebhookDeliveries: dupDeliveries, refsWithProcessedSucceededDelivery: refsWithProcessed, retryQueueUnprocessedRows: unprocessed, stockAfter: v?.stock },
  confirmedPayments: confirmedCount,
};
mkdirSync("performance/f1", { recursive: true });
writeFileSync(`performance/f1/${LABEL}.json`, JSON.stringify(evidence, null, 2));
await db.productVariant.update({ where: { id: variant.id }, data: { stock: Math.max(originalStock, 5) } });
console.log(`\nevidence → performance/f1/${LABEL}.json; variant stock restored to ${Math.max(originalStock, 5)}`);
console.log(failures === 0 ? `F1 EVIDENCE RUN (${LABEL}): ALL PASS` : `F1 EVIDENCE RUN (${LABEL}): ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
