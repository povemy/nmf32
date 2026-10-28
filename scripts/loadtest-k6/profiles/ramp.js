// C. GRADUAL RAMP (ladder step C) — progressively increasing arrival rates to
// find the FIRST BRACKET where latency / error rate / queueing departs from
// the draft targets. Each stage is reported separately by k6 (aggregate per
// threshold may hide the bracket — use --summary-export and per-stage output
// tags; the capacity report records the first failing bracket + headroom).
// Run: TARGET_CONFIRM=staging BASE=… DB_FINGERPRINT=… WEBHOOK_SECRET=… \
//      k6 run -e RUN_ID=ramp-1 profiles/ramp.js --summary-export=ramp-1.json
import { guardSetup, loadFixtures, journeyOnce } from "../lib.js";
import { sleep } from "k6";

// Bracket plan (journeys/sec): 2 → 4 → 6 → 8 → 12 → 16 → 20. Stage duration
// tunable (default 2 min). The FIRST failing bracket defines the operating
// ceiling; do NOT silently relax thresholds to force a PASS.
const STAGE_SECONDS = Number(__ENV.STAGE_SECONDS ?? 120);

export let options = {
  scenarios: {
    ramp: {
      executor: "ramping-arrival-rate",
      startRate: 2,
      timeUnit: "1s",
      preAllocatedVUs: 60,
      maxVUs: 200,
      stages: [
        { target: 2, duration: `${STAGE_SECONDS}s` },
        { target: 4, duration: `${STAGE_SECONDS}s` },
        { target: 6, duration: `${STAGE_SECONDS}s` },
        { target: 8, duration: `${STAGE_SECONDS}s` },
        { target: 12, duration: `${STAGE_SECONDS}s` },
        { target: 16, duration: `${STAGE_SECONDS}s` },
        { target: 20, duration: `${STAGE_SECONDS}s` },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    checkout_latency_ms: ["p(95)<3000"], // DRAFT target
    "checkouts_total{outcome:error}": ["count<10"], // raw failures must stay ~0
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
  sleep(0.5);
}
