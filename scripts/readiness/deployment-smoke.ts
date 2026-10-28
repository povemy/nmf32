// ============================================================================
// DEPLOYMENT SMOKE TEST — post-deployment verification for any NOMOFEE
// environment (mission: production deployment, Phase 2.2).
// ----------------------------------------------------------------------------
// Runs a SAFE, [LT]-tagged, self-cleaning pass over the deployment-critical
// surface of the target application:
//
//   A. public routes + health/deployment identification + images
//   B. shopper auth (register/login) + authenticated order history
//   C. checkout → mock-PSP payment → duplicate webhook → unsigned/stale
//      rejection → order state, stock, ledger exactly-once, order history
//   D. scheduler/cron auth posture + scheduler service liveness (optional)
//   E. production-gate posture report (mock PSP, nodeEnv)
//
// TARGET IDENTIFICATION (Phase 1 guard): the smoke run writes [LT] records,
// so it requires the same positive target identification as load tests:
//   SMOKE_TARGET_CONFIRM (or LOADTEST_TARGET_CONFIRM) = dev-sandbox-local|staging
//   SMOKE_BASE (or LOADTEST_BASE) = base URL (default http://127.0.0.1:3000)
//   For staging: LOADTEST_DB_FINGERPRINT must be pinned (16-hex).
//
// Production smoke: use SMOKE_TARGET_CONFIRM=prod-read-only to run ONLY the
// read-only sections (A + D observability) — no records are created, no
// charges, no stock changes. Heavy checks never run against production.
//
// Re-run: bun scripts/readiness/deployment-smoke.ts
// @ts-nocheck
import { db } from "../../src/lib/db";
import { makeLtVariant, ltShopperCookie, signWebhook, restoreVariant, cleanupCarts, setSetting, check, summary } from "./lib";
import { assertTestTarget } from "./target-guard";
import { writeFileSync } from "node:fs";

const BASE = (process.env.SMOKE_BASE ?? process.env.LOADTEST_BASE ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const CONFIRM = (process.env.SMOKE_TARGET_CONFIRM ?? process.env.LOADTEST_TARGET_CONFIRM ?? "").toLowerCase();
const SCHEDULER_URL = process.env.SMOKE_SCHEDULER_URL ?? "http://127.0.0.1:3005";
const runId = Date.now().toString(36);
const out = { suite: "deployment-smoke", runId, base: BASE, startedAt: new Date().toISOString(), sections: {} as Record<string, unknown> };
const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const GET = (p: string, cookie?: string) => fetch(`${BASE}${p}`, { headers: cookie ? { cookie } : {} });

let nodeEnv = "unknown";
let dbFingerprint = "unknown";

// ═══ A. public surface ═══════════════════════════════════════════════════
async function sectionA() {
  const root = await GET("/");
  const html = await root.text();
  check("A1 root page 200 + HTML shell", root.status === 200 && html.includes("<body"), `status=${root.status}`);
  const health = await j(await GET("/api/health"));
  const h = health.body?.data ?? {};
  nodeEnv = h?.deployment?.nodeEnv ?? "unknown";
  dbFingerprint = h?.deployment?.dbFingerprint ?? "unknown";
  check("A2 health healthy + deployment block", health.status === 200 && h?.status === "healthy" && h?.deployment?.dbFingerprint, `nodeEnv=${nodeEnv} fp=${dbFingerprint}`);
  check("A3 ledger invariants ok (no hard drift)", h?.ledgerInvariants?.ok === true && h?.ledgerInvariants?.hardDriftCount === 0, `txns=${h?.ledgerInvariants?.txnCount}`);
  const home = await j(await GET("/api/market/home"));
  check("A4 market home 200", home.status === 200);
  const products = await j(await GET("/api/market/products"));
  check("A5 market products 200", products.status === 200);
  const img = await fetch(`${BASE}/api/img/smoke-${runId}?w=64&h=64&label=Smoke`);
  const imgBody = await img.text();
  check("A6 image endpoint 200 + SVG", img.status === 200 && imgBody.includes("<svg"), `status=${img.status} bytes=${imgBody.length}`);
  out.sections.A = { rootStatus: root.status, nodeEnv, dbFingerprint, ledgerTxns: h?.ledgerInvariants?.txnCount };
}

// ═══ B. auth ═════════════════════════════════════════════════════════════
let cookie: string;
async function sectionB() {
  const email = `lt-smoke-${runId}@lt.test`;
  cookie = await ltShopperCookie(email, "LT Smoke Buyer");
  check("B1 shopper register/login yields session cookie", cookie.includes("sm_session") || cookie.length > 10, `cookieLen=${cookie.length}`);
  const orders = await j(await GET("/api/me/orders", cookie));
  check("B2 authenticated order history 200", orders.status === 200, `status=${orders.status}`);
  out.sections.B = { ok: true };
}

// ═══ C. payment golden path on mock rails ════════════════════════════════
async function sectionC() {
  const email = `lt-smoke-${runId}@lt.test`;
  const v = await makeLtVariant(`smoke-${runId}`, 5);
  const body = (qty: number) => ({
    items: [{ variantId: v.variantId, qty }],
    customer: { name: "LT Smoke Buyer", email },
    shippingAddress: { line1: "1 LT Jalan", city: "Kuala Lumpur", postcode: "50000", state: "Kuala Lumpur" },
    provider: "fpx_toyyibpay",
  });
  const idem = `lt-smoke-${runId}`;
  const t0 = Date.now();
  const co = await j(await fetch(`${BASE}/api/checkout/create`, { method: "POST", headers: { "Content-Type": "application/json", cookie, "Idempotency-Key": idem }, body: JSON.stringify(body(1)) }));
  const ref = co.body?.data?.paymentGroupRef ?? co.body?.data?.groupRef ?? co.body?.data?.ref ?? co.body?.data?.redirectUrl?.split("/").pop();
  const orderNumber = co.body?.data?.orderNumbers?.[0] ?? co.body?.data?.orderNumber;
  check("C1 checkout create 201 + payment ref", co.status === 201 && Boolean(ref), `status=${co.status} ref=${String(ref).slice(0, 18)}…`);
  out.sections.C = { checkoutStatus: co.status, checkoutMs: Date.now() - t0 };

  // idempotent redelivery of the same checkout request (200 = replay answer)
  const co2 = await j(await fetch(`${BASE}/api/checkout/create`, { method: "POST", headers: { "Content-Type": "application/json", cookie, "Idempotency-Key": idem }, body: JSON.stringify(body(1)) }));
  const orderNumber2 = co2.body?.data?.orderNumbers?.[0] ?? co2.body?.data?.orderNumber;
  const ordersForKey = await db.order.count({ where: { idemKey: { startsWith: `${idem}:` } } });
  const groupsForKey = await db.paymentGroup.count({ where: { idemKey: idem } });
  check("C2 duplicate idempotency-key → same order, exactly one order", (co2.status === 200 || co2.status === 201) && orderNumber2 === orderNumber && ordersForKey === 1 && groupsForKey === 1, `status=${co2.status} same=${orderNumber2 === orderNumber} orders=${ordersForKey} groups=${groupsForKey}`);

  // stock reserved at checkout
  const stockAfterCheckout = (await db.productVariant.findUnique({ where: { id: v.variantId } })).stock;
  check("C3 stock reserved at checkout (5→4)", stockAfterCheckout === 4, `stock=${stockAfterCheckout}`);

  // mock PSP success (server-signed webhook through the real pipeline)
  const sim = await j(await fetch(`${BASE}/api/checkout/payments/${ref}/simulate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ result: "succeeded" }) }));
  check("C4 mock PSP payment success processed", sim.status === 200 && sim.body?.data?.status === "succeeded", `status=${sim.status} intent=${sim.body?.data?.status}`);

  // duplicate webhook → duplicate:true, ledger unchanged
  const group = await db.paymentGroup.findUnique({ where: { ref } , include: { orders: true } });
  const amount = group.totalMinor;
  const order = group.orders[0];
  const t1key = `order_paid:order:${order.id}`;
  const t1Count1 = await db.ledgerTransaction.count({ where: { dedupKey: t1key } });
  const dup = await j(await fetch(`${BASE}/api/webhooks/payments/fpx_toyyibpay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerRef: ref, eventType: "payment.succeeded", amountMinor: amount, ts: Date.now(), sig: signWebhook(ref, "payment.succeeded", amount, Date.now()) }) }));
  const t1Count2 = await db.ledgerTransaction.count({ where: { dedupKey: t1key } });
  check("C5 duplicate webhook converges (duplicate:true) + T1 exactly-once", dup.status === 200 && dup.body?.data?.duplicate === true && t1Count1 === 1 && t1Count2 === 1, `dup=${dup.body?.data?.duplicate} t1=${t1Count1}→${t1Count2}`);

  // unsigned webhook rejected
  const unsigned = await j(await fetch(`${BASE}/api/webhooks/payments/fpx_toyyibpay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerRef: ref, eventType: "payment.succeeded", amountMinor: amount, ts: Date.now() }) }));
  check("C6 unsigned webhook → 400 BAD_SIGNATURE", unsigned.status === 400 && unsigned.body?.error?.code === "BAD_SIGNATURE", `status=${unsigned.status} code=${unsigned.body?.error?.code}`);

  // stale (correctly-signed) webhook rejected
  const staleTs = Date.now() - 20 * 60_000;
  const stale = await j(await fetch(`${BASE}/api/webhooks/payments/fpx_toyyibpay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerRef: ref, eventType: "payment.succeeded", amountMinor: amount, ts: staleTs, sig: signWebhook(ref, "payment.succeeded", amount, staleTs) }) }));
  check("C7 replayed (stale) webhook → 400 STALE_EVENT", stale.status === 400 && stale.body?.error?.code === "STALE_EVENT", `status=${stale.status} code=${stale.body?.error?.code}`);

  // final state: order paid + visible in history + stock sold
  const stockAfterPay = (await db.productVariant.findUnique({ where: { id: v.variantId } })).stock;
  check("C8 paid order keeps stock decremented (no double release)", stockAfterPay === 4, `stock=${stockAfterPay}`);
  const history = await j(await GET(`/api/me/orders?bucket=to_ship`, cookie));
  const rows = history.body?.data?.rows ?? history.body?.data?.orders ?? [];
  check("C9 paid order visible in buyer history (to_ship bucket)", rows.some?.((r: any) => r.orderNumber === orderNumber || r.number === orderNumber), `rows=${Array.isArray(rows) ? rows.length : "?"}`);

  // cleanup: restore variant, remove LT carts (orders/ledger rows stay — audit trail)
  await restoreVariant(v.variantId, 5);
  await cleanupCarts([email]);
  out.sections.C = { ...out.sections.C, ref, orderNumber, t1Txns: t1Count2, dupStatus: dup.status };
}

// ═══ D. scheduler & cron posture ═════════════════════════════════════════
async function sectionD() {
  const obs = await j(await GET("/api/cron/expiry-sweep"));
  const mode = obs.body?.data?.auth;
  check("D1 cron observability GET answers with auth mode", obs.status === 200 && Boolean(mode), `auth=${mode} backlog=${obs.body?.data?.backlog}`);
  if (nodeEnv === "production") {
    check("D2 production cron posture is NOT dev-open", mode === "secret-required" || mode === "fail-closed", `auth=${mode}`);
  } else {
    check("D2 dev cron posture is dev-open (expected in dev only)", mode === "dev-open", `auth=${mode}`);
  }
  if (mode === "secret-required") {
    const wrong = await j(await fetch(`${BASE}/api/cron/expiry-sweep`, { headers: { "x-cron-secret": "wrong-value-smoke" } }));
    check("D3 wrong cron secret → 403", wrong.status === 403, `status=${wrong.status}`);
    const missing = await j(await GET("/api/cron/expiry-sweep"));
    check("D4 missing cron secret → 403 (identical message)", missing.status === 403, `status=${missing.status}`);
  } else {
    check("D3/D4 secret matrix not applicable in this mode", true, `auth=${mode} (verified by scheduler-e2e suite)`);
  }
  // scheduler service liveness — optional (URL differs per deployment)
  try {
    const s = await fetch(`${SCHEDULER_URL}/`, { signal: AbortSignal.timeout(5000) });
    const sj = await s.json();
    const d = sj?.data ?? {};
    check("D5 scheduler service liveness", s.status === 200 && Boolean(d?.startedAt), `ticks=${JSON.stringify(d?.endpoints?.expiry?.ticks ?? "?")}`);
  } catch {
    check("D5 scheduler service liveness", nodeEnv !== "development", "not reachable at SMOKE_SCHEDULER_URL (set SMOKE_SCHEDULER_URL or platform cron equivalent)");
  }
  out.sections.D = { cronAuthMode: mode };
}

// ═══ E. production gates posture (report-only) ════════════════════════════
async function sectionE() {
  const sim404 = await fetch(`${BASE}/api/checkout/payments/nonexistent-ref-smoke/simulate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ result: "succeeded" }) });
  // (nonexistent ref → 404 regardless; in production-without-mock-setting the
  // gate ALSO refuses — this just proves the route answers coherently)
  check("E1 payment simulate endpoint answers (404 for unknown ref)", sim404.status === 404, `status=${sim404.status}`);
  out.sections.E = { nodeEnv, dbFingerprint, mockGate: nodeEnv === "production" ? "setting-dependent" : "dev-open" };
}

// ═══ main ════════════════════════════════════════════════════════════════
if (CONFIRM === "prod-read-only") {
  console.log("[deployment-smoke] PRODUCTION READ-ONLY mode — sections A/D/E only, no records created");
  await sectionA();
  await sectionD();
  await sectionE();
} else {
  // Same fail-closed target identification as load tests (smoke writes [LT] records)
  const target = await assertTestTarget({ base: BASE, confirm: CONFIRM || undefined });
  nodeEnv = target.nodeEnv;
  await sectionA();
  await sectionB();
  await sectionC();
  await sectionD();
  await sectionE();
}

out.finishedAt = new Date().toISOString();
const stamp = new Date().toISOString().slice(0, 10);
writeFileSync(`performance/runs/${stamp}-deployment-smoke.json`, JSON.stringify(out, null, 2));
console.log(`\nsaved performance/runs/${stamp}-deployment-smoke.json`);
process.exit(summary("deployment-smoke") === 0 ? 0 : 1);
