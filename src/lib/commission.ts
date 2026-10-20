// ============================================================================
// M09 COMMISSION ENGINE — full spec implementation (PART 3 M09)
// Resolution priority: fee holiday > product override > category ancestor >
// seller override > global default. Money math in integer minor units.
// Commission snapshots are stored per order_item and NEVER recomputed.
// ============================================================================
import { db } from "./db";
import { commissionOf, allocateProportionally } from "./money";
import { toJson } from "./json";

export type CommissionSettingsDTO = {
  defaultPercent: number;
  appliesToShipping: boolean;
  basePriceRule: "paid_price" | "list_price";
  fixedFeeMinor: number;
  minCommissionMinor: number;
  payoutHoldDays: number;
  holdReleaseRule: "days_after_paid" | "days_after_delivered";
  graceDaysAfterDelivered: number;
};

export async function getCommissionSettings(): Promise<CommissionSettingsDTO> {
  const s = await db.commissionSetting.findUnique({ where: { id: 1 } });
  if (!s) {
    // auto-create singleton
    const created = await db.commissionSetting.create({ data: { id: 1 } });
    return created as unknown as CommissionSettingsDTO;
  }
  return s as unknown as CommissionSettingsDTO;
}

type RateResolution = {
  percent: number;
  source: "fee_holiday" | "product" | "category" | "seller" | "global";
  sourceId?: string;
  holidayId?: string;
  holdDays: number;
  fixedFeeMinor: number;
};

async function categoryAncestorChain(categoryId: string | null | undefined): Promise<string[]> {
  // returns [category, parent, grandparent, ...]
  const chain: string[] = [];
  let cur = categoryId ?? null;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    const cat = await db.category.findUnique({ where: { id: cur }, select: { parentId: true } });
    cur = cat?.parentId ?? null;
  }
  return chain;
}

/** Resolve the effective commission rate for an item in context (M09 resolution). */
export async function resolveRate(ctx: {
  sellerId: string;
  categoryId?: string | null;
  productId?: string | null;
  now?: Date;
}): Promise<RateResolution> {
  const settings = await getCommissionSettings();
  const now = ctx.now ?? new Date();
  let fallback: RateResolution = {
    percent: settings.defaultPercent,
    source: "global",
    holdDays: settings.payoutHoldDays,
    fixedFeeMinor: settings.fixedFeeMinor,
  };

  // 0. seller-level hold override
  const seller = await db.seller.findUnique({
    where: { id: ctx.sellerId },
    select: { commissionOverridePercent: true, holdDaysOverride: true },
  });
  if (seller?.holdDaysOverride != null) fallback = { ...fallback, holdDays: seller.holdDaysOverride };

  // 1. active fee holiday covering (seller, category, now)
  const holidays = await db.feeHoliday.findMany({
    where: { isActive: true, startsAt: { lte: now }, endsAt: { gte: now } },
    orderBy: { startsAt: "asc" },
  });
  for (const h of holidays) {
    if (h.scope === "all") {
      return { ...fallback, percent: 0, source: "fee_holiday", holidayId: h.id };
    }
    const ids = JSON.parse(h.scopeIds || "[]") as string[];
    if (h.scope === "sellers" && ids.includes(ctx.sellerId)) {
      return { ...fallback, percent: 0, source: "fee_holiday", holidayId: h.id };
    }
    if (h.scope === "categories" && ctx.categoryId && ids.includes(ctx.categoryId)) {
      return { ...fallback, percent: 0, source: "fee_holiday", holidayId: h.id };
    }
  }

  // 2. product override
  if (ctx.productId) {
    const p = await db.product.findUnique({
      where: { id: ctx.productId },
      select: { commissionPercentOverride: true },
    });
    if (p?.commissionPercentOverride != null) {
      return { ...fallback, percent: p.commissionPercentOverride, source: "product", sourceId: ctx.productId };
    }
  }

  // 3. nearest category ancestor with commission_percent
  const chain = await categoryAncestorChain(ctx.categoryId);
  for (const catId of chain) {
    const cat = await db.category.findUnique({ where: { id: catId }, select: { commissionPercent: true } });
    if (cat?.commissionPercent != null) {
      return { ...fallback, percent: cat.commissionPercent, source: "category", sourceId: catId };
    }
  }

  // 4. seller override
  if (seller?.commissionOverridePercent != null) {
    return { ...fallback, percent: seller.commissionOverridePercent, source: "seller", sourceId: ctx.sellerId };
  }

  // 5. global default
  return fallback;
}

export type CommissionItemInput = {
  productId?: string | null;
  categoryId?: string | null;
  variantLabel?: string | null;
  title: string;
  unitPriceMinor: number;
  qty: number;
  /** list subtotal = unitPrice * qty (before discount) */
};

export type CommissionItemResult = {
  title: string;
  variantLabel?: string | null;
  unitPriceMinor: number;
  qty: number;
  lineSubtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  baseMinor: number;
  percent: number;
  percentPartMinor: number;
  fixedFeeMinor: number;
  commissionMinor: number;
  sellerNetMinor: number;
  breakdown: {
    rule_source: string;
    source_id?: string;
    holiday_id?: string;
    percent: number;
    base: number;
    percent_part: number;
    fixed_fee_allocated: number;
    discount_allocated: number;
    shipping_allocated: number;
    flags: string[];
  };
};

export type CommissionOrderResult = {
  items: CommissionItemResult[];
  orderCommissionMinor: number;
  orderSellerNetMinor: number;
  holdDays: number;
  holdReleaseRule: string;
};

/**
 * INVARIANT (Option B mirror requirement — FIN-1):
 *   sum(item.sellerNetMinor) + sum(item.commissionMinor) === order.totalMinor
 * for EVERY order, where totalMinor = subtotalMinor − discountMinor +
 * shippingMinor + taxMinor. The ledger T1 (postOrderPaid) debits the PSP
 * gateway totalMinor and credits exactly sellerNet + commission, so any drift
 * here would throw LEDGER_UNBALANCED at payment time. The customer-paid gross
 * per item is (lineSubtotal − discount + shipping + tax allocations); seller
 * net is that gross MINUS commission — never gross-plus-shipping again (the
 * pre-FIN-1 formula double-counted shipping when appliesToShipping=true).
 */
export function reconcileSplits(
  items: { sellerNetMinor: number; commissionMinor: number; lineSubtotalMinor: number }[],
  totalMinor: number
): { items: { sellerNetMinor: number; commissionMinor: number; lineSubtotalMinor: number }[]; driftMinor: number } {
  const sumNet = items.reduce((s, r) => s + r.sellerNetMinor, 0);
  const sumComm = items.reduce((s, r) => s + r.commissionMinor, 0);
  const drift = totalMinor - (sumNet + sumComm);
  if (drift === 0 || items.length === 0) return { items, driftMinor: 0 };
  // Deterministic remainder handling: assign the whole drift to the LARGEST
  // line (same tie-break family as allocateProportionally: value desc, then
  // original order) so the split reconciles EXACTLY to the order total.
  let maxIdx = 0;
  for (let i = 1; i < items.length; i++) {
    if (items[i].lineSubtotalMinor > items[maxIdx].lineSubtotalMinor) maxIdx = i;
  }
  const adjusted = items.map((r, i) => (i === maxIdx ? { ...r, sellerNetMinor: r.sellerNetMinor + drift } : r));
  return { items: adjusted, driftMinor: drift };
}

/**
 * Compute per-item commission snapshots for an order (M09 BASE + MATH).
 * - orderDiscount allocated proportionally to line subtotals (remainder to highest-value line)
 * - shipping allocated proportionally (or 0 if not applicable per line config)
 * - commission = round_half_up(base * percent/100) + allocated fixed fee
 * - sellerNet = (subtotal − discount + shipping + tax) − commission per item —
 *   the Option B invariant sum(sellerNet)+sum(commission)===order total holds
 *   in ALL paths, including appliesToShipping=true (see reconcileSplits doc).
 * - min_commission_minor floored per ORDER (skipped on fee holidays, flagged)
 */
export async function computeOrderCommissions(input: {
  sellerId: string;
  items: CommissionItemInput[];
  orderDiscountMinor: number;
  shippingMinorTotal: number;
  /** Order-level tax (currently always 0 in checkout pricing) — included in
   *  the sellerNet reconciliation so the invariant survives tax going live. */
  orderTaxMinor?: number;
  appliesShippingToItem?: boolean; // whether shipping counts toward commission base
  currency?: string;
  now?: Date;
}): Promise<CommissionOrderResult> {
  const settings = await getCommissionSettings();
  const now = input.now ?? new Date();

  const subtotals = input.items.map((it) => it.unitPriceMinor * it.qty);
  const discounts = allocateProportionally(Math.max(0, input.orderDiscountMinor), subtotals);
  const shippingAlloc = allocateProportionally(Math.max(0, input.shippingMinorTotal), subtotals);
  const taxAlloc = allocateProportionally(Math.max(0, input.orderTaxMinor ?? 0), subtotals);

  // resolve rate per item (cache by productId/categoryId pair)
  const rates: RateResolution[] = [];
  for (const it of input.items) {
    const r = await resolveRate({
      sellerId: input.sellerId,
      categoryId: it.categoryId ?? null,
      productId: it.productId ?? null,
      now,
    });
    rates.push(r);
  }

  const perOrderFixed = settings.fixedFeeMinor;
  const fixedAlloc = allocateProportionally(perOrderFixed, subtotals);

  const results: CommissionItemResult[] = input.items.map((it, i) => {
    const lineSubtotal = subtotals[i];
    const rate = rates[i];
    const baseRuleList = settings.basePriceRule === "list_price";
    let base = baseRuleList ? lineSubtotal : lineSubtotal - discounts[i];
    if (settings.appliesToShipping) base += shippingAlloc[i];
    const percentPart = commissionOf(base, rate.percent);
    const commission = percentPart + fixedAlloc[i];
    // Customer-paid gross for this line = subtotal − discount + shipping + tax
    // (allocation parts sum EXACTLY to the order-level inputs). sellerNet is
    // the residual after commission — NOT base+shipping again, which counted
    // shipping twice whenever the commission base included it (FIN-1 fix).
    const grossMinor = lineSubtotal - discounts[i] + shippingAlloc[i] + taxAlloc[i];
    const sellerNet = grossMinor - commission;
    return {
      title: it.title,
      variantLabel: it.variantLabel ?? null,
      unitPriceMinor: it.unitPriceMinor,
      qty: it.qty,
      lineSubtotalMinor: lineSubtotal,
      discountMinor: discounts[i],
      shippingMinor: shippingAlloc[i],
      baseMinor: base,
      percent: rate.percent,
      percentPartMinor: percentPart,
      fixedFeeMinor: fixedAlloc[i],
      commissionMinor: commission,
      sellerNetMinor: sellerNet,
      breakdown: {
        rule_source: rate.source,
        source_id: rate.sourceId,
        holiday_id: rate.holidayId,
        percent: rate.percent,
        base,
        percent_part: percentPart,
        fixed_fee_allocated: fixedAlloc[i],
        discount_allocated: discounts[i],
        shipping_allocated: shippingAlloc[i],
        flags: [] as string[],
      },
    };
  });

  // min commission floor — per ORDER, skipped when any item ran on a fee holiday
  const onHoliday = rates.some((r) => r.source === "fee_holiday");
  const totalPercentPart = results.reduce((s, r) => s + r.percentPartMinor, 0);
  if (!onHoliday && settings.minCommissionMinor > 0 && totalPercentPart < settings.minCommissionMinor && input.items.length > 0) {
    const bump = settings.minCommissionMinor - totalPercentPart;
    // remainder to highest-value line
    let maxIdx = 0;
    for (let i = 1; i < results.length; i++) {
      if (results[i].lineSubtotalMinor > results[maxIdx].lineSubtotalMinor) maxIdx = i;
    }
    results[maxIdx].percentPartMinor += bump;
    results[maxIdx].commissionMinor += bump;
    results[maxIdx].sellerNetMinor -= bump;
    results[maxIdx].breakdown.flags.push("min_commission_floor");
  }

  // FINAL RECONCILIATION (Option B invariant): sellerNet + commission must
  // equal the order total (subtotal − discount + shipping + tax) EXACTLY.
  // Drift is structurally zero with the math above (allocation parts sum
  // exactly); reconcileSplits stays as the deterministic safety net — any
  // remainder lands on the largest line, never silently lost.
  const expectedTotal =
    subtotals.reduce((s, v) => s + v, 0) -
    Math.max(0, input.orderDiscountMinor) +
    Math.max(0, input.shippingMinorTotal) +
    Math.max(0, input.orderTaxMinor ?? 0);
  const reconciled = reconcileSplits(
    results.map((r) => ({ sellerNetMinor: r.sellerNetMinor, commissionMinor: r.commissionMinor, lineSubtotalMinor: r.lineSubtotalMinor })),
    expectedTotal
  );
  for (let i = 0; i < results.length; i++) results[i].sellerNetMinor = reconciled.items[i].sellerNetMinor;

  const holdDays = rates[0]?.holdDays ?? settings.payoutHoldDays;
  const orderCommission = results.reduce((s, r) => s + r.commissionMinor, 0);
  const orderSellerNet = results.reduce((s, r) => s + r.sellerNetMinor, 0);

  return { items: results, orderCommissionMinor: orderCommission, orderSellerNetMinor: orderSellerNet, holdDays, holdReleaseRule: settings.holdReleaseRule };
}

/** Admin simulator (FIN-04): pure computation, no persistence. */
export async function simulateCommission(input: {
  priceMinor: number;
  qty: number;
  discountMinor: number;
  shippingMinor: number;
  categoryId?: string | null;
  sellerId?: string | null;
  productId?: string | null;
}) {
  const result = await computeOrderCommissions({
    sellerId: input.sellerId ?? "simulated",
    items: [
      {
        title: "Simulation item",
        unitPriceMinor: input.priceMinor,
        qty: input.qty || 1,
        categoryId: input.categoryId ?? null,
        productId: input.productId ?? null,
      },
    ],
    orderDiscountMinor: input.discountMinor || 0,
    shippingMinorTotal: input.shippingMinor || 0,
  });
  return {
    commissionMinor: result.orderCommissionMinor,
    sellerNetMinor: result.orderSellerNetMinor,
    holdDays: result.holdDays,
    trace: result.items[0].breakdown,
  };
}

/** Persist snapshots onto order items (called by checkout, never recomputed). */
export function snapshotToJson(r: CommissionItemResult): string {
  return toJson(r.breakdown);
}
