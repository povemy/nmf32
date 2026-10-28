// G. SOAK & RECOVERY (ladder step G) — sustain an agreed portion (default 40%)
// of the passing peak from ladder step C for 30+ minutes. Observes: memory,
// connection leakage, scheduler reliability, backlog growth. After the soak,
// the ops side verifies recovery (guarded abort + controlled dependency
// interruption are exercised separately — see environment-matrix.md rules).
// Run: TARGET_CONFIRM=staging BASE=… DB_FINGERPRINT=… WEBHOOK_SECRET=… \
//      k6 run -e RUN_ID=soak-1 -e RATE=3 -e DURATION=30m profiles/soak.js
import { guardSetup, loadFixtures, journeyOnce } from "../lib.js";
import { sleep } from "k6";

const RATE = Number(__ENV.RATE ?? 3); // journeys/sec — set to ~40% of step-C passing peak
const DURATION = __ENV.DURATION ?? "30m";

export let options = {
  scenarios: {
    soak: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: 20,
      maxVUs: 80,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.02"],
    checkout_latency_ms: ["p(95)<3000"], // DRAFT target — sustained, not just burst
    "journeys_total{outcome:aborted}": ["count<10"],
  },
};

export function setup() {
  const guard = guardSetup();
  return { guard, fx: loadFixtures() };
}

export default function (data) {
  const cache = globalThis.__shoppers ?? (globalThis.__shoppers = {});
  const key = `vu${__VU}`;
  cache[key] ??= { email: null, cookie: null };
  journeyOnce(data.fx, cache[key], key, `${Date.now()}`, { pay: "webhook" });
  sleep(1);
}
