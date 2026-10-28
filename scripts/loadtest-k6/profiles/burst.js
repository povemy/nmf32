// D. INFLUENCER ARRIVAL BURST (ladder step D) — new shoppers arriving over a
// defined burst window: browsing (product detail, catalog) separated from
// actual checkout/payment. Single flash-sale product with controlled stock.
// Two scenarios run in the same test:
//   • browse_wave — arrival-rate burst of browsing-only journeys (the crowd)
//   • buyers      — smaller constant arrival of FULL purchase journeys on the
//                   flash-sale fixture (the buyers)
// Run: TARGET_CONFIRM=staging BASE=… DB_FINGERPRINT=… WEBHOOK_SECRET=… \
//      k6 run -e RUN_ID=burst-1 -e BURST_PEAK=30 profiles/burst.js
import { guardSetup, loadFixtures, journeyOnce, browse, browseLatency, newShopper, purchase } from "../lib.js";
import { sleep } from "k6";

const BURST_PEAK = Number(__ENV.BURST_PEAK ?? 30); // browse journeys/sec at peak

export let options = {
  scenarios: {
    browse_wave: {
      executor: "ramping-arrival-rate",
      startRate: 2,
      timeUnit: "1s",
      preAllocatedVUs: 80,
      maxVUs: 300,
      stages: [
        { target: BURST_PEAK, duration: "60s" },  // crowd arrives over 1 min
        { target: BURST_PEAK, duration: "120s" }, // sustained crowd
        { target: 2, duration: "60s" },           // tail
      ],
    },
    buyers: {
      executor: "constant-arrival-rate",
      rate: 1, // 1 purchase journey/sec against the flash-sale fixture
      timeUnit: "1s",
      duration: "4m",
      startTime: "30s",
      preAllocatedVUs: 10,
      maxVUs: 40,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    "browse_latency_ms": ["p(95)<1500"], // draft browsing target
    "checkout_latency_ms": ["p(95)<3000", "p(99)<5000"], // DRAFT targets
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
  if (__SCENARIO === "browse_wave") {
    const latencies = [];
    browse(latencies);
    for (const l of latencies) browseLatency.add(l);
    sleep(0.5);
  } else {
    journeyOnce(data.fx, cache[key], key, `${Date.now()}`, { pay: "webhook", fixture: "flash" });
    sleep(0.5);
  }
}
