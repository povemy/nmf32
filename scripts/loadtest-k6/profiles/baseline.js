// B. BASELINE (ladder step B) — low-concurrency representative shopping
// journeys at a gentle arrival rate. Records latency/error/resource baselines
// and successful orders. DRAFT targets (readiness-checklist §proposed — for
// stakeholder review, NOT silently adopted): checkout p95 ≤ 3 s.
// Run: TARGET_CONFIRM=staging BASE=… DB_FINGERPRINT=… WEBHOOK_SECRET=… \
//      k6 run -e RUN_ID=base-1 -e RATE=2 -e DURATION=5m profiles/baseline.js
import { guardSetup, loadFixtures, journeyOnce, browseLatency, checkoutLatency, paymentLatency, journeys } from "../lib.js";
import { sleep } from "k6";

const RATE = Number(__ENV.RATE ?? 2); // journeys/sec (arrival rate)
const DURATION = __ENV.DURATION ?? "5m";

export let options = {
  scenarios: {
    baseline: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: Math.max(10, RATE * 3),
      maxVUs: Math.max(40, RATE * 10),
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.02"],
    checkout_latency_ms: ["p(95)<3000"], // DRAFT target — review before adopting
    "journeys_total{outcome:aborted}": ["count<5"],
  },
};

export function setup() {
  const guard = guardSetup();
  return { guard, fx: loadFixtures() };
}

export default function (data) {
  const vu = __VU;
  const cache = globalThis.__shoppers ?? (globalThis.__shoppers = {});
  const key = `vu${vu}`;
  cache[key] ??= { email: null, cookie: null };
  journeyOnce(data.fx, cache[key], key, `${Date.now()}`, { pay: "webhook" });
  sleep(1);
}
