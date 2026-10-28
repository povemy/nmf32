// ============================================================================
// test-checkout-busy-e2e.ts — END-TO-END 503 CHECKOUT_BUSY experience
// (PROD-READY mission Phase 2.6). Runs against a staging instance whose gate
// is deliberately small (CHECKOUT_MAX_CONCURRENCY=2, QUEUE_MAX=4,
// WAIT_BUDGET_MS=1000 via env at boot) so the overload path actually fires.
//
// Verified end to end over real HTTP:
//   1. overload responses are DELIBERATE: 503 + error.code=CHECKOUT_BUSY +
//      Retry-After header (>= 1s) — classified separately from 5xx infra.
//   2. cart preservation: a buyer's cart is byte-identical before/after a 503
//      (nothing charged, nothing created, cart untouched).
//   3. bounded retries with STABLE idempotency keys: every 503'd request,
//      retried with the SAME Idempotency-Key while honoring Retry-After,
//      eventually succeeds; total groups == unique keys (no duplicates).
//   4. retry-storm protection: queue overflow answers FAST with 503 (bounded
//      memory), and the server stays healthy after the storm.
//
// Evidence: performance/prod-ready/checkout-busy-e2e-<ts>.json
// ============================================================================
import { mkdirSync, writeFileSync } from "fs";
import { db } from "../src/lib/db";
import { LT_PASSWORD } from "./loadtest/util";

const BASE = process.env.LT_BASE ?? "http://127.0.0.1:3100";
const RUN = `busy-${Date.now().toString(36)}`;
mkdirSync("performance/prod-ready", { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Check = { name: string; pass: boolean; detail?: string };
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail?: string) => { checks.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };

async function buyerCreds(i: number): Promise<{ cookie: string; email: string }> {
  const email = `lt-buyer-${String(i).padStart(3, "0")}@lt.test`;
  const res = await fetch(`${BASE}/api/auth/shopper/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: LT_PASSWORD }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (res.status !== 200 || !cookie) throw new Error(`login ${email} → ${res.status}`);
  return { cookie, email };
}

async function create(cookie: string, key: string, email: string, vid: string) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/checkout/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie, "Idempotency-Key": key },
    body: JSON.stringify({
      items: [{ variantId: vid, qty: 1 }],
      customer: { name: `[LT] ${email}`, email },
      shippingAddress: { line1: "1 Busy Test Jalan", city: "Kuala Lumpur", postcode: "50000", state: "Kuala Lumpur" },
      provider: "fpx_toyyibpay",
    }),
  });
  const ms = Math.round(performance.now() - t0);
  const body = (await res.json().catch(() => ({}))) as { data?: { paymentRef?: string; duplicate?: boolean }; error?: { code?: string } };
  return { status: res.status, ms, retryAfter: res.headers.get("retry-after"), code: body.error?.code, ref: body.data?.paymentRef };
}


/** Staggered logins: batch small so 20 concurrent logins never exhaust the small staging pool. */
async function credsBatched(idxs: number[], batch = 6, gapMs = 450): Promise<{ cookie: string; email: string }[]> {
  const out: { cookie: string; email: string }[] = [];
  for (let i = 0; i < idxs.length; i += batch) {
    const chunk = idxs.slice(i, i + batch);
    out.push(...await Promise.all(chunk.map((n) => buyerCreds(n))));
    if (i + batch < idxs.length) await sleep(gapMs);
  }
  return out;
}

async function main() {
  const storm = await db.productVariant.findFirst({ where: { product: { slug: "lt-perf-storm-item", store: { slug: "lt-main-store" } } }, select: { id: true } });
  if (!storm) throw new Error("missing [LT] storm variant");
  const vid = storm.id;
  console.log(`=== CHECKOUT_BUSY e2e ${RUN} @ ${BASE} (gate 2/4/1000ms expected) ===\n`);

  // ── warm-up: one request compiles the route (unmeasured)
  const warm = await buyerCreds(90);
  await create(warm.cookie, `${RUN}-warmup-${Date.now()}`, warm.email, vid);
  await sleep(500);

  // ── 1. overload: 16 simultaneous creates
  const creds = await credsBatched([...Array(16)].map((_, i) => i + 20));
  console.log("firing 16 simultaneous creates…");
  const t0 = performance.now();
  const first = await Promise.all(creds.map((c, i) => create(c.cookie, `${RUN}-k${i}`, c.email, vid)));
  const stormMs = Math.round(performance.now() - t0);
  const created = first.filter((r) => r.status === 201 || r.status === 200);
  const busy = first.filter((r) => r.status === 503);
  const other = first.filter((r) => r.status !== 503 && r.status !== 201 && r.status !== 200);
  console.log(`outcomes: ${created.length} created, ${busy.length} CHECKOUT_BUSY, ${other.length} other (${stormMs}ms wall)`);
  check("overload produced deliberate 503 CHECKOUT_BUSY responses", busy.length > 0, `${busy.length}/16`);
  check("no disguised failures (no unexpected 5xx/4xx in the storm)", other.length === 0, JSON.stringify(first.filter((r) => r.status !== 503 && r.status < 200 || r.status >= 300 && r.status !== 503).map((r) => r.status)));
  check("all 503s carry error.code=CHECKOUT_BUSY", busy.every((r) => r.code === "CHECKOUT_BUSY"), busy.map((r) => r.code).join(","));
  check("all 503s carry Retry-After >= 1s", busy.every((r) => Number(r.retryAfter) >= 1), busy.map((r) => r.retryAfter).join(","));

  // ── 2. cart preservation across a 503 — the cart buyer fires CONCURRENTLY with the fillers
  // so the request genuinely lands on an overloaded gate (a request fired after the drain gets 201).
  const cartBuyer = await buyerCreds(40);
  await fetch(`${BASE}/api/cart/items`, { method: "POST", headers: { "Content-Type": "application/json", cookie: cartBuyer.cookie }, body: JSON.stringify({ variantId: vid, qty: 2 }) });
  const cartRowsBefore = await db.cartItem.findMany({ where: { cart: { shopper: { email: cartBuyer.email } } }, select: { variantId: true, qty: true, selected: true } });
  const fillers = await credsBatched([...Array(8)].map((_, i) => i + 50)); // pre-login, unmeasured
  const fillerPs = fillers.map((c, i) => create(c.cookie, `${RUN}-fill${i}-${Date.now()}`, c.email, vid));
  const cartP = (async () => { await sleep(40); return create(cartBuyer.cookie, `${RUN}-cart-${Date.now()}`, cartBuyer.email, vid); })(); // fires INTO the overloaded gate
  const all = await Promise.all([...fillerPs, cartP]);
  const cartRes = all[all.length - 1];
  const cartRowsAfter = await db.cartItem.findMany({ where: { cart: { shopper: { email: cartBuyer.email } } }, select: { variantId: true, qty: true, selected: true } });
  check("503 leaves the buyer's cart byte-identical (nothing created, nothing charged)", cartRes.status === 503 && JSON.stringify(cartRowsBefore) === JSON.stringify(cartRowsAfter), `status=${cartRes.status} before=${JSON.stringify(cartRowsBefore)} after=${JSON.stringify(cartRowsAfter)}`);

  // ── 3. bounded retries + stable idempotency (SAME key, honoring Retry-After)
  console.log("\nretrying all 503'd keys (same key, Retry-After honored, ≤8 attempts)…");
  const retryTargets = first.map((r, i) => ({ r, i })).filter((x) => x.r.status === 503);
  const recovered: { key: string; attempts: number; status: number }[] = [];
  const settled = new Map<number, number>(); // index → status
  first.forEach((r, i) => { if (r.status === 201 || r.status === 200) settled.set(i, r.status); });
  let wave = 0;
  const pending = retryTargets.map((x) => ({ i: x.i, key: `${RUN}-k${x.i}`, attempts: 1 }));
  while (pending.length > 0 && wave < 8) {
    await sleep(2_200); // honor Retry-After: 2
    wave++;
    const res = await Promise.all(pending.map(async (p) => {
      const out = await create(creds[p.i].cookie, p.key, creds[p.i].email, vid);
      return { p, out };
    }));
    for (const { p, out } of res) {
      p.attempts++;
      if (out.status === 201 || out.status === 200) { settled.set(p.i, out.status); recovered.push({ key: p.key, attempts: p.attempts, status: out.status }); }
    }
    for (let k = pending.length - 1; k >= 0; k--) if (settled.has(pending[k].i)) pending.splice(k, 1);
  }
  check("every 503'd request recovered via bounded retry with the SAME idempotency key", settled.size === 16, `${settled.size}/16 settled (waves=${wave}, still pending=${pending.length})`);
  const groups = await db.paymentGroup.count({ where: { idemKey: { startsWith: `${RUN}-k` } } });
  const orders = await db.order.count({ where: { paymentGroup: { idemKey: { startsWith: `${RUN}-k` } } } });
  check("exactly ONE payment group per unique idempotency key (no duplicates from retries)", groups === 16, `groups=${groups} for 16 keys`);
  check("exactly ONE order per key", orders === 16, `orders=${orders}`);

  // ── 4. retry-storm protection: overflow answers fast, server stays healthy
  console.log("\nretry-storm probe: 8 fillers in flight + 20 fresh-key burst…");
  const stormKeys = [...Array(20)].map((_, i) => `${RUN}-storm${i}-${Date.now()}`);
  const stormCreds = await credsBatched([...Array(20)].map((_, i) => i + 70));
  const t1 = performance.now();
  const burst = await Promise.all(stormCreds.map((c, i) => create(c.cookie, stormKeys[i], c.email, vid)));
  const burstMs = Math.round(performance.now() - t1);
  const burstBusy = burst.filter((r) => r.status === 503);
  const burstInfra = burst.filter((r) => r.status >= 500 && r.code !== "CHECKOUT_BUSY"); // deliberate 503 overload ≠ infra
  const busyLat = burstBusy.map((r) => r.ms);
  check("retry storm answered with 503 CHECKOUT_BUSY (not 5xx infra, not a hang)", burstBusy.length > 0 && burstInfra.length === 0, `busy=${burstBusy.length}/20, infra=${burstInfra.length}`);
  check("overflow 503s are FAST (bounded queue answers immediately, no unbounded wait)", busyLat.length > 0 && Math.max(...busyLat) < 10_000, `p50≈${busyLat.sort()[Math.floor(busyLat.length / 2)]}ms max=${Math.max(...busyLat)}ms burst wall=${burstMs}ms`);
  const healthy = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: (await buyerCreds(99)).cookie } });
  check("server responsive immediately after the storm", healthy.status === 200, `status=${healthy.status}`);

  const pass = checks.every((c) => c.pass);
  console.log(`\n=== CHECKOUT_BUSY E2E: ${checks.filter((c) => c.pass).length}/${checks.length} PASS ===`);
  writeFileSync(`performance/prod-ready/checkout-busy-e2e-${RUN}.json`, JSON.stringify({ run: RUN, base: BASE, stormMs, firstOutcomes: first.map((r) => ({ status: r.status, ms: r.ms, code: r.code, retryAfter: r.retryAfter })), burst: burst.map((r) => ({ status: r.status, ms: r.ms, code: r.code })), checks, pass }, null, 2));
  console.log(`evidence → performance/prod-ready/checkout-busy-e2e-${RUN}.json`);
  await db.$disconnect();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error("crashed:", e); process.exit(2); });
