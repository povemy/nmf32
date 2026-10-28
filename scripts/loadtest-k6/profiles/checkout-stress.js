// E. CHECKOUT & PAYMENT STRESS (ladder step E) — distinct buyers, stable
// idempotency keys, duplicate webhook per payment, same-seller contention (all
// buyers hit the contended fixture → same store/wallet), pool pressure.
// Verifies overload produces CONTROLLED responses (503 CHECKOUT_BUSY /
// 409 semantic) rather than raw infrastructure failures — http_req_failed is
// wired to count raw failures only (see lib.js guardSetup).
// NOTE: needs the staging rate-limit knobs raised on the TARGET env:
//   WEBHOOK_RATE_LIMIT_PER_MIN / SIMULATE_RATE_LIMIT_PER_MIN (topology §5).
// Run: TARGET_CONFIRM=staging BASE=… DB_FINGERPRINT=… WEBHOOK_SECRET=… \
//      k6 run -e RUN_ID=stress-1 -e PEAK=8 profiles/checkout-stress.js
import { guardSetup, loadFixtures, journeyOnce, purchase, payViaWebhook, newShopper, checkouts, checkoutLatency } from "../lib.js";
import { sleep } from "k6";

const PEAK = Number(__ENV.PEAK ?? 8); // purchase journeys/sec at peak

export let options = {
  scenarios: {
    stress: {
      executor: "ramping-arrival-rate",
      startRate: 2,
      timeUnit: "1s",
      preAllocatedVUs: 40,
      maxVUs: 120,
      stages: [
        { target: PEAK / 2, duration: "90s" },
        { target: PEAK, duration: "180s" },
        { target: PEAK * 1.5, duration: "90s" }, // deliberate overshoot → expect 503s
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.02"], // raw infra failures stay ~0 — overload must be CONTROLLED
    "checkouts_total{outcome:error}": ["count<10"],
    "checkout_latency_ms": ["p(95)<5000"], // stress ceiling (draft, distinct from normal target)
  },
};

export function setup() {
  const guard = guardSetup();
  if (!__ENV.WEBHOOK_SECRET) throw new Error("[stress] WEBHOOK_SECRET required for the payment path");
  return { guard, fx: loadFixtures() };
}

export default function (data) {
  const cache = globalThis.__shoppers ?? (globalThis.__shoppers = {});
  const key = `vu${__VU}`;
  cache[key] ??= { email: null, cookie: null };
  if (!cache[key].cookie) {
    const s = newShopper(key);
    cache[key] = { ...s };
  }
  // same-seller contention: everyone buys the CONTENDED fixture
  const idem = `lt-k6-${data.fx.runId}-${key}-${Date.now()}`;
  const p = purchase(data.fx.contended, cache[key].cookie, idem, { email: cache[key].email });
  if (p.outcome === "success" && p.ref) {
    payViaWebhook(__ENV.WEBHOOK_SECRET, p.ref, p.amountMinor);
    payViaWebhook(__ENV.WEBHOOK_SECRET, p.ref, p.amountMinor); // duplicate delivery — must converge
  }
  sleep(0.25);
}
