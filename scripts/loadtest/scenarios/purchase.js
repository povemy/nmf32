// ============================================================================
// LT-3 purchase.js — CLOSED-model purchase journey (the money path under load).
//
// Journey per iteration:
//   login (once per VU, cached) → POST /api/cart/items (perf item, qty 1)
//   → POST /api/checkout/create (unique Idempotency-Key:
//      `${vu}-${iter}-${timestamp}-${random}`) → POST payments/{ref}/simulate
//   {result:"succeeded"} → poll GET payments/{ref} until terminal (max 10
//   tries) → verify paid → orders_paid++ / order_e2e_ms.
//
// MIX: a configurable share (purchaseMix.checkoutSharePct, default 30%) of VUs
// runs the purchase journey; the rest run the browse mix (rule #5: report both
// the purchaser share and the browse background).
//
// RESILIENCE (clear failure counters, never silent): when LT seed data or the
// login is unavailable the leg counts purchase_skipped{reason} / auth_failures
// and continues — the run completes and the report shows the shortfall.
//
// Run: LT_PROFILE=purchase k6 run scripts/loadtest/scenarios/purchase.js
// ============================================================================

import {
  CONFIG, PROFILE_NAME, PROFILE, closedExecutor, applyRunOverrides, baseOptions,
  resolveProduct, resolveStorefrontSlug, browseLeg, loginShopper, thinkTime, checkoutJourney, makeSummaryHandler,
} from "./lib/common.js";

export const options = baseOptions({
  scenarios: { default: applyRunOverrides(closedExecutor(PROFILE)) },
});

export function setup() {
  const product = resolveProduct(CONFIG.endpoints?.perfProductSlug || "lt-flash-perf-item", 0);
  const sfSlug = resolveStorefrontSlug(1);
  console.log(product
    ? `[purchase] LT perf product resolved: ${product.slug} variant=${product.variantId} stock=${product.stock}`
    : "[purchase] LT perf product NOT resolved (seed pending) — purchase legs will count purchase_skipped{no-lt-product}");
  return { product };
}

const vuIter = {};
const sharePct = Number((CONFIG.purchaseMix && CONFIG.purchaseMix.checkoutSharePct) ?? 30);

/** Deterministic VU role split: VU 1..N — first sharePct% are purchasers. */
export function isPurchaser(vu) {
  return ((vu - 1) % 100) < sharePct;
}

export default function (data) {
  const vu = __VU;
  const iter = (vuIter[vu] = (vuIter[vu] || 0) + 1);
  const sess = loginShopper(vu, iter);

  if (isPurchaser(vu)) {
    checkoutJourney(vu, iter, sess, data.product);
  } else {
    browseLeg(vu, iter, sess, data.product, data.sfSlug);
  }
  thinkTime();
}

export const handleSummary = makeSummaryHandler(`purchase/${PROFILE_NAME}`);
