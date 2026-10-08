import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { computePricing } from "../pricing";
import { computeOrderCommissions } from "@/lib/commission";

export const dynamic = "force-dynamic";

// POST /api/checkout/quote {storeSlug, items:[{variantId, qty}], couponCode?, shippingRateId?}
export const POST = handle(async (req: Request) => {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const storeSlug = String(body.storeSlug ?? "");
  const store = await db.store.findUnique({ where: { slug: storeSlug } });
  if (!store || store.status !== "live") throw new ApiError(404, "STORE_NOT_FOUND", "Store not found");

  const pricing = await computePricing({
    storeId: store.id,
    items: (body.items ?? []) as { variantId: string; qty: number }[],
    couponCode: body.couponCode != null ? String(body.couponCode) : null,
    shippingRateId: body.shippingRateId != null ? String(body.shippingRateId) : null,
  });

  // Optional commission preview (percent parts only, no persistence).
  const seller = await db.seller.findUnique({ where: { id: store.sellerId }, select: { id: true } });
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
    })),
    commissionPreviewMinor,
  });
});
