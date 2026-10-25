// RX-PRV Phase 2.4 — Reservation-expiry gap probe.
// Creates a checkout, NEVER pays, shortens PaymentGroup.expiresAt to +45s,
// then observes 75s: proves stock stays held and the expiry passes unenforced
// (no scheduler exists). Scheduler behaviours are therefore NOT TESTED —
// reported as product gaps, not test failures of the runner.
// @ts-nocheck
import { db } from "../../src/lib/db";
import { makeLtVariant, ltShopperCookie, checkout, restoreVariant, cleanupCarts, check, summary } from "./lib";

const stamp = Date.now().toString(36);
const shopperEmail = `lt-expiry-${stamp}@lt.test`;
const results = { runId: stamp, startedAt: new Date().toISOString(), tests: [] as any[] };

const cookie = await ltShopperCookie(shopperEmail, "LT Expiry Tester");
const v = await makeLtVariant(`exp-${stamp}`, 3);
const preStock = (await db.productVariant.findUnique({ where: { id: v.variantId } }))!.stock;

const co = await checkout(cookie, v.variantId, `exp-${stamp}`, 1);
if (co.status !== 201) { console.log("FATAL setup failed", co.status, co.body); process.exit(2); }
const ref = co.body.data.paymentRef as string;

// shorten the expiry so the observation fits this bounded run
await db.paymentGroup.update({ where: { ref }, data: { expiresAt: new Date(Date.now() + 45_000) } });
console.log("checkout holds stock; expiresAt shortened to +45s; observing 75s with NO payment…");

const sample: { t: number; stock: number | null; orderStatus: string | null; expired: boolean }[] = [];
for (let t = 0; t <= 75; t += 15) {
  if (t > 0) await new Promise((r) => setTimeout(r, 15_000));
  const stock = (await db.productVariant.findUnique({ where: { id: v.variantId }, select: { stock: true } }))?.stock ?? null;
  const order = await db.paymentGroup.findUnique({ where: { ref }, select: { orders: { select: { status: true } } } });
  const grp = await db.paymentGroup.findUnique({ where: { ref }, select: { expiresAt: true, status: true } });
  const expired = grp ? grp.expiresAt.getTime() < Date.now() : false;
  sample.push({ t, stock, orderStatus: order?.orders[0]?.status ?? null, expired });
  console.log(`   t=${t}s stock=${stock} order=${order?.orders[0]?.status} expiresPast=${expired} group=${grp?.status}`);
}

const last = sample[sample.length - 1];
const t1 = [
  check("G1: stock remains HELD 75s after unpaid checkout", last.stock === preStock - 1, `pre=${preStock} final=${last.stock}`),
  check("G2: order remains payment_pending after expiry passed", last.orderStatus === "payment_pending" && last.expired, `order=${last.orderStatus} expiresPast=${last.expired}`),
  check("G3: no stock released (no sweep exists) — F3 gap CONFIRMED by measurement", last.stock === preStock - 1, `leakedUnits=1`),
];
results.tests.push({ test: "expiry_gap_probe", checks: t1, sample });
results.notTestedBecauseFeatureAbsent = [
  "scheduler execution / repeated expiry sweeps",
  "worker restarts / overlapping runs",
  "database failure recovery of the sweep",
  "simultaneous expiry + payment confirmation (late payment after release)",
  "expiry backlog alerts / observability",
  "503 CHECKOUT_BUSY end-to-end (gate absent)",
];

await restoreVariant(v.variantId, preStock);
await cleanupCarts([shopperEmail]);
console.log("[cleanup] stock restored to", preStock, "; [LT] unpaid order left tagged");

results.finishedAt = new Date().toISOString();
console.log("\nRESULTS_JSON " + JSON.stringify(results));
process.exit(summary("expiry-gap-probe"));
