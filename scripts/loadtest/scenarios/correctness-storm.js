// ============================================================================
// LT-3 correctness-storm.js — oversell/idempotency concurrency probe (rule #8).
//
// 100 VUs (profiles.correctness.vus) START TOGETHER, each exactly ONE journey
// (executor per-vu-iterations, iterations=1 — no stagger):
//   login with a UNIQUE lt-shopper-<i> → add lt-flash-correct-item (stock 60)
//   qty 1 → POST checkout/create (unique Idempotency-Key) → simulate success
//   → poll status → record outcome.
//
// OUTCOME RECORDING (all measured, none retried):
//   201 + paid            → orders_paid++, checkout_created++
//   409 OUT_OF_STOCK      → order_create_409_out_of_stock++  (EXPECTED for 40
//                           of 100 shoppers when stock=60: the conditional
//                           decrement guard rejects the losers — rule #8)
//   409 other / other 4xx → order_create_409_other / order_create_4xx (by code)
//   NO RETRIES on 409 — a retry would mask the exact guard behaviour.
//
// AFTERWARDS: scripts/loadtest/integrity.ts (LT-2) verifies in the DB that
// stock decremented by EXACTLY the number of successful checkouts, no negative
// stock, idempotent replays produce duplicates-not-new-orders, and ledger
// invariants hold. The coordinator spawns it for the `correctness` profile.
//
// Run: LT_PROFILE=correctness k6 run scripts/loadtest/scenarios/correctness-storm.js
// ============================================================================

import { sleep } from "k6";
import {
  CONFIG, PROFILE_NAME, PROFILE, applyRunOverrides, baseOptions,
  resolveProduct, loginShopper, cartAdd, cartAddFailures, checkoutCreate, paymentSimulate,
  paymentStatus, checkoutAttempts, checkoutCreated, ordersPaid, orderCreate409Stock,
  orderCreate409Moq, orderCreate409Other, orderCreate4xx, orderCreate5xx, paymentFailed,
  paymentSimulateErrors, paymentPollTimeout, orderE2eMs, integrityFailures, authFailures,
  xffFor, makeSummaryHandler,
} from "./lib/common.js";

const VUS = Number(PROFILE.vus || 100);

export const options = baseOptions({
  scenarios: {
    default: applyRunOverrides({
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: Number(PROFILE.iterationsPerVu || 1),
      maxDuration: "5m",
      gracefulStop: "10s",
    }),
  },
});

export function setup() {
  const product = resolveProduct(CONFIG.endpoints?.correctProductSlug || "lt-flash-correct-item", 0);
  if (!product || !product.variantId) {
    // This scenario is MEANINGLESS without the correctness item — fail loudly.
    throw new Error("[correctness-storm] LT correctness product not resolved — run `bun scripts/loadtest/seed.ts` (LT-2) first");
  }
  console.log(`[correctness-storm] item: ${product.slug} variant=${product.variantId} stock=${product.stock} | ${VUS} VUs, 1 journey each, unique shoppers, NO 409 retries`);
  return { product };
}

function recordOutcome(res) {
  if (res.status === 409) {
    let code = "UNKNOWN";
    try { code = (res.json().error && res.json().error.code) || "UNKNOWN"; } catch (_e) { /* not JSON */ }
    if (code === "OUT_OF_STOCK") orderCreate409Stock.add(1);
    else if (code === "MOQ_NOT_MET") orderCreate409Moq.add(1);
    else orderCreate409Other.add(1, { code });
    return { paid: false, status: 409, code };
  }
  if (res.status >= 400 && res.status < 500) {
    let code = "UNKNOWN";
    try { code = (res.json().error && res.json().error.code) || "UNKNOWN"; } catch (_e) { /* not JSON */ }
    orderCreate4xx.add(1, { code, status: String(res.status) });
    return { paid: false, status: res.status, code };
  }
  if (res.status >= 500) {
    orderCreate5xx.add(1);
    return { paid: false, status: res.status };
  }
  return null; // 201-ish → caller continues to payment
}

export default function (data) {
  const vu = __VU;
  const iter = 1; // exactly one journey per VU
  const t0 = Date.now();
  const xff = xffFor(vu, iter);
  const product = data.product;

  // UNIQUE shopper per VU (vu-1 spread across the seeded shopper range)
  const sess = loginShopper(vu, iter);
  if (!sess || !sess.token) {
    authFailures.add(1, { fatal: "storm" });
    return;
  }

  // add correctness item qty 1
  const add = cartAdd(sess.token, product.variantId, 1, { xff });
  if (add.status >= 400) {
    cartAddFailures.add(1, { status: String(add.status) });
  }

  // checkout create — unique idem key, NO retry on any failure.
  // Timeout configurable (endpoints.checkout.createTimeoutS, default 20s):
  // Measured 2026-10-22 — under 100-way rush the pool=10 pipeline takes >20s
  // per create; a client timeout does NOT cancel server work (the create
  // completes server-side), so the outcome became invisible. 90s lets the
  // storm observe true outcomes while still modeling a patient buyer.
  checkoutAttempts.add(1);
  const idem = `${vu}-${iter}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createTimeoutS = String(CONFIG.endpoints?.checkout?.createTimeoutS || 90);
  const res = checkoutCreate(sess.token, [{ variantId: product.variantId, qty: 1 }], idem, { xff, timeout: `${createTimeoutS}s` });
  if (res.status !== 201) {
    recordOutcome(res);
    return;
  }
  checkoutCreated.add(1);

  let paymentRef = null;
  try { paymentRef = (res.json().data || {}).paymentRef || null; } catch (_e) { /* handled below */ }
  if (!paymentRef) {
    paymentPollTimeout.add(1);
    integrityFailures.add(1);
    return;
  }

  const sim = paymentSimulate(paymentRef, { xff, timeout: `${createTimeoutS}s` });
  if (sim.status >= 400) {
    paymentSimulateErrors.add(1, { status: String(sim.status) });
    return; // created-but-not-paid is a recorded, honest outcome
  }

  const maxTries = Number((CONFIG.endpoints || {}).paymentPollMaxTries || 10);
  const intervalS = Number((CONFIG.endpoints || {}).paymentPollIntervalS || 0.5);
  let finalStatus = null;
  for (let i = 0; i < maxTries; i++) {
    sleep(intervalS);
    const st = paymentStatus(paymentRef, { xff });
    if (st.status === 200) {
      try {
        finalStatus = (st.json().data || {}).status;
        if (finalStatus !== "requires_payment") break;
      } catch (_e) { /* keep polling */ }
    }
  }

  if (finalStatus === "succeeded") {
    ordersPaid.add(1);
    orderE2eMs.add(Date.now() - t0);
    integrityFailures.add(0);
  } else if (finalStatus === "failed" || finalStatus === "expired") {
    paymentFailed.add(1);
  } else {
    paymentPollTimeout.add(1);
    integrityFailures.add(1);
  }
}

export const handleSummary = makeSummaryHandler(`correctness-storm/${PROFILE_NAME}`);
