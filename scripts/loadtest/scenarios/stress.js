// ============================================================================
// LT-3 stress.js — stepped CLOSED ramp with hard VU cap + abort guardrails.
//
// Executor: ramping-vus from stress.stages (targets CLAMPED to stress.hardVuCap).
// Guardrails, rule #9 LAYER 1 (k6 thresholds, abortOnFail — latency + error
// rate are the ones k6 can observe; the app-side limits are LAYER 2, enforced
// by the coordinator watcher in run.ts which polls /api/metrics every 2s and
// SIGINTs this process when event-loop lag / heap / FD thresholds are crossed):
//   http_req_duration p(95) < stress.abort.httpP95Ms        (abortOnFail)
//   http_req_failed    rate < stress.abort.errorRatePct/100 (abortOnFail)
//   [coordinator] eventLoopLag.p95Ms > stress.abort.eventLoopLagMs → SIGINT
//   [coordinator] process.heapUsedMb > 80% of derived heap ceiling  → SIGINT
//   [coordinator] process.fdCount    > stress.abort.fdMax           → SIGINT
//
// Journey: the shared browse mix (browseLeg) — read-heavy background load up
// the ladder; the purchase path has its own scenarios (purchase.js/spike.js).
//
// Run: LT_PROFILE=stress k6 run scripts/loadtest/scenarios/stress.js
// ============================================================================

import {
  CONFIG, PROFILE_NAME, PROFILE, parseStages, applyRunOverrides, baseOptions, abortThresholds,
  resolveProduct, resolveStorefrontSlug, browseLeg, loginShopper, thinkTime, makeSummaryHandler,
} from "./lib/common.js";

function cappedStages() {
  const stages = parseStages(PROFILE.stages || []);
  const cap = Number(PROFILE.hardVuCap || 0);
  if (!cap) return stages;
  return stages.map((s) => (s.target > cap ? { target: cap, duration: s.duration } : s));
}

export const options = baseOptions({
  scenarios: {
    default: applyRunOverrides({ executor: "ramping-vus", startVUs: 1, stages: cappedStages(), gracefulStop: "10s" }),
  },
  thresholds: abortThresholds(),
});

export function setup() {
  const stages = cappedStages();
  const cap = Number(PROFILE.hardVuCap || 0);
  const clamped = (PROFILE.stages || []).some((s, i) => cap && parseStages([s])[0].target > cap);
  console.log(`[stress] stages: ${stages.map((s) => `${s.target}@${s.duration}`).join(" → ")} hardVuCap=${cap}${clamped ? " (targets clamped)" : ""}`);
  console.log(`[stress] abort thresholds (k6 layer): http p95<${(CONFIG.profiles.stress.abort || {}).httpP95Ms}ms, err<${(CONFIG.profiles.stress.abort || {}).errorRatePct}% (abortOnFail) — coordinator watcher enforces lag/heap/FD layer`);
  const product = resolveProduct(CONFIG.endpoints?.perfProductSlug || "lt-flash-perf-item", 0);
  const sfSlug = resolveStorefrontSlug(1);
  console.log(product ? `[stress] LT product resolved: ${product.slug}` : "[stress] LT perf product NOT resolved — PDP/cart legs degrade to search/suggest");
  console.log(sfSlug ? `[stress] storefront leg target: /api/sf/${sfSlug}` : "[stress] no storefront returned 200 — storefront leg degrades to search");
  return { product, sfSlug };
}

const vuIter = {};

export default function (data) {
  const vu = __VU;
  const iter = (vuIter[vu] = (vuIter[vu] || 0) + 1);
  const sess = loginShopper(vu, iter);
  browseLeg(vu, iter, sess, data.product, data.sfSlug);
  thinkTime();
}

export const handleSummary = makeSummaryHandler(`stress/${PROFILE_NAME}`);
