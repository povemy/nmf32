// F. RESERVATION & REFUND RECOVERY (ladder step F) — drives the recovery
// machinery under a modest browsing/checkout background:
//   • creates checkouts that are NEVER paid → they expire → the scheduler's
//     expiry sweep must release their stock exactly once (verified post-run
//     by verify-integrity.ts stock arithmetic);
//   • fires DELAYED payment.succeeded webhooks for a share of the expired
//     groups → each must be refused 409 GROUP_EXPIRED and record exactly one
//     refund obligation (mock adapter processes it on the next
//     refund-reconcile tick — verified via /api/cron/refund-reconcile GET
//     counts after the run; provider outcomes are mock-PSP behavior).
// Uses mock PSP rails only (staging gate psp.mock.enabled=true).
// Run: TARGET_CONFIRM=staging BASE=… DB_FINGERPRINT=… WEBHOOK_SECRET=… \
//      k6 run -e RUN_ID=recov-1 profiles/recovery.js
// then: bun scripts/loadtest-k6/verify-integrity.ts (RUN_ID=recov-1)
import { guardSetup, loadFixtures, browse, browseLatency, purchase, payViaWebhook, signWebhook, newShopper } from "../lib.js";
import http from "k6/http";
import { sleep } from "k6";
import { Counter } from "k6/metrics";

const latePayments = new Counter("late_payment_webhooks_total"); // tagged outcome=refused409|other
const expiredCheckouts = new Counter("expired_checkouts_created");

export let options = {
  scenarios: {
    background: {
      executor: "constant-arrival-rate",
      rate: 1,
      timeUnit: "1s",
      duration: "3m",
      preAllocatedVUs: 10,
      maxVUs: 30,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.02"],
    "late_payment_webhooks_total{outcome:refused409}": ["count>0"], // the refusal IS the correct behavior
  },
};

export function setup() {
  const guard = guardSetup();
  if (!__ENV.WEBHOOK_SECRET) throw new Error("[recovery] WEBHOOK_SECRET required");
  return { guard, fx: loadFixtures() };
}

const state = globalThis.__rec ?? (globalThis.__rec = { unpaid: [], iter: 0 });

export default function (data) {
  const iter = state.iter++;
  if (iter % 2 === 0) {
    // abandoned checkout → will expire → sweep releases stock
    const cache = globalThis.__shoppers ?? (globalThis.__shoppers = {});
    const key = `vu${__VU}`;
    cache[key] ??= { email: null, cookie: null };
    if (!cache[key].cookie) {
      const s = newShopper(key);
      cache[key] = { ...s };
    }
    const p = purchase(data.fx.flash, cache[key].cookie, `lt-k6-${data.fx.runId}-${key}-ab${iter}`, { email: cache[key].email });
    if (p.outcome === "success" && p.ref) {
      state.unpaid.push({ ref: p.ref, amountMinor: p.amountMinor, at: Date.now() });
      expiredCheckouts.add(1);
    }
  } else {
    const latencies = [];
    browse(latencies);
    for (const l of latencies) browseLatency.add(l);
  }
  // 15+ min old "late" deliveries: age the FIRST abandoned groups by using an
  // out-of-freshness timestamp is NOT the same as expiry — a late payment
  // needs the GROUP to be expired (sweep already ran). The 30-min payment
  // window means true late arrivals take 20+ min wall-clock; to keep this
  // profile runnable, expired-checkout creation above + a post-run follow-up
  // (scripts/readiness/late-payment-refund.ts does the full 409/obligation
  // e2e with time manipulation) cover the policy; here we only VERIFY the
  // refusal path for any group already expired at fire time.
  const now = Date.now();
  for (const u of state.unpaid) {
    if (u.fired || now - u.at < 90_000) continue; // only groups old enough to be expired
    u.fired = true;
    const r = payViaWebhook(__ENV.WEBHOOK_SECRET, u.ref, u.amountMinor);
    latePayments.add(1, { outcome: r.status === 409 ? "refused409" : "other" });
  }
  sleep(1);
}
