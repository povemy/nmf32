// ============================================================================
// LT-3 browse-arrival.js — OPEN-model browsing (constant-arrival-rate executor).
// Journeys arrive at profile.arrivalPerSec / second regardless of VU count —
// the OPEN arrival model (rule #5). Iterations are pre-defined by k6 as
// rate × duration. Same journey mix as browse.js (shared browseLeg()).
//
// VU pre-allocation: preAllocatedVUs = max(20, rate × openModel.preAllocatedVusPerArrival)
// maxVUs = min(openModel.hardVuCap, rate × openModel.maxVusFactor) — derived,
// printed in the init log, and recorded in the raw summary.
//
// Run: LT_PROFILE=soak k6 run scripts/loadtest/scenarios/browse-arrival.js
//      (also runnable with any profile that defines arrivalPerSec)
// ============================================================================

import {
  CONFIG, PROFILE_NAME, PROFILE, arrivalExecutor, applyRunOverrides, baseOptions,
  resolveProduct, resolveStorefrontSlug, browseLeg, loginShopper, thinkTime, makeSummaryHandler,
} from "./lib/common.js";

const RATE = Number(PROFILE.arrivalPerSec || 5);
const DURATION = PROFILE.duration || "1m";

export const options = baseOptions({
  scenarios: { default: applyRunOverrides(arrivalExecutor(RATE, DURATION)) },
});

export function setup() {
  const product = resolveProduct(CONFIG.endpoints?.perfProductSlug || "lt-flash-perf-item", 0);
  const sfSlug = resolveStorefrontSlug(1);
  console.log(product
    ? `[browse-arrival] LT product resolved: ${product.slug} (rate=${RATE}/s, duration=${DURATION})`
    : `[browse-arrival] LT perf product NOT resolved (seed may be pending) — degrading PDP/cart legs (rate=${RATE}/s, duration=${DURATION})`);
  return { product };
}

const vuIter = {};

export default function (data) {
  const vu = __VU;
  const iter = (vuIter[vu] = (vuIter[vu] || 0) + 1);
  const sess = loginShopper(vu, iter);
  browseLeg(vu, iter, sess, data.product, data.sfSlug);
  thinkTime();
}

export const handleSummary = makeSummaryHandler(`browse-arrival/${PROFILE_NAME}`);
