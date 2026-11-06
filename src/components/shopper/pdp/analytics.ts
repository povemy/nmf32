"use client";
// ============================================================================
// PDP makeover — client funnel beacon (Phase 7). Fire-and-forget POSTs to
// /api/analytics/pdp-event, which extends the EXISTING seller-insights event
// system server-side. Never blocks, never throws, never retries — analytics
// must not be able to break the purchase journey.
// ============================================================================
import { deviceHeaders } from "@/lib/session-client";
import type { PdpEventType } from "@/lib/analytics/track";

let beaconCtx: { storeId: string; productId: string | null } | null = null;

/** Stamp the current PDP context so individual call sites stay terse. */
export function setPdpAnalyticsContext(storeId: string, productId: string | null) {
  beaconCtx = { storeId, productId };
}

export function pdpTrack(
  eventType: PdpEventType,
  opts: { variantId?: string | null; qty?: number | null; productId?: string | null } = {}
) {
  try {
    const ctx = beaconCtx ?? { storeId: "", productId: null as string | null };
    if (!ctx.storeId) return; // no context yet — nothing to attribute
    const body = JSON.stringify({
      eventType,
      storeId: ctx.storeId,
      productId: opts.productId ?? ctx.productId,
      variantId: opts.variantId ?? null,
      qty: opts.qty ?? null,
    });
    // keepalive lets the beacon survive an immediate navigation (Buy Now →
    // checkout view swap) just like the landing attribution beacon.
    void fetch("/api/analytics/pdp-event", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deviceHeaders() },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never break UX for analytics */
  }
}
