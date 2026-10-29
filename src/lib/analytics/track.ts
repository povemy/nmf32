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
import { resolveAttribution, channelFromAttribution, type Attribution } from "./attribution";

function hourBucket(d = new Date()): string {
  return d.toISOString().slice(0, 13); // "2026-10-28T07" (UTC server time)
}
function minuteBucket(d = new Date()): string {
  return d.toISOString().slice(0, 16); // "2026-10-28T07:42"
}

/** Attribution fields attached to an event row (validated + clamped upstream). */
function attrFields(attr: Attribution | null) {
  return {
    campaignId: attr?.campaignId ?? null,
    utmSource: attr?.utmSource ?? null,
    utmMedium: attr?.utmMedium ?? null,
    utmCampaign: attr?.utmCampaign ?? null,
    utmTerm: attr?.utmTerm ?? null,
    utmContent: attr?.utmContent ?? null,
  };
}

async function base(
  req: Request,
  opts: { shopperId?: string | null } = {}
): Promise<{ visitorId: string; sessionId: string; shopperId: string | null; referrerHost: string | null; channel: string; attr: Attribution | null }> {
  const identity = await resolveInsightsIdentity();
  const ref = classifyReferrer(req);
  const attr = await resolveAttribution();
  // Tagged visits classify their channel from the validated utm_source (the
  // SPA's same-origin fetches make the Referer useless for external landings);
  // untagged traffic keeps the legacy referrer classification.
  const channel = channelFromAttribution(attr) ?? ref.channel;
  return {
    visitorId: identity.visitorId,
    sessionId: identity.sessionId,
    shopperId: opts.shopperId ?? null,
    referrerHost: ref.referrerHost,
    channel,
    attr,
  };
}

/** Public storefront home viewed (call after the store `live` gate). */
export async function trackStoreView(req: Request, storeId: string): Promise<void> {
  try {
    const b = await base(req);
    // Dedup: once per (session, store, hour) for UNTAGGED traffic — refreshes
    // collapse. A landing attributed to a DIFFERENT campaign is a distinct
    // traffic event and gets its own row (the campaign suffix keeps same-
    // campaign refreshes deduped while different-campaign landings within the
    // same session+hour are each counted for their own campaign).
    const campaignSuffix = b.attr?.campaignId ? `:c${b.attr.campaignId}` : "";
    enqueueAnalyticsEvent({
      dedupKey: `sv:${b.sessionId}:${storeId}:${hourBucket()}${campaignSuffix}`,
      eventType: "store_view",
      storeId,
      visitorId: b.visitorId,
      sessionId: b.sessionId,
      referrerHost: b.referrerHost,
      channel: b.channel,
      ...attrFields(b.attr),
    });
  } catch { /* never break the host request */ }
}

/** Product detail page viewed (call after the product `active` gate). */
export async function trackProductView(req: Request, storeId: string, productId: string): Promise<void> {
  try {
    const b = await base(req);
    // Same campaign-suffix dedup rule as store_view: a re-view of the same
    // product within the hour under a DIFFERENT campaign attribution is a
    // distinct attributed view; same-campaign refreshes still collapse.
    const campaignSuffix = b.attr?.campaignId ? `:c${b.attr.campaignId}` : "";
    enqueueAnalyticsEvent({
      dedupKey: `pv:${b.sessionId}:${productId}:${hourBucket()}${campaignSuffix}`,
      eventType: "product_view",
      storeId,
      productId,
      visitorId: b.visitorId,
      sessionId: b.sessionId,
      referrerHost: b.referrerHost,
      channel: b.channel,
      ...attrFields(b.attr),
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
        ...attrFields(b.attr),
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
    // Fire-and-forget context: cookies() resolves from the request's async
    // context (captured at call time); any failure → untagged event.
    const attr = await resolveAttribution().catch(() => null);
    enqueueAnalyticsEvent({
      dedupKey: `ac:${input.cartItemId}:${input.preQty}->${input.postQty}`,
      eventType: "add_to_cart",
      storeId: input.storeId,
      productId: input.productId,
      variantId: input.variantId,
      shopperId: input.shopperId,
      qty: delta,
      ...attrFields(attr),
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
    const attr = await resolveAttribution().catch(() => null);
    enqueueAnalyticsEvent({
      dedupKey: `rc:${input.cartItemId}:${input.qty}`,
      eventType: "remove_from_cart",
      storeId: input.storeId,
      productId: input.productId,
      variantId: input.variantId,
      shopperId: input.shopperId,
      qty: input.qty,
      ...attrFields(attr),
    });
  } catch { /* never break the host request */ }
}
