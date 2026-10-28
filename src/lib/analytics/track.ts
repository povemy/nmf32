// Seller Insights — event recording API (fire-and-forget, never throws).
//
// EVENT RULES (docs/seller-insights/metric-definitions.md):
//  - store_view:    once per (session, store) per 1-hour bucket. Client-side
//                   re-fetches within the hour dedup to a single event.
//  - product_view:  once per (session, product) per 1-hour bucket. Only the
//                   PDP payload route records views — catalogue grids and
//                   "related" products in the payload do NOT count.
//  - view_cart:     once per (cart, minute) — the shopper opened/refreshed a
//                   non-empty cart.
//  - add_to_cart:   one event per APPLIED cart transition (qty delta = post −
//                   pre, MOQ/stock caps included). A no-op add (capped to
//                   unchanged) records nothing.
//  - remove_from_cart: one event per removed line (qty = removed units).
//  - purchase / begin_checkout / refund are NOT events — they are derived from
//    authoritative Order/OrderItem/Refund records at query time.
import { resolveInsightsIdentity } from "./identity";
import { classifyReferrer } from "./referrer";
import { enqueueAnalyticsEvent } from "./queue";

function hourBucket(d = new Date()): string {
  return d.toISOString().slice(0, 13); // "2026-10-28T07" (UTC server time)
}
function minuteBucket(d = new Date()): string {
  return d.toISOString().slice(0, 16); // "2026-10-28T07:42"
}

async function base(
  req: Request,
  opts: { shopperId?: string | null } = {}
): Promise<{ visitorId: string; sessionId: string; shopperId: string | null; referrerHost: string | null; channel: string }> {
  const identity = await resolveInsightsIdentity();
  const ref = classifyReferrer(req);
  return {
    visitorId: identity.visitorId,
    sessionId: identity.sessionId,
    shopperId: opts.shopperId ?? null,
    referrerHost: ref.referrerHost,
    channel: ref.channel,
  };
}

/** Public storefront home viewed (call after the store `live` gate). */
export async function trackStoreView(req: Request, storeId: string): Promise<void> {
  try {
    const b = await base(req);
    enqueueAnalyticsEvent({
      dedupKey: `sv:${b.sessionId}:${storeId}:${hourBucket()}`,
      eventType: "store_view",
      storeId,
      visitorId: b.visitorId,
      sessionId: b.sessionId,
      referrerHost: b.referrerHost,
      channel: b.channel,
    });
  } catch { /* never break the host request */ }
}

/** Product detail page viewed (call after the product `active` gate). */
export async function trackProductView(req: Request, storeId: string, productId: string): Promise<void> {
  try {
    const b = await base(req);
    enqueueAnalyticsEvent({
      dedupKey: `pv:${b.sessionId}:${productId}:${hourBucket()}`,
      eventType: "product_view",
      storeId,
      productId,
      visitorId: b.visitorId,
      sessionId: b.sessionId,
      referrerHost: b.referrerHost,
      channel: b.channel,
    });
  } catch { /* never break the host request */ }
}

/** Non-empty cart opened/refreshed (call when the cart has ≥1 item).
 *  Multi-vendor: one event PER STORE present in the cart (per-store item count),
 *  so each seller sees their own cart-open activity. */
export async function trackViewCart(
  req: Request,
  cartId: string,
  stores: Array<{ storeId: string; itemCount: number }>,
  shopperId?: string | null
): Promise<void> {
  try {
    if (stores.length === 0) return;
    const b = await base(req, { shopperId });
    for (const s of stores) {
      if (s.itemCount <= 0) continue;
      enqueueAnalyticsEvent({
        dedupKey: `vc:${cartId}:${s.storeId}:${minuteBucket()}`,
        eventType: "view_cart",
        storeId: s.storeId,
        visitorId: b.visitorId,
        sessionId: b.sessionId,
        shopperId: shopperId ?? null,
        qty: s.itemCount,
      });
    }
  } catch { /* never break the host request */ }
}

/** Applied add-to-cart transition (post > pre). qty = post − pre (capped real delta). */
export async function trackAddToCart(input: {
  storeId: string;
  productId: string;
  variantId: string;
  cartItemId: string;
  preQty: number;
  postQty: number;
  shopperId: string;
}): Promise<void> {
  try {
    const delta = input.postQty - input.preQty;
    if (delta <= 0) return; // capped no-op — nothing was actually added
    enqueueAnalyticsEvent({
      dedupKey: `ac:${input.cartItemId}:${input.preQty}->${input.postQty}`,
      eventType: "add_to_cart",
      storeId: input.storeId,
      productId: input.productId,
      variantId: input.variantId,
      shopperId: input.shopperId,
      qty: delta,
    });
  } catch { /* never break the host request */ }
}

/** Cart line removed (DELETE or PATCH qty→0). qty = units removed. */
export async function trackRemoveFromCart(input: {
  storeId: string;
  productId: string;
  variantId: string;
  cartItemId: string;
  qty: number;
  shopperId: string;
}): Promise<void> {
  try {
    enqueueAnalyticsEvent({
      dedupKey: `rc:${input.cartItemId}:${input.qty}`,
      eventType: "remove_from_cart",
      storeId: input.storeId,
      productId: input.productId,
      variantId: input.variantId,
      shopperId: input.shopperId,
      qty: input.qty,
    });
  } catch { /* never break the host request */ }
}
