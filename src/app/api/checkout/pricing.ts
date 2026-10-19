// ============================================================================
// Checkout pricing engine (shared by /api/checkout/quote and /api/checkout/create).
// Server-side recompute of unit prices, shipping, coupons — client totals NEVER trusted.
// ============================================================================
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";

export const FREE_SHIP_THRESHOLD_MINOR = 10000; // RM 100

export const SHIPPING_RATES: Record<string, { label: string; eta: string; amountMinor: number; freeOverSubtotal: boolean }> = {
  standard: { label: "Standard", eta: "2-4 working days", amountMinor: 800, freeOverSubtotal: true },
  express: { label: "Express", eta: "1-2 working days", amountMinor: 1500, freeOverSubtotal: false },
};

// Express courier network does not cover East Malaysia — a real eligibility rule
// enforced server-side (quote marks availability, create refuses ineligible picks).
const EXPRESS_EXCLUDED_STATES = new Set(["Sabah", "Sarawak", "Labuan"]);

export type ShippingOptionT = {
  id: string;
  label: string;
  eta: string;
  amountMinor: number;
  freeShipping: boolean;
  available: boolean;
  reason: string | null;
};

/** Server-derived delivery options for a destination — the UI renders these, never its own constants. */
export function shippingOptionsFor(state: string | null | undefined, subtotalMinor: number): ShippingOptionT[] {
  const dest = (state ?? "").trim();
  return Object.entries(SHIPPING_RATES).map(([id, rate]) => {
    const ineligible = id === "express" && EXPRESS_EXCLUDED_STATES.has(dest);
    const freeShipping = rate.freeOverSubtotal && subtotalMinor >= FREE_SHIP_THRESHOLD_MINOR;
    return {
      id,
      label: rate.label,
      eta: rate.eta,
      amountMinor: freeShipping ? 0 : rate.amountMinor,
      freeShipping,
      available: !ineligible,
      reason: ineligible ? `Express delivery is not available to ${dest || "this destination"} — please choose Standard` : null,
    };
  });
}

/** Validate that a chosen rate is genuinely available for the destination. */
export function assertShippingAvailable(rateId: string, state: string | null | undefined): void {
  const dest = (state ?? "").trim();
  if (rateId === "express" && EXPRESS_EXCLUDED_STATES.has(dest)) {
    throw new ApiError(409, "SHIPPING_UNAVAILABLE", `Express delivery is not available to ${dest}. Please go back and choose Standard delivery.`);
  }
  if (!SHIPPING_RATES[rateId]) {
    throw new ApiError(400, "INVALID_SHIPPING", "Unknown delivery method");
  }
}

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
  moq: number;
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
    // NOTE: MOQ is deliberately NOT hard-thrown here — quotes stay renderable
    // so the checkout UI can show a persistent "seller minimum" warning (same
    // pattern as the oversell warning). The AUTHORITATIVE MOQ gate lives in
    // checkout/create's transaction.
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
      moq: Math.max(1, v.moq),
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
  shippingOptions: ShippingOptionT[];
  coupon: CouponVerdict;
};

/** Full pricing pipeline: items + shipping + coupon → totals. */
export async function computePricing(input: {
  storeId: string;
  items: QuoteItemInput[];
  couponCode?: string | null;
  shippingRateId?: string | null;
  state?: string | null;
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
  const shippingOptions = shippingOptionsFor(input.state, subtotalMinor);
  return { lines, subtotalMinor, discountMinor, shippingMinor, totalMinor, shippingRateId: rateId, shippingOptions, coupon };
}

// ---------------------------------------------------------------------------
// OPTION A — MULTI-SELLER GROUP PRICING
// One cart can hold items from many stores. Each store becomes its own parcel
// with its own subtotal + shipping; the buyer still pays ONCE (the group total).
// ---------------------------------------------------------------------------

export type PricedStoreGroup = {
  storeId: string;
  storeSlug: string;
  storeName: string;
  sellerId: string | null; // generated-but-unclaimed stores have no owner yet
  currency: string;
  lines: PricedLine[];
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  totalMinor: number;
  coupon: CouponVerdict; // verdict that applied to THIS group (invalid sentinel otherwise)
};

export type GroupPricingResult = {
  groups: PricedStoreGroup[];
  items: (PricedLine & { storeId: string; storeSlug: string; storeName: string })[];
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  totalMinor: number;
  shippingRateId: string;
  shippingOptions: ShippingOptionT[];
  coupon: CouponVerdict; // verdict of the requested coupon, for UI messaging
};

/** Multi-store pricing: validate all lines, group per store, price each group
 *  (per-store free-shipping threshold + per-store coupon rules), aggregate. */
export async function computeGroupPricing(input: {
  items: QuoteItemInput[];
  couponCode?: string | null;
  shippingRateId?: string | null;
  state?: string | null;
}): Promise<GroupPricingResult> {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError(400, "EMPTY_CART", "At least one item is required");
  }
  const variantIds = input.items.map((i) => String(i.variantId));
  const variants = await db.productVariant.findMany({
    where: { id: { in: variantIds } },
    include: {
      product: {
        select: {
          id: true, title: true, status: true, storeId: true, categoryId: true,
          store: { select: { id: true, slug: true, name: true, status: true } },
        },
      },
    },
  });
  const byId = new Map(variants.map((v) => [v.id, v]));

  const items: (PricedLine & { storeId: string; storeSlug: string; storeName: string })[] = [];
  for (const item of input.items) {
    const qty = Math.floor(Number(item.qty));
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new ApiError(400, "INVALID_QTY", "Quantity must be a positive integer");
    }
    const v = byId.get(String(item.variantId));
    if (!v || !v.isActive || v.product.status !== "active" || v.product.store.status !== "live") {
      throw new ApiError(400, "VARIANT_INVALID", "One of the items is no longer available — please update your cart");
    }
    // Seller's minimum order quantity rides on the line (moq) so the checkout
    // UI can warn and block pre-payment; the HARD gate is checkout/create's
    // transaction (qty below moq can never become an order).
    const variantLabel = [v.optionName, v.optionValue].filter(Boolean).join(": ") || null;
    items.push({
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
      moq: Math.max(1, v.moq),
      storeId: v.product.storeId,
      storeSlug: v.product.store.slug,
      storeName: v.product.store.name,
    });
  }

  // Group lines per store.
  const byStore = new Map<string, PricedLine[]>();
  for (const l of items) {
    const { storeId: _s, storeSlug: _sl, storeName: _sn, ...line } = l;
    const arr = byStore.get(l.storeId);
    if (arr) arr.push(line);
    else byStore.set(l.storeId, [line]);
  }

  const storeRows = await db.store.findMany({
    where: { id: { in: [...byStore.keys()] } },
    select: { id: true, slug: true, name: true, sellerId: true, currency: true, status: true },
  });
  const storeMeta = new Map(storeRows.map((s) => [s.id, s]));

  const rawGroups = [...byStore.entries()].map(([storeId, lines]) => {
    const meta = storeMeta.get(storeId);
    if (!meta || meta.status !== "live") {
      throw new ApiError(400, "STORE_UNAVAILABLE", `One of the sellers in your cart is currently unavailable — please remove those items to continue`);
    }
    return {
      storeId,
      storeSlug: meta.slug,
      storeName: meta.name,
      sellerId: meta.sellerId,
      currency: meta.currency,
      lines,
      subtotalMinor: lines.reduce((s, l) => s + l.lineTotalMinor, 0),
    };
  });

  const rateId = input.shippingRateId && SHIPPING_RATES[input.shippingRateId] ? input.shippingRateId : "standard";
  const state = (input.state ?? "").trim();

  // A coupon applies to exactly ONE seller group (highest subtotal among the
  // eligible ones) so a platform-wide code can never be multiplied per seller.
  let winning: CouponVerdict | null = null;
  let uiVerdict: CouponVerdict | null = null;
  let couponTarget: string | null = null;
  if ((input.couponCode ?? "").trim()) {
    const sorted = [...rawGroups].sort((a, b) => b.subtotalMinor - a.subtotalMinor);
    for (const g of sorted) {
      const ship = SHIPPING_RATES[rateId].freeOverSubtotal && g.subtotalMinor >= FREE_SHIP_THRESHOLD_MINOR ? 0 : SHIPPING_RATES[rateId].amountMinor;
      const verdict = await evaluateCoupon(g.storeId, input.couponCode, g.subtotalMinor, ship);
      uiVerdict = uiVerdict ?? verdict;
      if (verdict.valid) {
        winning = verdict;
        couponTarget = g.storeId;
        break;
      }
    }
  }

  const groups: PricedStoreGroup[] = rawGroups.map((g) => {
    let shippingMinor = SHIPPING_RATES[rateId].freeOverSubtotal && g.subtotalMinor >= FREE_SHIP_THRESHOLD_MINOR ? 0 : SHIPPING_RATES[rateId].amountMinor;
    let discountMinor = 0;
    let coupon: CouponVerdict = { code: input.couponCode ?? "", valid: false, reason: "Not applied to this seller", discountMinor: 0, freeShip: false, couponId: null };
    if (winning && couponTarget === g.storeId) {
      discountMinor = Math.min(winning.discountMinor, g.subtotalMinor);
      if (winning.freeShip) shippingMinor = 0;
      coupon = winning;
    }
    const totalMinor = Math.max(0, g.subtotalMinor - discountMinor + shippingMinor);
    return {
      storeId: g.storeId,
      storeSlug: g.storeSlug,
      storeName: g.storeName,
      sellerId: g.sellerId,
      currency: g.currency,
      lines: g.lines,
      subtotalMinor: g.subtotalMinor,
      discountMinor,
      shippingMinor,
      totalMinor,
      coupon,
    };
  });

  const sum = (fn: (g: PricedStoreGroup) => number) => groups.reduce((s, g) => s + fn(g), 0);
  const subtotalMinor = sum((g) => g.subtotalMinor);
  const discountMinor = sum((g) => g.discountMinor);
  const shippingMinor = sum((g) => g.shippingMinor);

  // Delivery options are shown ONCE with the aggregate parcel cost for this rate.
  const shippingOptions: ShippingOptionT[] = Object.entries(SHIPPING_RATES).map(([id, rate]) => {
    const ineligible = id === "express" && EXPRESS_EXCLUDED_STATES.has(state);
    let amountMinor = 0;
    for (const g of rawGroups) {
      if (!(rate.freeOverSubtotal && g.subtotalMinor >= FREE_SHIP_THRESHOLD_MINOR)) amountMinor += rate.amountMinor;
    }
    const selected = id === rateId;
    return {
      id,
      label: rate.label,
      eta: rate.eta,
      amountMinor: selected ? shippingMinor : amountMinor,
      freeShipping: selected ? shippingMinor === 0 : amountMinor === 0,
      available: !ineligible,
      reason: ineligible ? `Express delivery is not available to ${state || "this destination"} — please choose Standard` : null,
    };
  });

  return {
    groups,
    items,
    subtotalMinor,
    discountMinor,
    shippingMinor,
    totalMinor: Math.max(0, subtotalMinor - discountMinor + shippingMinor),
    shippingRateId: rateId,
    shippingOptions,
    coupon: uiVerdict ?? { code: input.couponCode ?? "", valid: false, reason: "No coupon provided", discountMinor: 0, freeShip: false, couponId: null },
  };
}
