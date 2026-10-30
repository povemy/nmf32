import { handle, ok, ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { requireActiveSellerStore } from "@/lib/auth";
import { getAffiliateSettings } from "@/lib/affiliate";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// PATCH /api/store/affiliate/products/[id] — enroll/pause a product + set its
// per-product rate override (spec §7). Ownership enforced (seller A can never
// touch seller B's products). Rate clamped to the platform max. Changes apply
// to FUTURE orders only — frozen OrderItem snapshots are never recalculated.
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  rateLimit(req, "store-affiliate-product", 60);
  const { store } = await requireActiveSellerStore();
  const settings = await getAffiliateSettings();
  const { id } = await ctx.params;
  const product = await db.product.findFirst({ where: { id, storeId: store.id } });
  if (!product) throw new ApiError(404, "NOT_FOUND", "Product not found in your store");
  if (!settings.enabled) throw new ApiError(403, "AFFILIATE_DISABLED", "The affiliate programme is currently paused platform-wide");

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  if (body.enabled != null) {
    if (body.enabled === true && !store.affiliateOptIn) {
      throw new ApiError(400, "STORE_NOT_ENROLLED", "Enable the affiliate programme for your store first");
    }
    data.affiliateEnabled = body.enabled === true;
  }
  if (body.rateBps !== undefined) {
    if (body.rateBps === null) {
      data.affiliateRateBps = null; // back to the store default
    } else {
      const rate = Math.round(Number(body.rateBps));
      if (!Number.isFinite(rate) || rate < 0 || rate > settings.maxRateBps) {
        throw new ApiError(400, "VALIDATION", `rateBps must be 0-${settings.maxRateBps}`);
      }
      data.affiliateRateBps = rate;
    }
  }
  const updated = await db.product.update({ where: { id: product.id }, data });
  return ok({
    id: updated.id,
    affiliateEnabled: updated.affiliateEnabled,
    affiliateRateBps: updated.affiliateRateBps,
    effectiveRateBps: Math.min(updated.affiliateRateBps ?? store.affiliateDefaultRateBps, settings.maxRateBps),
  });
});
