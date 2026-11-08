import { handle, ok } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { getSession } from "@/lib/auth";
import { trackPdpEvent, isPdpEventType } from "@/lib/analytics/track";
import type { PdpEventBody, PdpEventData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/analytics/pdp-event — PDP conversion-funnel beacon (makeover
// Phase 7). Extends the existing seller-insights event system (same queue,
// same AnalyticsEvent table) with client-visible micro interactions the
// server cannot observe on its own: gallery swipes, variant picks, modal
// open/dismiss, qty changes, buy-now intent, begin_checkout, voucher claims.
//
// Design rules:
//  - NEVER throws for a bad payload — unknown event types are dropped with
//    {recorded:false} so a stale client can never error here.
//  - Guest-safe: no auth requirement (events carry the pseudonymous
//    visitor/session identity; shopperId attached opportunistically when a
//    session exists).
//  - Rate-limited per IP (generous: the PDP fires a handful of beacons per
//    interaction, not per frame).
//  - Advisory only — money/pricing/stock remain server-authoritative.
export const POST = handle(async (req: Request) => {
  rateLimit(req, "pdp-event", 120);
  const body = (await req.json().catch(() => ({}))) as PdpEventBody;

  const eventType = body.eventType;
  const storeId = typeof body.storeId === "string" ? body.storeId : null;
  if (!isPdpEventType(eventType) || !storeId) {
    const payload: PdpEventData = { recorded: false };
    return ok(payload);
  }

  const productId = typeof body.productId === "string" ? body.productId : null;
  const variantId = typeof body.variantId === "string" ? body.variantId : null;
  const qty = typeof body.qty === "number" && Number.isFinite(body.qty) ? Math.round(body.qty) : null;

  // Opportunistic identity enrichment — anonymous beacons stay anonymous.
  let shopperId: string | null = null;
  try {
    const session = await getSession();
    if (session?.userType === "shopper") shopperId = session.userId;
  } catch {
    /* stay anonymous */
  }

  await trackPdpEvent(req, { eventType, storeId, productId, variantId, qty, shopperId });
  const payload: PdpEventData = { recorded: true };
  return ok(payload);
});
