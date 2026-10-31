// ============================================================================
// M09 COMMISSION ENGINE — full spec implementation (PART 3 M09)
// Resolution priority: fee holiday > [scoped CommissionOverride rows and
// direct field overrides interleaved by scope: product > category ancestor >
// seller] > global default. Money math in integer minor units.
// Commission snapshots are stored per order_item and NEVER recomputed.
//
// F-08 remediation: the scoped CommissionOverride table (Admin→Finance
// "Commission Overrides") is resolved HERE, interleaved into the M09 chain at
// its scope position — an active row within its validity window beats the
// direct field at the SAME scope, and falls back to the next rule in the
// chain otherwise (exactly what the admin UI promises). percent /
// fixedFeeMinor / holdDays are resolved field-wise: a row that only sets
// holdDays contributes its holdDays while the rate keeps falling through.
// Multiple rows matching the same scope resolve deterministically:
// earliest createdAt wins (id as final tie-break).
//
// ----------------------------------------------------------------------------
// PHASE 2 / A2 — BATCHED rate resolution (re-land of F2-C1, adapted to the
// F-08 override semantics). The original per-item `resolveRate` issued
// ≈5 + 2·D sequential queries PER LINE (settings + seller + overrides +
// holidays + product + one query per ancestor level, twice). `loadRateContext`
// loads EVERYTHING a whole cart (all seller groups) needs in a FIXED handful
// of round-trips (~6, independent of item count), and `resolveRateFromContext`
// resolves each line purely in memory with byte-identical semantics. The
// sequential resolver below remains available as `resolveRate` (single-item
// convenience, now itself built on the batched loader); correctness parity is
// proven by scripts/test-commission-parity.ts against a verbatim copy of the
// pre-batch sequential resolver.
// ----------------------------------------------------------------------------
import { db } from "./db";
import { commissionOf, allocateProportionally } from "./money";
import { affiliatePoolMinor } from "./affiliate";
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
  source: "fee_holiday" | "override" | "product" | "category" | "seller" | "global";
  sourceId?: string;
  holidayId?: string;
  holdDays: number;
  fixedFeeMinor: number;
};

// ============================================================================
// BATCHED RATE CONTEXT (Phase 2 / A2)
// ============================================================================

/** Minimal seller fields the resolution chain needs (undefined = row absent). */
export type RateContextSeller = { commissionOverridePercent: number | null; holdDaysOverride: number | null };
/** Minimal category fields (parentId walks the ancestor chain; commissionPercent
 *  is the direct-field rate). undefined = id not loaded / row absent. */
export type RateContextCategory = { parentId: string | null; commissionPercent: number | null };
/** Active CommissionOverride rows in their validity window, createdAt-asc ordered
 *  (the fetch order IS the within-class precedence — in-memory filters below
 *  preserve it). Scope targets are already narrowed to this checkout's
 *  products / category closure / sellers. */
export type RateContextOverride = {
  id: string;
  scope: string;
  productId: string | null;
  categoryId: string | null;
  sellerId: string | null;
  percent: number | null;
  fixedFeeMinor: number | null;
  holdDays: number | null;
};

/** Everything rate resolution needs for a whole cart — one fixed query budget. */
export type RateContext = {
  settings: CommissionSettingsDTO;
  sellers: Map<string, RateContextSeller | undefined>;
  /** Active holidays covering `now` (startsAt asc — precedence order). */
  holidays: { id: string; scope: string; scopeIds: string }[];
  /** productId → commissionPercentOverride (null = loaded, no override). */
  products: Map<string, number | null | undefined>;
  /** categoryId → {parentId, commissionPercent} — the FULL ancestor closure. */
  categories: Map<string, RateContextCategory | undefined>;
  overrides: RateContextOverride[];
};

const NONE = "__no_target__"; // sentinel that can never match a real cuid — see scopedOverrideRows note

/**
 * Load the FULL rate-resolution context for a set of lines in a FIXED number of
 * round-trips: settings + sellers + products + holidays + seed categories in
 * one parallel batch, then (rare) extra category rounds chasing parents to
 * closure, then the scoped override rows for the exact closure. Item-count
 * independent: a 1-line and a 50-line cart cost the same ~6 queries.
 *
 * `now` is shared by every consumer of the returned context — one checkout,
 * one clock (the pre-batch code could drift a few ms across groups; the math
 * is date-window sensitive only at exact holiday/override boundaries, where a
 * single snapshot is strictly MORE deterministic).
 */
export async function loadRateContext(input: {
  sellerIds: string[];
  productIds?: string[];
  categoryIds?: string[];
  now?: Date;
}): Promise<RateContext> {
  const now = input.now ?? new Date();
  const sellerIds = [...new Set(input.sellerIds.filter((s): s is string => typeof s === "string" && s.length > 0))];
  const productIds = [...new Set((input.productIds ?? []).filter((p): p is string => typeof p === "string" && p.length > 0))];
  const seedCategoryIds = [...new Set((input.categoryIds ?? []).filter((c): c is string => typeof c === "string" && c.length > 0))];

  // Round 1 — five independent reads in ONE parallel batch. NOTE: the product
  // read also returns `categoryId`, which is merged into the category seeds
  // below — a caller that passes productIds but forgets categoryIds still gets
  // a correct closure (defense against the silent-wrong-results footgun).
  const [settings, sellerRows, productRows, holidays, seedCategories] = await Promise.all([
    getCommissionSettings(),
    sellerIds.length
      ? db.seller.findMany({
          where: { id: { in: sellerIds } },
          select: { id: true, commissionOverridePercent: true, holdDaysOverride: true },
        })
      : [],
    productIds.length
      ? db.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, commissionPercentOverride: true, categoryId: true },
        })
      : [],
    db.feeHoliday.findMany({
      where: { isActive: true, startsAt: { lte: now }, endsAt: { gte: now } },
      orderBy: { startsAt: "asc" },
      select: { id: true, scope: true, scopeIds: true },
    }),
    seedCategoryIds.length
      ? db.category.findMany({
          where: { id: { in: seedCategoryIds } },
          select: { id: true, parentId: true, commissionPercent: true },
        })
      : [],
  ]);

  const categories = new Map<string, RateContextCategory | undefined>();
  for (const c of seedCategories) categories.set(c.id, { parentId: c.parentId, commissionPercent: c.commissionPercent });
  // Merge the products' own categoryIds into the seeds (see note above) and
  // queue the closure chase round for the combined set.
  const products = new Map<string, number | null | undefined>(
    productRows.map((p) => [p.id, p.commissionPercentOverride] as const)
  );
  const productDerivedCategoryIds = productRows.map((p) => p.categoryId).filter((c): c is string => typeof c === "string" && c.length > 0);
  if (productDerivedCategoryIds.length > 0) {
    const notYetLoaded = productDerivedCategoryIds.filter((c) => !categories.has(c));
    if (notYetLoaded.length > 0) {
      const rows = await db.category.findMany({
        where: { id: { in: [...new Set(notYetLoaded)] } },
        select: { id: true, parentId: true, commissionPercent: true },
      });
      for (const r of rows) categories.set(r.id, { parentId: r.parentId, commissionPercent: r.commissionPercent });
      for (const c of new Set(notYetLoaded)) if (!categories.has(c)) categories.set(c, undefined);
    }
  }

  // Rounds 2..k — chase parents to closure. Each round loads only ids not yet
  // in the Map; bounded by tree depth (typically 1 extra round, often 0).
  for (;;) {
    const missing = new Set<string>();
    for (const c of categories.values()) {
      if (c?.parentId && !categories.has(c.parentId)) missing.add(c.parentId);
    }
    if (missing.size === 0) break;
    const rows = await db.category.findMany({
      where: { id: { in: [...missing] } },
      select: { id: true, parentId: true, commissionPercent: true },
    });
    for (const r of rows) categories.set(r.id, { parentId: r.parentId, commissionPercent: r.commissionPercent });
    if (rows.length < missing.size) {
      // A parent id references a deleted category — mark it explicitly so the
      // loop terminates (chain walk treats absent as "no parent", matching
      // the sequential resolver's findUnique→null behavior).
      for (const m of missing) if (!categories.has(m)) categories.set(m, undefined);
    }
  }

  // Round 3 — scoped override rows for the EXACT closure (no over-fetch:
  // category-scope rows limited to reachable ancestors, product/seller rows
  // limited to this cart). Same shape/order as the original per-item query.
  const closureCategoryIds = [...categories.keys()];
  const overrides = await db.commissionOverride.findMany({
    where: {
      isActive: true,
      AND: [
        { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
        { OR: [{ validTo: null }, { validTo: { gte: now } }] },
        {
          OR: [
            { scope: "product", productId: { in: productIds.length > 0 ? productIds : [NONE] } },
            { scope: "category", categoryId: { in: closureCategoryIds.length > 0 ? closureCategoryIds : [NONE] } },
            { scope: "seller", sellerId: { in: sellerIds.length > 0 ? sellerIds : [NONE] } },
          ],
        },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true, scope: true, productId: true, categoryId: true, sellerId: true,
      percent: true, fixedFeeMinor: true, holdDays: true,
    },
  });

  return {
    settings,
    sellers: new Map<string, RateContextSeller | undefined>(
      sellerRows.map((s) => [s.id, { commissionOverridePercent: s.commissionOverridePercent, holdDaysOverride: s.holdDaysOverride }] as const)
    ),
    holidays: holidays.map((h) => ({ id: h.id, scope: h.scope, scopeIds: h.scopeIds ?? "[]" })),
    products,
    categories,
    overrides,
  };
}

/** In-memory scoped-override selection — EXACT mirror of the original
 *  per-item `scopedOverrideRows` filter: product rows for THIS product, then
 *  category rows in ancestor-chain order (nearest first), then seller rows —
 *  all from the pre-fetched createdAt-asc list, so within-class precedence
 *  (earliest createdAt, id tie-break) is preserved by the filters themselves. */
function scopedOverrideRowsFromContext(
  ctx: RateContext,
  item: { sellerId: string; productId?: string | null },
  chain: string[]
): RateContextOverride[] {
  const productRows = ctx.overrides.filter((r) => r.scope === "product" && r.productId != null && r.productId === item.productId);
  const categoryRows = chain.flatMap((catId) => ctx.overrides.filter((r) => r.scope === "category" && r.categoryId === catId));
  const sellerRows = ctx.overrides.filter((r) => r.scope === "seller" && r.sellerId === item.sellerId);
  return [...productRows, ...categoryRows, ...sellerRows];
}

/** Ancestor chain from the preloaded closure — cycle-safe, identical walk to
 *  the original `categoryAncestorChain` (absent row ⇒ chain stops). */
function chainFromContext(ctx: RateContext, categoryId: string | null | undefined): string[] {
  const chain: string[] = [];
  let cur = categoryId ?? null;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = ctx.categories.get(cur)?.parentId ?? null;
  }
  return chain;
}

/**
 * Resolve the effective commission rate for an item FROM A PRELOADED CONTEXT —
 * pure, synchronous, zero queries. Byte-identical semantics to the original
 * sequential resolver (parity-gated by scripts/test-commission-parity.ts):
 *   0. fee holiday (all / sellers / categories-direct) …
 *   … through scoped override rows and direct field overrides interleaved by
 *   scope: product > category ancestor > seller … global default.
 */
export function resolveRateFromContext(
  ctx: RateContext,
  item: {
    sellerId: string;
    categoryId?: string | null;
    productId?: string | null;
  }
): RateResolution {
  const settings = ctx.settings;
  const chain = chainFromContext(ctx, item.categoryId);

  const rows = scopedOverrideRowsFromContext(ctx, item, chain);
  const holdRow = rows.find((r) => r.holdDays != null);
  const fixedRow = rows.find((r) => r.fixedFeeMinor != null);
  const seller = ctx.sellers.get(item.sellerId);
  const fallback: RateResolution = {
    percent: settings.defaultPercent,
    source: "global",
    holdDays: holdRow?.holdDays ?? seller?.holdDaysOverride ?? settings.payoutHoldDays,
    fixedFeeMinor: fixedRow?.fixedFeeMinor ?? settings.fixedFeeMinor,
  };

  // 1. active fee holiday covering (seller, category, now)
  for (const h of ctx.holidays) {
    if (h.scope === "all") {
      return { ...fallback, percent: 0, source: "fee_holiday", holidayId: h.id };
    }
    const ids = JSON.parse(h.scopeIds || "[]") as string[];
    if (h.scope === "sellers" && ids.includes(item.sellerId)) {
      return { ...fallback, percent: 0, source: "fee_holiday", holidayId: h.id };
    }
    if (h.scope === "categories" && item.categoryId && ids.includes(item.categoryId)) {
      return { ...fallback, percent: 0, source: "fee_holiday", holidayId: h.id };
    }
  }

  // 2. product-scope override row (F-08) — windowed, beats the direct field
  const pRow = rows.find((r) => r.scope === "product" && r.percent != null);
  if (pRow) {
    return { ...fallback, percent: pRow.percent!, source: "override", sourceId: pRow.id };
  }

  // 3. product direct override
  if (item.productId) {
    const p = ctx.products.get(item.productId);
    if (p != null) {
      return { ...fallback, percent: p, source: "product", sourceId: item.productId };
    }
  }

  // 4. category-scope override rows (F-08) — nearest ancestor first
  const cRow = rows.find((r) => r.scope === "category" && r.percent != null);
  if (cRow) {
    return { ...fallback, percent: cRow.percent!, source: "override", sourceId: cRow.id };
  }

  // 5. nearest category ancestor with commission_percent (direct field)
  for (const catId of chain) {
    const cat = ctx.categories.get(catId);
    if (cat?.commissionPercent != null) {
      return { ...fallback, percent: cat.commissionPercent, source: "category", sourceId: catId };
    }
  }

  // 6. seller-scope override row (F-08)
  const sRow = rows.find((r) => r.scope === "seller" && r.percent != null);
  if (sRow) {
    return { ...fallback, percent: sRow.percent!, source: "override", sourceId: sRow.id };
  }

  // 7. seller direct override
  if (seller?.commissionOverridePercent != null) {
    return { ...fallback, percent: seller.commissionOverridePercent, source: "seller", sourceId: item.sellerId };
  }

  // 8. global default
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
  // ---- AFFILIATE (Hub) ---------------------------------------------------
  /** Resolved affiliate attribution for this line (server-side; null ⇒ none).
   *  When present with rateBps > 0 the seller-funded affiliate pool is carved
   *  from seller proceeds and reported on the item result for snapshotting. */
  affiliate?: {
    affiliateId: string;
    sponsorId: string | null;
    linkId: string;
    rateBps: number;
  } | null;
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
  // ---- AFFILIATE (Hub): seller-funded pool carved from seller proceeds.
  // 0 for unattributed items. Frozen on OrderItem.affiliatePoolMinor by the
  //  checkout; posted to PLATFORM:AFFILIATE_LIABILITY at payment (T1 4th line). */
  affiliatePoolMinor: number;
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
    affiliate_rate_bps?: number;
    affiliate_base?: number;
    affiliate_pool?: number;
    flags: string[];
  };
};

export type CommissionOrderResult = {
  items: CommissionItemResult[];
  orderCommissionMinor: number;
  orderSellerNetMinor: number;
  /** Σ affiliate pools (T1 4th-line input). */
  orderAffiliatePoolMinor: number;
  holdDays: number;
  holdReleaseRule: string;
};

/**
 * INVARIANT (Option B mirror requirement — FIN-1, v2 with affiliate):
 *   sum(item.sellerNetMinor) + sum(item.commissionMinor) + sum(item.affiliatePoolMinor)
 *     === order.totalMinor
 * for EVERY order, where totalMinor = subtotalMinor − discountMinor +
 * shippingMinor + taxMinor. The ledger T1 (postOrderPaid) debits the PSP
 * gateway totalMinor and credits exactly sellerNet + commission + affiliate
 * pool, so any drift here would throw LEDGER_UNBALANCED at payment time. The
 * customer-paid gross per item is (lineSubtotal − discount + shipping + tax
 * allocations); seller net is that gross MINUS commission MINUS the
 * affiliate pool — never gross-plus-shipping again (the pre-FIN-1 formula
 * double-counted shipping when appliesToShipping=true).
 */
export function reconcileSplits(
  items: { sellerNetMinor: number; commissionMinor: number; affiliatePoolMinor?: number; lineSubtotalMinor: number }[],
  totalMinor: number
): { items: { sellerNetMinor: number; commissionMinor: number; affiliatePoolMinor?: number; lineSubtotalMinor: number }[]; driftMinor: number } {
  const sumNet = items.reduce((s, r) => s + r.sellerNetMinor, 0);
  const sumComm = items.reduce((s, r) => s + r.commissionMinor, 0);
  const sumAff = items.reduce((s, r) => s + (r.affiliatePoolMinor ?? 0), 0);
  const drift = totalMinor - (sumNet + sumComm + sumAff);
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
 *
 * PHASE 2 / A2: `preloaded` lets a multi-group checkout load ONE RateContext
 * for every seller group and share it across the per-group calls (the context
 * loader is item-count independent — see loadRateContext). Without it, the
 * context is loaded from this order's own items: same semantics, ~6 queries
 * either way (versus (5+2·D) sequential queries PER LINE pre-batching).
 */
export async function computeOrderCommissions(
  input: {
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
  },
  preloaded?: RateContext
): Promise<CommissionOrderResult> {
  const now = input.now ?? new Date();
  const ctx =
    preloaded ??
    (await loadRateContext({
      sellerIds: [input.sellerId],
      productIds: input.items.map((it) => it.productId ?? "").filter(Boolean),
      categoryIds: input.items.map((it) => it.categoryId ?? "").filter(Boolean),
      now,
    }));
  const settings = ctx.settings;

  const subtotals = input.items.map((it) => it.unitPriceMinor * it.qty);
  const discounts = allocateProportionally(Math.max(0, input.orderDiscountMinor), subtotals);
  const shippingAlloc = allocateProportionally(Math.max(0, input.shippingMinorTotal), subtotals);
  const taxAlloc = allocateProportionally(Math.max(0, input.orderTaxMinor ?? 0), subtotals);

  // resolve rate per item — pure in-memory resolution over the shared context
  const rates: RateResolution[] = input.items.map((it) =>
    resolveRateFromContext(ctx, {
      sellerId: input.sellerId,
      categoryId: it.categoryId ?? null,
      productId: it.productId ?? null,
    })
  );

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
    // AFFILIATE (Hub): seller-funded pool on the COMMISSIONABLE BASE — eligible
    // merchandise value after seller-funded discounts, EXCLUDING shipping and
    // tax (spec §8). Only lines with resolved server-side attribution and a
    // positive effective rate generate a pool.
    const aff = it.affiliate && it.affiliate.rateBps > 0 ? it.affiliate : null;
    const affBase = Math.max(0, lineSubtotal - discounts[i]);
    const affiliatePool = aff ? affiliatePoolMinor(affBase, aff.rateBps) : 0;
    // Customer-paid gross for this line = subtotal − discount + shipping + tax
    // (allocation parts sum EXACTLY to the order-level inputs). sellerNet is
    // the residual after commission AND the affiliate pool — NOT base+shipping
    // again, which counted shipping twice whenever the commission base
    // included it (FIN-1 fix).
    const grossMinor = lineSubtotal - discounts[i] + shippingAlloc[i] + taxAlloc[i];
    const sellerNet = grossMinor - commission - affiliatePool;
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
      affiliatePoolMinor: affiliatePool,
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
        ...(aff
          ? { affiliate_rate_bps: aff.rateBps, affiliate_base: affBase, affiliate_pool: affiliatePool }
          : {}),
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
    results.map((r) => ({ sellerNetMinor: r.sellerNetMinor, commissionMinor: r.commissionMinor, affiliatePoolMinor: r.affiliatePoolMinor, lineSubtotalMinor: r.lineSubtotalMinor })),
    expectedTotal
  );
  for (let i = 0; i < results.length; i++) results[i].sellerNetMinor = reconciled.items[i].sellerNetMinor;

  const holdDays = rates[0]?.holdDays ?? settings.payoutHoldDays;
  const orderCommission = results.reduce((s, r) => s + r.commissionMinor, 0);
  const orderSellerNet = results.reduce((s, r) => s + r.sellerNetMinor, 0);
  const orderAffiliatePool = results.reduce((s, r) => s + r.affiliatePoolMinor, 0);

  return { items: results, orderCommissionMinor: orderCommission, orderSellerNetMinor: orderSellerNet, orderAffiliatePoolMinor: orderAffiliatePool, holdDays, holdReleaseRule: settings.holdReleaseRule };
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

/** Single-item convenience wrapper over the batched resolver (kept for API
 *  compatibility; batch callers should prefer loadRateContext +
 *  resolveRateFromContext). Same semantics as the pre-batch sequential
 *  resolver — proven byte-identical by scripts/test-commission-parity.ts. */
export async function resolveRate(ctx: {
  sellerId: string;
  categoryId?: string | null;
  productId?: string | null;
  now?: Date;
}): Promise<RateResolution> {
  const context = await loadRateContext({
    sellerIds: [ctx.sellerId],
    productIds: ctx.productId ? [ctx.productId] : [],
    categoryIds: ctx.categoryId ? [ctx.categoryId] : [],
    now: ctx.now,
  });
  return resolveRateFromContext(context, ctx);
}

/** Persist snapshots onto order items (called by checkout, never recomputed). */
export function snapshotToJson(r: CommissionItemResult): string {
  return toJson(r.breakdown);
}
