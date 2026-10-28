// ============================================================================
// LT-3 browse.js — CLOSED-model browsing journey (ramping-vus or constant-vus).
// Profile: smoke | baseline | ramp (see config.json profiles.*).
//
// Mix per iteration (task LT-3 spec):
//   30% GET /api/market/home
//   25% GET /api/market/products?search=<rotating terms>
//   20% product detail (one LT product resolved at setup via
//        /api/market/products?search=<perfProductSlug> → /api/sf/{store}/products/{slug})
//   10% GET /api/sf/lt-main-store (storefront)
//   10% GET /api/market/search/suggest?q=...
//    5% cart add + get (requires shopper login)
//
// RESILIENCE: if LT seed data is not present yet (LT-2 seeds in parallel), the
// product resolution returns null → PDP leg folds into search, cart leg folds
// into suggest; the run completes with reduced coverage instead of failing.
// Re-run after seeding to cover all legs.
//
// Run: LT_PROFILE=smoke k6 run scripts/loadtest/scenarios/browse.js
// ============================================================================

import {
  CONFIG, PROFILE_NAME, PROFILE, closedExecutor, applyRunOverrides, baseOptions,
  resolveProduct, resolveStorefrontSlug, browseLeg, loginShopper, thinkTime, makeSummaryHandler,
} from "./lib/common.js";

export const options = baseOptions({
  scenarios: { default: applyRunOverrides(closedExecutor(PROFILE)) },
});

export function setup() {
  const product = resolveProduct(CONFIG.endpoints?.perfProductSlug || "lt-flash-perf-item", 0);
  const sfSlug = resolveStorefrontSlug(1);
  console.log(product
    ? `[browse] LT product resolved: ${product.slug} variant=${product.variantId} stock=${product.stock}`
    : "[browse] LT perf product NOT resolved (seed may be pending) — PDP/cart legs degrade to search/suggest");
  console.log(sfSlug
    ? `[browse] storefront leg target: /api/sf/${sfSlug} (200-verified at setup)`
    : "[browse] no storefront returned 200 at setup — storefront leg degrades to search");
  return { product, sfSlug };
}

const vuIter = {}; // module state is per-VU in k6 → a private counter per VU

export default function (data) {
  const vu = __VU;
  const iter = (vuIter[vu] = (vuIter[vu] || 0) + 1);
  const sess = loginShopper(vu, iter); // cached per VU; null token → cart leg degrades
  browseLeg(vu, iter, sess, data.product, data.sfSlug);
  thinkTime();
}

export const handleSummary = makeSummaryHandler(`browse/${PROFILE_NAME}`);
