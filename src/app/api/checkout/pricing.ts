// ============================================================================
// Checkout pricing engine (shared by /api/checkout/quote and /api/checkout/create).
// Server-side recompute of unit prices, shipping, coupons — client totals NEVER trusted.
// ============================================================================
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";

export const FREE_SHIP_THRESHOLD_MINOR = 10000; // RM 100

export const SHIPPING_RATES: Record<string, { label: string; amountMinor: number; freeOverSubtotal: boolean }> = {
  standard: { label: "Standard (2-4 working days)", amountMinor: 800, freeOverSubtotal: true },
  express: { label: "Express (1-2 working days)", amountMinor: 1500, freeOverSubtotal: false },
};

export type QuoteItemInput = { variantId: string; qty: number };

export type PricedLine = {
  variantId: string;
  productId: string | null;
  categoryId: string | null;
  title: string;
  variantLabel: string | null;
  qty: number;
  unitPriceMinor: number;
  compareAtPriceMinor: number | null;
  lineTotalMinor: number;
  stock: number;
};

/** Validate + price cart items against a store. Throws ApiError on any invalid line. */
export async function priceItems(storeId: string, items: QuoteItemInput[]): Promise<PricedLine[]> {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, "EMPTY_CART", "At least one item is required");
  }
  const variantIds = items.map((i) => String(i.variantId));
  const variants = await db.productVariant.findMany({
    where: { id: { in: variantIds } },
    include: { product: { select: { id: true, title: true, status: true, storeId: true, categoryId: true } } },
  });
  const byId = new Map(variants.map((v) => [v.id, v]));
  const lines: PricedLine[] = [];
  for (const item of items) {
    const qty = Math.floor(Number(item.qty));
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new ApiError(400, "INVALID_QTY", "Quantity must be a positive integer");
    }
    const v = byId.get(String(item.variantId));
    if (!v || !v.isActive || v.product.status !== "active" || v.product.storeId !== storeId) {
      throw new ApiError(400, "VARIANT_INVALID", "One of the items is unavailable in this store");
    }
    const variantLabel = [v.optionName, v.optionValue].filter(Boolean).join(": ") || null;
    lines.push({
      variantId: v.id,
      productId: v.product.id,
      categoryId: v.product.categoryId,
      title: v.product.title,
      variantLabel,
      qty,
      unitPriceMinor: v.priceMinor,
      compareAtPriceMinor: v.compareAtPriceMinor ?? null,
      lineTotalMinor: v.priceMinor * qty,
      stock: v.stock,
    });
  }
  return lines;
}

export type CouponVerdict = {
  code: string;
  valid: boolean;
  reason?: string;
  discountMinor: number;
  freeShip: boolean;
  couponId: string | null;
};

/** Validate a coupon for a store + subtotal. Store coupons only valid for their store. */
export async function evaluateCoupon(
  storeId: string,
  rawCode: string | null | undefined,
  subtotalMinor: number,
  shippingMinor: number
): Promise<CouponVerdict> {
  const code = (rawCode ?? "").trim().toUpperCase();
  if (!code) return { code: "", valid: false, reason: "No coupon provided", discountMinor: 0, freeShip: false, couponId: null };
  const coupon = await db.coupon.findUnique({ where: { code } });
  if (!coupon || !coupon.isActive) return { code, valid: false, reason: "Coupon not found or inactive", discountMinor: 0, freeShip: false, couponId: null };
  if (coupon.scope === "store" && coupon.storeId !== storeId) {
    return { code, valid: false, reason: "Coupon not valid for this store", discountMinor: 0, freeShip: false, couponId: null };
  }
  const now = new Date();
  if (coupon.startsAt && coupon.startsAt > now) return { code, valid: false, reason: "Coupon not started yet", discountMinor: 0, freeShip: false, couponId: null };
  if (coupon.endsAt && coupon.endsAt < now) return { code, valid: false, reason: "Coupon expired", discountMinor: 0, freeShip: false, couponId: null };
  if (coupon.minSpendMinor > subtotalMinor) {
    return { code, valid: false, reason: `Minimum spend not met`, discountMinor: 0, freeShip: false, couponId: null };
  }
  if (coupon.maxRedemptions != null && coupon.timesUsed >= coupon.maxRedemptions) {
    return { code, valid: false, reason: "Coupon redemption limit reached", discountMinor: 0, freeShip: false, couponId: null };
  }
  let discountMinor = 0;
  let freeShip = false;
  if (coupon.type === "percent") {
    const percent = coupon.percent ?? 0;
    discountMinor = Math.floor((subtotalMinor * percent) / 100);
  } else if (coupon.type === "fixed") {
    discountMinor = Math.min(coupon.amountMinor ?? 0, subtotalMinor);
  } else if (coupon.type === "freeship") {
    freeShip = true;
    discountMinor = 0;
  }
  if (freeShip) shippingMinor = 0;
  return { code, valid: true, discountMinor, freeShip, couponId: coupon.id };
}

export type PricingResult = {
  lines: PricedLine[];
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  totalMinor: number;
  shippingRateId: string;
  coupon: CouponVerdict;
};

/** Full pricing pipeline: items + shipping + coupon → totals. */
export async function computePricing(input: {
  storeId: string;
  items: QuoteItemInput[];
  couponCode?: string | null;
  shippingRateId?: string | null;
}): Promise<PricingResult> {
  const lines = await priceItems(input.storeId, input.items);
  const subtotalMinor = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
  const rateId = input.shippingRateId && SHIPPING_RATES[input.shippingRateId] ? input.shippingRateId : "standard";
  let shippingMinor = SHIPPING_RATES[rateId].amountMinor;
  if (SHIPPING_RATES[rateId].freeOverSubtotal && subtotalMinor >= FREE_SHIP_THRESHOLD_MINOR) shippingMinor = 0;
  const coupon = await evaluateCoupon(input.storeId, input.couponCode ?? null, subtotalMinor, shippingMinor);
  if (coupon.freeShip) shippingMinor = 0;
  const discountMinor = Math.min(coupon.discountMinor, subtotalMinor);
  const totalMinor = Math.max(0, subtotalMinor - discountMinor + shippingMinor);
  return { lines, subtotalMinor, discountMinor, shippingMinor, totalMinor, shippingRateId: rateId, coupon };
}
