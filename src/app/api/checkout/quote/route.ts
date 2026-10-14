import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { computePricing, computeGroupPricing } from "../pricing";
import { computeOrderCommissions } from "@/lib/commission";

export const dynamic = "force-dynamic";

// POST /api/checkout/quote
//  • {storeSlug, items, ...}          → LEGACY single-store quote (kept for compatibility)
//  • {items, couponCode?, ...}        → OPTION A multi-seller quote: one section per store,
//    per-store shipping + coupon rules, ONE aggregated total (the buyer pays once).
export const POST = handle(async (req: Request) => {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // ------------------------------------------------------------------ legacy single-store
  const storeSlug = String(body.storeSlug ?? "");
  if (storeSlug) {
    const store = await db.store.findUnique({ where: { slug: storeSlug } });
    if (!store || store.status !== "live") throw new ApiError(404, "STORE_NOT_FOUND", "Store not found");

    const pricing = await computePricing({
      storeId: store.id,
      items: (body.items ?? []) as { variantId: string; qty: number }[],
      couponCode: body.couponCode != null ? String(body.couponCode) : null,
      shippingRateId: body.shippingRateId != null ? String(body.shippingRateId) : null,
      state: body.state != null ? String(body.state) : null,
    });

    const seller = store.sellerId
      ? await db.seller.findUnique({ where: { id: store.sellerId }, select: { id: true } })
      : null;
    let commissionPreviewMinor = 0;
    if (seller) {
      const comm = await computeOrderCommissions({
        sellerId: seller.id,
        items: pricing.lines.map((l) => ({
          productId: l.productId,
          categoryId: l.categoryId,
          title: l.title,
          variantLabel: l.variantLabel,
          unitPriceMinor: l.unitPriceMinor,
          qty: l.qty,
        })),
        orderDiscountMinor: pricing.discountMinor,
        shippingMinorTotal: pricing.shippingMinor,
      });
      commissionPreviewMinor = comm.items.reduce((s, i) => s + i.percentPartMinor, 0);
    }

    return ok({
      subtotalMinor: pricing.subtotalMinor,
      discountMinor: pricing.discountMinor,
      shippingMinor: pricing.shippingMinor,
      totalMinor: pricing.totalMinor,
      shippingRateId: pricing.shippingRateId,
      coupon: pricing.coupon.valid
        ? { code: pricing.coupon.code, valid: true, discountMinor: pricing.coupon.discountMinor, freeShip: pricing.coupon.freeShip }
        : { code: pricing.coupon.code, valid: false, reason: pricing.coupon.reason ?? "Invalid coupon" },
      items: pricing.lines.map((l) => ({
        title: l.title,
        variantLabel: l.variantLabel,
        qty: l.qty,
        unitPriceMinor: l.unitPriceMinor,
        lineTotalMinor: l.lineTotalMinor,
        stock: l.stock,
      })),
      shippingOptions: pricing.shippingOptions,
      commissionPreviewMinor,
    });
  }

  // ------------------------------------------------------------------ OPTION A multi-seller
  const pricing = await computeGroupPricing({
    items: (body.items ?? []) as { variantId: string; qty: number }[],
    couponCode: body.couponCode != null ? String(body.couponCode) : null,
    shippingRateId: body.shippingRateId != null ? String(body.shippingRateId) : null,
    state: body.state != null ? String(body.state) : null,
  });

  return ok({
    subtotalMinor: pricing.subtotalMinor,
    discountMinor: pricing.discountMinor,
    shippingMinor: pricing.shippingMinor,
    totalMinor: pricing.totalMinor,
    shippingRateId: pricing.shippingRateId,
    coupon: pricing.coupon.valid
      ? { code: pricing.coupon.code, valid: true, discountMinor: pricing.coupon.discountMinor, freeShip: pricing.coupon.freeShip }
      : { code: pricing.coupon.code, valid: false, reason: pricing.coupon.reason ?? "Invalid coupon" },
    items: pricing.items.map((l) => ({
      title: l.title,
      variantLabel: l.variantLabel,
      qty: l.qty,
      unitPriceMinor: l.unitPriceMinor,
      lineTotalMinor: l.lineTotalMinor,
      stock: l.stock,
      storeId: l.storeId,
      storeSlug: l.storeSlug,
      storeName: l.storeName,
    })),
    groups: pricing.groups.map((g) => ({
      storeId: g.storeId,
      storeSlug: g.storeSlug,
      storeName: g.storeName,
      subtotalMinor: g.subtotalMinor,
      discountMinor: g.discountMinor,
      shippingMinor: g.shippingMinor,
      totalMinor: g.totalMinor,
      itemCount: g.lines.length,
      couponApplied: g.coupon.valid,
    })),
    shippingOptions: pricing.shippingOptions,
  });
});
