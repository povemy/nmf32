// ============================================================================
// LT-3 soak.js — OPEN-model endurance run: browse-arrival at soak.arrivalPerSec
// (default 20 journeys/s) for soak.duration (default 30m). Shares everything
// with browse-arrival.js; exists so the coordinator/report can label the run
// as a soak and so the executor config stays readable per profile.
//
// Run: LT_PROFILE=soak k6 run scripts/loadtest/scenarios/soak.js
// ============================================================================

import {
  CONFIG, PROFILE_NAME, PROFILE, arrivalExecutor, applyRunOverrides, baseOptions,
  resolveProduct, resolveStorefrontSlug, browseLeg, loginShopper, thinkTime, makeSummaryHandler,
} from "./lib/common.js";

const RATE = Number(PROFILE.arrivalPerSec || 20);
const DURATION = PROFILE.duration || "30m";

export const options = baseOptions({
  scenarios: { default: applyRunOverrides(arrivalExecutor(RATE, DURATION)) },
});

export function setup() {
  const product = resolveProduct(CONFIG.endpoints?.perfProductSlug || "lt-flash-perf-item", 0);
  const sfSlug = resolveStorefrontSlug(1);
  console.log(product
    ? `[soak] LT product resolved: ${product.slug} (rate=${RATE}/s, duration=${DURATION})`
    : `[soak] LT perf product NOT resolved (seed pending) — degrading PDP/cart legs (rate=${RATE}/s, duration=${DURATION})`);
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

export const handleSummary = makeSummaryHandler(`soak/${PROFILE_NAME}`);
