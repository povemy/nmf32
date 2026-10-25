// RX-PRV Phase 4 — bounded load scenarios (dev-mode, combined environment).
// Scenarios: baseline | ramp | rush | webstorm | idem | recovery
// Every number is client-observed from the same box the app runs on
// (COMBINED ENVIRONMENT — see REPORT.md §5 caveats). Data tagged [LT].
// @ts-nocheck
import { db } from "../../src/lib/db";
import { BASE, LT, makeLtVariant, ltShopperCookie, checkout, sendWebhook, restoreVariant, cleanupCarts, pgClient, percentile } from "./lib";
import { writeFileSync } from "node:fs";

const scenario = process.argv[2] ?? "baseline";
const runId = Date.now().toString(36);
const buyerEmail = (i: number) => `lt-load-${runId}-${i}@lt.test`;

// ── buyer pool ───────────────────────────────────────────────────────────────
async function ensureBuyers(n: number, conc = 10): Promise<string[]> {
  const cookies: string[] = [];
  for (let i = 0; i < n; i += conc) {
    const batch = Array.from({ length: Math.min(conc, n - i) }, (_, k) => i + k);
    const got = await Promise.all(batch.map((i) => ltShopperCookie(buyerEmail(i), "LT Load Buyer")));
    cookies.push(...got);
  }
  return cookies;
}

// ── server-side connection sampler (Phase 3 evidence) ───────────────────────
async function makeSampler(intervalMs = 500) {
  const pg = await pgClient();
  const maxConn = Number((await pg.query("SHOW max_connections")).rows[0].max_connections);
  const snaps: { t: number; active: number; idle: number; total: number; inTx: number }[] = [];
  let stopped = false;
  const tick = async () => {
    while (!stopped) {
      try {
        const r = await pg.query(
          `SELECT count(*) FILTER (WHERE state='active')::int AS active,
                  count(*) FILTER (WHERE state='idle')::int AS idle,
                  count(*) FILTER (WHERE state='idle in transaction')::int AS in_tx,
                  count(*)::int AS total
           FROM pg_stat_activity WHERE datname = current_database() AND backend_type='client backend'`
        );
        snaps.push({ t: Date.now(), active: r.rows[0].active, idle: r.rows[0].idle, total: r.rows[0].total, inTx: r.rows[0].in_tx });
      } catch { /* sampler must never break the run */ }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  tick();
  return {
    stop: async () => { stopped = true; await pg.end(); },
    maxConn,
    summarize() {
      const maxTotal = Math.max(0, ...snaps.map((s) => s.total));
      const maxActive = Math.max(0, ...snaps.map((s) => s.active));
      const maxInTx = Math.max(0, ...snaps.map((s) => s.inTx));
      return { maxServerSessions: maxTotal, maxActiveQueries: maxActive, maxIdleInTx: maxInTx, samples: snaps.length };
    },
  };
}

function summarizeLatency(xs: number[]) {
  if (!xs.length) return { n: 0 };
  const mean = Math.round(xs.reduce((s, x) => s + x, 0) / xs.length);
  return { n: xs.length, min: Math.min(...xs), p50: percentile(xs, 50), p95: percentile(xs, 95), p99: percentile(xs, 99), max: Math.max(...xs), mean };
}

function statusCounts(statuses: number[]) {
  const m: Record<number, number> = {};
  for (const s of statuses) m[s] = (m[s] ?? 0) + 1;
  return m;
}

const CHECKOUT_BODY = (variantId: string, qty: number, email: string) => ({
  items: [{ variantId, qty }],
  customer: { name: "LT Load Buyer", email },
  shippingAddress: { line1: "1 LT Jalan", city: "Kuala Lumpur", postcode: "50000", state: "Kuala Lumpur" },
  provider: "fpx_toyyibpay",
});

async function fireCheckout(cookie: string, variantId: string, idemKey: string, email: string, qty = 1) {
  const t0 = performance.now();
  let status = 0; let body: any = {};
  try {
    const r = await fetch(`${BASE}/api/checkout/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie, "Idempotency-Key": idemKey },
      body: JSON.stringify(CHECKOUT_BODY(variantId, qty, email)),
    });
    status = r.status;
    body = await r.json().catch(() => ({}));
  } catch (e: any) {
    status = -1; body = { error: String(e?.message ?? e) };
  }
  return { ms: Math.round(performance.now() - t0), status, code: body?.error?.code ?? null };
}

const out: any = { scenario, runId, startedAt: new Date().toISOString(), env: { mode: "next-dev(turbopack)", generator: "same-box", db: "supabase-session-pooler" } };

// ═══ baseline ═════════════════════════════════════════════════════════════
if (scenario === "baseline") {
  const v = await makeLtVariant(`base-${runId}`, 10_000);
  const cookie = (await ensureBuyers(1))[0];
  console.log("warmup (3 unmeasured)…");
  for (let i = 0; i < 3; i++) await fireCheckout(cookie, v.variantId, `warm-${runId}-${i}`, buyerEmail(0));
  console.log("baseline: 20 sequential checkouts, 1 buyer");
  const sampler = await makeSampler();
  const lat: number[] = []; const statuses: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) {
    const r = await fireCheckout(cookie, v.variantId, `bl-${runId}-${i}`, buyerEmail(0));
    lat.push(r.ms); statuses.push(r.status);
    process.stdout.write(`${r.status}/${r.ms}ms  `);
  }
  const wallMs = Math.round(performance.now() - t0);
  await sampler.stop();
  out.results = { latency: summarizeLatency(lat), statuses: statusCounts(statuses), wallMs, checkoutsPerMin: Math.round((20 / wallMs) * 60000), connections: sampler.summarize() };
  await restoreVariant(v.variantId, 10_000); await cleanupCarts([buyerEmail(0)]);
}

// ═══ ramp ═════════════════════════════════════════════════════════════════
if (scenario === "ramp") {
  const v = await makeLtVariant(`ramp-${runId}`, 10_000);
  const levels = [5, 10, 20, 40];
  const cookies = await ensureBuyers(40);
  const cookie = cookies[0];
  console.log("warmup…");
  for (let i = 0; i < 3; i++) await fireCheckout(cookie, v.variantId, `warm-${runId}-${i}`, buyerEmail(0));
  const sampler = await makeSampler();
  out.levels = [];
  for (const c of levels) {
    const buyers = cookies.slice(0, c);
    const t0 = performance.now();
    const rs = await Promise.all(buyers.map((ck, i) => fireCheckout(ck, v.variantId, `rp-${runId}-${c}-${i}`, buyerEmail(i))));
    const wallMs = Math.round(performance.now() - t0);
    const level = { concurrency: c, latency: summarizeLatency(rs.map((r) => r.ms)), statuses: statusCounts(rs.map((r) => r.status)), wallMs, checkoutsPerMin: Math.round((rs.length / wallMs) * 60000) };
    console.log(`\nlevel c=${c}:`, JSON.stringify(level));
    out.levels.push(level);
    await new Promise((r) => setTimeout(r, 3000)); // cool-down between levels
  }
  await sampler.stop();
  out.connections = sampler.summarize();
  await restoreVariant(v.variantId, 10_000); await cleanupCarts(cookies.map((_, i) => buyerEmail(i)));
}

// ═══ rush — THE 100-BUYER LAUNCH-RUSH WORKLOAD ════════════════════════════
if (scenario === "rush") {
  const STOCK = 60;
  const v = await makeLtVariant(`rush-${runId}`, STOCK);
  console.log("registering 100 buyers…");
  const cookies = await ensureBuyers(100);
  console.log("warmup (1 unmeasured, separate variant)…");
  const wv = await makeLtVariant(`rushwarm-${runId}`, 50);
  await fireCheckout(cookies[0], wv.variantId, `rwarm-${runId}`, buyerEmail(0));
  await restoreVariant(wv.variantId, 50);
  console.log(`RUSH: 100 simultaneous checkouts, stock=${STOCK}`);
  const sampler = await makeSampler(250);
  const t0 = performance.now();
  const rs = await Promise.all(cookies.map((ck, i) => fireCheckout(ck, v.variantId, `rush-${runId}-${i}`, buyerEmail(i))));
  const wallMs = Math.round(performance.now() - t0);
  const conn = sampler.summarize(); await sampler.stop();
  // correctness
  const stockAfter = (await db.productVariant.findUnique({ where: { id: v.variantId } }))!.stock;
  const grpRefs = rs.filter((r) => r.status === 201);
  const orders = await db.order.count({ where: { idemKey: { startsWith: `rush-${runId}` } } });
  const invLogs = await db.inventoryLog.count({ where: { variantId: v.variantId } });
  const sumQty = await db.orderItem.aggregate({ where: { variantId: v.variantId }, _sum: { qty: true } });
  const codes: Record<string, number> = {};
  rs.forEach((r) => { if (r.code) codes[r.code] = (codes[r.code] ?? 0) + 1; });
  out.results = {
    latency: summarizeLatency(rs.map((r) => r.ms)),
    statuses: statusCounts(rs.map((r) => r.status)), errorCodes: codes,
    wallMs, attemptsPerSec: Math.round((rs.length / wallMs) * 1000 * 10) / 10,
    completedOrders: orders, ordersPerMin: Math.round((orders / wallMs) * 60000),
    correctness: {
      stockBefore: STOCK, stockAfter, stockNeverNegative: stockAfter >= 0,
      stockEqualsZeroAfterSellout: stockAfter === 0,
      ordersCreated: orders, inventoryLogs: invLogs, orderItemQtySum: Number(sumQty._sum.qty ?? 0),
      oversell: orders > STOCK,
    },
    connections: conn,
  };
  console.log(JSON.stringify(out.results, null, 2));
  await cleanupCarts(cookies.map((_, i) => buyerEmail(i)));
  // stock intentionally left at 0 (sold out) — artifact is the rush record itself
}

// ═══ webstorm — webhook processing under concurrent load ══════════════════
if (scenario === "webstorm") {
  const N = 15; // 15 unique + 15 duplicates = 30 webhook calls < 60/min IP limit
  const v = await makeLtVariant(`storm-${runId}`, 10_000);
  const cookie = (await ensureBuyers(1))[0];
  console.log(`creating ${N} paid-able groups…`);
  const groups: { ref: string; total: number; orderId: string }[] = [];
  for (let i = 0; i < N; i++) {
    const r = await fireCheckout(cookie, v.variantId, `st-${runId}-${i}`, buyerEmail(0));
    if (r.status !== 201) { console.log("setup checkout failed", r.status); process.exit(2); }
  }
  const pgRows = await db.paymentGroup.findMany({ where: { idemKey: { startsWith: `st-${runId}-` } }, include: { orders: true } });
  pgRows.forEach((g) => groups.push({ ref: g.ref, total: g.totalMinor, orderId: g.orders[0].id }));
  const wallet = (await db.store.findUnique({ where: { slug: "bytebazaar" }, include: { seller: { include: { wallet: true } } } }))!.seller!.wallet;
  const preLedger = await db.ledgerTransaction.count();
  console.log(`WEBSTORM: ${N} unique + ${N} duplicate webhooks concurrently`);
  const sampler = await makeSampler(250);
  const t0 = performance.now();
  const [uniq, dups] = await Promise.all([
    Promise.all(groups.map((g) => timedHook(g))),
    Promise.all(groups.map((g) => timedHook(g))),
  ]);
  const wallMs = Math.round(performance.now() - t0);
  const conn = sampler.summarize(); await sampler.stop();
  const all = [...uniq, ...dups];
  const t1 = await db.ledgerTransaction.count();
  const t1New = t1 - preLedger;
  out.results = {
    latencyUnique: summarizeLatency(uniq.map((r) => r.ms)), latencyDuplicates: summarizeLatency(dups.map((r) => r.ms)),
    statusesUnique: statusCounts(uniq.map((r) => r.status)), statusesDuplicates: statusCounts(dups.map((r) => r.status)),
    wallMs, webhooksPerMin: Math.round((all.length / wallMs) * 60000),
    correctness: { newT1Postings: t1New, expectedT1Postings: N, exactlyOnce: t1New === N },
    connections: conn,
  };
  console.log(JSON.stringify(out.results, null, 2));
  async function timedHook(g: { ref: string; total: number }) {
    const t0 = performance.now();
    let status = 0;
    try { status = (await sendWebhook(g.ref, "payment.succeeded", g.total)).status; } catch { status = -1; }
    return { ms: Math.round(performance.now() - t0), status };
  }
  await restoreVariant(v.variantId, 10_000); await cleanupCarts([buyerEmail(0)]);
}

// ═══ idem — same Idempotency-Key fired concurrently ═══════════════════════
if (scenario === "idem") {
  const v = await makeLtVariant(`idem-${runId}`, 100);
  const cookie = (await ensureBuyers(1))[0];
  const KEY = `idem-storm-${runId}`;
  console.log("IDEM: 12 concurrent checkouts sharing ONE Idempotency-Key");
  const sampler = await makeSampler(250);
  const rs = await Promise.all(Array.from({ length: 12 }, () => fireCheckout(cookie, v.variantId, KEY, buyerEmail(0))));
  const conn = sampler.summarize(); await sampler.stop();
  const orders = await db.order.count({ where: { idemKey: { startsWith: KEY } } });
  const groups = await db.paymentGroup.count({ where: { idemKey: KEY } });
  const stockAfter = (await db.productVariant.findUnique({ where: { id: v.variantId } }))!.stock;
  out.results = {
    statuses: statusCounts(rs.map((r) => r.status)), errorCodes: Object.fromEntries(rs.map((r) => [r.code, 0]).map(([c]) => [c, rs.filter((r) => r.code === c).length])),
    latency: summarizeLatency(rs.map((r) => r.ms)),
    correctness: { ordersCreated: orders, paymentGroupsCreated: groups, stockAfter, expectedOrders: 1, noDuplicates: orders === 1 },
    connections: conn,
  };
  console.log(JSON.stringify(out.results, null, 2));
  await restoreVariant(v.variantId, 100); await cleanupCarts([buyerEmail(0)]);
}

// ═══ recovery — cooldown after the rush (light; deep hang test = webhook-resilience C) ══
if (scenario === "recovery") {
  const v = await makeLtVariant(`rec-${runId}`, 1000);
  const cookie = (await ensureBuyers(1))[0];
  for (let i = 0; i < 3; i++) await fireCheckout(cookie, v.variantId, `rw-${runId}-${i}`, buyerEmail(0));
  console.log("baseline p50 recorded — measuring time-to-cooldown after a 40-wide burst");
  const cookies = await ensureBuyers(40);
  const burst = await Promise.all(cookies.map((ck, i) => fireCheckout(ck, v.variantId, `rec-burst-${runId}-${i}`, buyerEmail(i))));
  const burstP95 = percentile(burst.map((r) => r.ms), 95);
  const sampler = await makeSampler(500);
  let cooldownMs = -1; let probe: any = null;
  const t0 = performance.now();
  while (performance.now() - t0 < 60_000) {
    await new Promise((r) => setTimeout(r, 2500));
    probe = await fireCheckout(cookie, v.variantId, `rec-probe-${runId}-${Math.round(performance.now())}`, buyerEmail(0));
    if (probe.status === 201 && probe.ms <= Math.max(1500, burstP95 * 0.5)) { cooldownMs = Math.round(performance.now() - t0); break; }
  }
  const conn = sampler.summarize(); await sampler.stop();
  out.results = { burstLatencyP95: burstP95, burstStatuses: statusCounts(burst.map((r) => r.status)), cooldownMs, lastProbe: probe, connections: conn };
  console.log(JSON.stringify(out.results, null, 2));
  await restoreVariant(v.variantId, 1000); await cleanupCarts([buyerEmail(0), ...cookies.map((_, i) => buyerEmail(i))]);
}

out.finishedAt = new Date().toISOString();
writeFileSync(`performance/runs/2026-10-25-load-${scenario}.json`, JSON.stringify(out, null, 2));
console.log(`\nsaved performance/runs/2026-10-25-load-${scenario}.json`);
process.exit(0);
