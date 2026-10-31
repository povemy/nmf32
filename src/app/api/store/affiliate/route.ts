import { handle, ok, ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { requireActiveSellerStore } from "@/lib/auth";
import { getAffiliateSettings, effectiveAffiliateRateBps } from "@/lib/affiliate";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// GET /api/store/affiliate — the seller's programme state + summary.
export const GET = handle(async () => {
  const { store } = await requireActiveSellerStore();
  const settings = await getAffiliateSettings();
  const enrolled = await db.product.count({ where: { storeId: store.id, affiliateEnabled: true } });
  const total = await db.product.count({ where: { storeId: store.id } });
  return ok({
    programmeEnabled: settings.enabled,
    maxRateBps: settings.maxRateBps,
    optIn: store.affiliateOptIn,
    defaultRateBps: store.affiliateDefaultRateBps,
    enrolledProducts: enrolled,
    totalProducts: total,
  });
});

// PATCH /api/store/affiliate — programme opt-in/out + default rate (spec §7).
// Rate changes apply to FUTURE orders only — every OrderItem keeps its frozen
// snapshot; historic orders are never recalculated.
export const PATCH = handle(async (req: Request) => {
  rateLimit(req, "store-affiliate-settings", 20);
  const { store } = await requireActiveSellerStore();
  const settings = await getAffiliateSettings();
  if (!settings.enabled) throw new ApiError(403, "AFFILIATE_DISABLED", "The affiliate programme is currently paused platform-wide");
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  if (body.optIn != null) data.affiliateOptIn = body.optIn === true;
  if (body.defaultRateBps != null) {
    const rate = Math.round(Number(body.defaultRateBps));
    if (!Number.isFinite(rate) || rate < 0 || rate > settings.maxRateBps) {
      throw new ApiError(400, "VALIDATION", `defaultRateBps must be 0-${settings.maxRateBps}`);
    }
    data.affiliateDefaultRateBps = rate;
  }
  const updated = await db.store.update({ where: { id: store.id }, data });
  return ok({
    optIn: updated.affiliateOptIn,
    defaultRateBps: updated.affiliateDefaultRateBps,
    maxRateBps: settings.maxRateBps,
  });
});
