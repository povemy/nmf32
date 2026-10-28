// A. PRODUCTION SMOKE (ladder step A) — run FIRST against a fresh staging
// deployment, before any load. 1 VU, ~2 min, exercises the critical surface:
// public routes, health/deployment identification, auth, ONE full purchase
// journey through the signed-webhook pipeline, duplicate-webhook convergence.
// Complements `bun scripts/readiness/deployment-smoke.ts` (DB-side checks).
// Run: TARGET_CONFIRM=staging BASE=… DB_FINGERPRINT=… WEBHOOK_SECRET=… \
//      k6 run -e RUN_ID=smoke-1 profiles/smoke.js
import { guardSetup, loadFixtures, journeyOnce, checkoutLatency, paidOrders, journeys } from "../lib.js";
import { sleep } from "k6";

export let options = {
  vus: 1,
  iterations: 6,
  thresholds: {
    http_req_failed: ["rate<0.01"], // raw infra failures only (409/503 excluded by design)
    "paid_orders_total": ["count>0"],
    "journeys_total{outcome:completed}": ["count>0"],
    "journeys_total{outcome:aborted}": ["count==0"],
  },
};

export function setup() {
  const guard = guardSetup();
  return { guard, fx: loadFixtures() };
}

const shopper = { email: null, cookie: null };

export default function (data) {
  const iter = __ITER;
  const r = journeyOnce(data.fx, shopper, "vu0", `smoke-${iter}`, { pay: "webhook", duplicate: iter === 0 });
  if (r.outcome !== "completed") console.log(`smoke journey iter=${iter} → ${r.outcome}`);
  sleep(5);
}
