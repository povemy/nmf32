// ============================================================================
// LT-3 spike-launch.js — THE influencer-launch scenario (OPEN model).
//
// Traffic model (rule #12 — the launch verdict is tied to THIS explicit
// arrival pattern, never to a VU count):
//   ramping-arrival-rate: 0 → arrivalPeak journeys/s over rampToPeak,
//   plateau at arrivalPeak for `plateau`, then tail down to 0 over `tail`
//   (config.json profiles.spike: default 0→120/s in 10s, 3m plateau, 1m tail).
//
// Journey mix per arrival:
//   55% PDP views of lt-flash-perf-item ("viral" product detail)
//   15% add-to-cart of it (login cached per VU)
//   20% full checkout attempts (cart add → create → simulate → poll → verify)
//   10% generic browse (home / search / suggest rotation)
//
// Guardrails: stress.abort latency/error thresholds apply with abortOnFail
// (rule #9 layer 1); the coordinator watcher (event-loop lag, heap, FDs) is
// layer 2 and SIGINTs this process if the app crosses those limits.
//
// 409 OUT_OF_STOCK here is a MEASURED outcome (oversell guard under launch
// rush) — counted per code, never retried.
//
// Run: LT_PROFILE=spike k6 run scripts/loadtest/scenarios/spike-launch.js
// ============================================================================

import {
  CONFIG, PROFILE_NAME, PROFILE, spikeExecutor, applyRunOverrides, baseOptions, abortThresholds,
  resolveProduct, resolveStorefrontSlug, browseLeg, loginShopper, thinkTime, checkoutJourney, xffFor,
  getProductDetail, cartAdd, cartAddFailures, purchaseSkipped, makeSummaryHandler,
} from "./lib/common.js";

export const options = baseOptions({
  scenarios: { default: applyRunOverrides(spikeExecutor(PROFILE)) },
  thresholds: abortThresholds(), // abortOnFail on http p95 + error rate (stress.abort)
});

export function setup() {
  const product = resolveProduct(CONFIG.endpoints?.perfProductSlug || "lt-flash-perf-item", 0);
  const sfSlug = resolveStorefrontSlug(1);
  console.log(product
    ? `[spike] LT perf product resolved: ${product.slug} variant=${product.variantId} stock=${product.stock}`
    : "[spike] LT perf product NOT resolved (seed pending) — PDP/checkout legs degrade; checkout legs count purchase_skipped");
  console.log(`[spike] arrival pattern: ${PROFILE.arrivalStart ?? 0}→${PROFILE.arrivalPeak}/s over ${PROFILE.rampToPeak}, plateau ${PROFILE.plateau}, tail ${PROFILE.tail}`);
  return { product };
}

const vuIter = {};

export default function (data) {
  const vu = __VU;
  const iter = (vuIter[vu] = (vuIter[vu] || 0) + 1);
  const xff = xffFor(vu, iter);
  const r = Math.random() * 100;
  const product = data.product;

  if (r < 55) {
    if (product && product.storeSlug) {
      getProductDetail(product.storeSlug, product.slug, { xff });
    } else {
      browseLeg(vu, iter, null, null, data.sfSlug); // degrade to generic browse
    }
  } else if (r < 70) {
    const sess = loginShopper(vu, iter);
    if (sess && sess.token && product && product.variantId) {
      const add = cartAdd(sess.token, product.variantId, 1, { xff });
      if (add.status >= 400) cartAddFailures.add(1, { status: String(add.status) });
    } else {
      purchaseSkipped.add(1, { reason: product ? "no-session" : "no-lt-product" });
    }
  } else if (r < 90) {
    const sess = loginShopper(vu, iter);
    checkoutJourney(vu, iter, sess, product);
  } else {
    browseLeg(vu, iter, null, null, data.sfSlug);
  }
  thinkTime();
}

export const handleSummary = makeSummaryHandler(`spike-launch/${PROFILE_NAME}`);
