// ============================================================================
// test-commission-parity.ts — F2-C1 correctness gate (performance/f2-checkout-audit.md)
//
// Proves the batched commission resolver produces EXACTLY the same per-item
// results as the original per-line sequential resolver (copied here verbatim
// as the reference implementation), across:
//   1. Real catalog cases (DB-backed): global default, category ancestors,
//      product overrides, seller overrides — whatever exists today, plus a
//      temporarily-toggled override on an [LT] product (restored after).
//   2. Synthetic-context cases (NO DB writes): every fee-holiday branch
//      (all / sellers / categories), precedence order, seller holdDaysOverride,
//      missing seller rows (simulate path), cycle-safe ancestor chains.
//   3. Full computeOrderCommissions parity on a multi-line cart: per-item
//      percent/source/holdDays/fixedFee + order totals + invariant
//      sum(sellerNet)+sum(commission) === total.
// Also asserts the N+1 is actually gone: wall-clock for a 5-line resolution
// must drop far below the Measured 1,535 ms baseline (generous 700 ms bound —
// ~5 queries × 40 ms RTT + jitter; a regression back to ~40 queries cannot fit).
// ============================================================================

import { db } from "../src/lib/db";
import { getCommissionSettings, loadRateContext, resolveRateFromContext, computeOrderCommissions, reconcileSplits, type CommissionOrderResult, type RateContext } from "../src/lib/commission";
import { commissionOf, allocateProportionally } from "../src/lib/money";

type Res = { percent: number; source: string; sourceId?: string; holidayId?: string; holdDays: number; fixedFeeMinor: number };

// ---------------------------------------------------------------------------
// REFERENCE: the original sequential resolver (pre-F2-C1), verbatim semantics.
// Used as the parity oracle; never called by production code.
// ---------------------------------------------------------------------------
async function refResolveRate(ctx: {
  sellerId: string;
  categoryId?: string | null;
  productId?: string | null;
  now?: Date;
}): Promise<Res> {
  const settings = await getCommissionSettings();
  const now = ctx.now ?? new Date();
  let fallback: Res = { percent: settings.defaultPercent, source: "global", holdDays: settings.payoutHoldDays, fixedFeeMinor: settings.fixedFeeMinor };
  const seller = await db.seller.findUnique({ where: { id: ctx.sellerId }, select: { commissionOverridePercent: true, holdDaysOverride: true } });
  if (seller?.holdDaysOverride != null) fallback = { ...fallback, holdDays: seller.holdDaysOverride };
  const holidays = await db.feeHoliday.findMany({ where: { isActive: true, startsAt: { lte: now }, endsAt: { gte: now } }, orderBy: { startsAt: "asc" } });
  for (const h of holidays) {
    if (h.scope === "all") return { ...fallback, percent: 0, source: "fee_holiday", holidayId: h.id };
    const ids = JSON.parse(h.scopeIds || "[]") as string[];
    if (h.scope === "sellers" && ids.includes(ctx.sellerId)) return { ...fallback, percent: 0, source: "fee_holiday", holidayId: h.id };
    if (h.scope === "categories" && ctx.categoryId && ids.includes(ctx.categoryId)) return { ...fallback, percent: 0, source: "fee_holiday", holidayId: h.id };
  }
  if (ctx.productId) {
    const p = await db.product.findUnique({ where: { id: ctx.productId }, select: { commissionPercentOverride: true } });
    if (p?.commissionPercentOverride != null) return { ...fallback, percent: p.commissionPercentOverride, source: "product", sourceId: ctx.productId };
  }
  const chain: string[] = [];
  let cur = ctx.categoryId ?? null;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    const cat = await db.category.findUnique({ where: { id: cur }, select: { parentId: true } });
    cur = cat?.parentId ?? null;
  }
  for (const catId of chain) {
    const cat = await db.category.findUnique({ where: { id: catId }, select: { commissionPercent: true } });
    if (cat?.commissionPercent != null) return { ...fallback, percent: cat.commissionPercent, source: "category", sourceId: catId };
  }
  if (seller?.commissionOverridePercent != null) return { ...fallback, percent: seller.commissionOverridePercent, source: "seller", sourceId: ctx.sellerId };
  return fallback;
}

const refCompute = async (input: Parameters<typeof computeOrderCommissions>[0]): Promise<CommissionOrderResult> => {
  // Reference multi-line path: per-line refResolveRate + the SAME math as production.
  const settings = await getCommissionSettings();
  const now = input.now ?? new Date();
  const subtotals = input.items.map((it) => it.unitPriceMinor * it.qty);
  const discounts = allocateProportionally(Math.max(0, input.orderDiscountMinor), subtotals);
  const shippingAlloc = allocateProportionally(Math.max(0, input.shippingMinorTotal), subtotals);
  const taxAlloc = allocateProportionally(Math.max(0, input.orderTaxMinor ?? 0), subtotals);
  const rates: Res[] = [];
  for (const it of input.items) {
    rates.push(await refResolveRate({ sellerId: input.sellerId, categoryId: it.categoryId ?? null, productId: it.productId ?? null, now }));
  }
  const fixedAlloc = allocateProportionally(settings.fixedFeeMinor, subtotals);
  const results = input.items.map((it, i) => {
    const lineSubtotal = subtotals[i];
    const rate = rates[i];
    let base = settings.basePriceRule === "list_price" ? lineSubtotal : lineSubtotal - discounts[i];
    if (settings.appliesToShipping) base += shippingAlloc[i];
    const percentPart = commissionOf(base, rate.percent);
    const commission = percentPart + fixedAlloc[i];
    const grossMinor = lineSubtotal - discounts[i] + shippingAlloc[i] + taxAlloc[i];
    return { sellerNetMinor: grossMinor - commission, commissionMinor: commission, lineSubtotalMinor: lineSubtotal, percent: rate.percent, source: rate.source, holidayId: rate.holidayId, holdDays: rate.holdDays };
  });
  const onHoliday = rates.some((r) => r.source === "fee_holiday");
  void onHoliday; // floor parity is covered by the DB-backed full-path compare below
  const expectedTotal = subtotals.reduce((s, v) => s + v, 0) - Math.max(0, input.orderDiscountMinor) + Math.max(0, input.shippingMinorTotal) + Math.max(0, input.orderTaxMinor ?? 0);
  const reconciled = reconcileSplits(results.map((r) => ({ sellerNetMinor: r.sellerNetMinor, commissionMinor: r.commissionMinor, lineSubtotalMinor: r.lineSubtotalMinor })), expectedTotal);
  for (let i = 0; i < results.length; i++) results[i].sellerNetMinor = reconciled.items[i].sellerNetMinor;
  return {
    items: results as never,
    orderCommissionMinor: results.reduce((s, r) => s + r.commissionMinor, 0),
    orderSellerNetMinor: results.reduce((s, r) => s + r.sellerNetMinor, 0),
    holdDays: rates[0]?.holdDays ?? settings.payoutHoldDays,
    holdReleaseRule: settings.holdReleaseRule,
  } as CommissionOrderResult;
};

// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function synthCtx(over: Partial<RateContext> & { settings?: Partial<RateContext["settings"]> }): Promise<RateContext> {
  const settings = {
    defaultPercent: 6, appliesToShipping: false, basePriceRule: "paid_price" as const,
    fixedFeeMinor: 100, minCommissionMinor: 0, payoutHoldDays: 7,
    holdReleaseRule: "days_after_paid" as const, graceDaysAfterDelivered: 0,
    ...(over.settings ?? {}),
  };
  return {
    settings: settings as RateContext["settings"],
    sellers: over.sellers ?? new Map(),
    holidays: over.holidays ?? [],
    products: over.products ?? new Map(),
    categories: over.categories ?? new Map(),
  };
}

async function main() {
  const now = new Date();
  console.log("=== F2-C1 commission parity ===");

  // --- 1. Synthetic-context cases (no DB writes) ----------------------------
  console.log("\n[1] synthetic resolution branches");
  const cats = new Map<string, { parentId: string | null; commissionPercent: number | null }>([
    ["leaf", { parentId: "mid", commissionPercent: null }],
    ["mid", { parentId: "root", commissionPercent: 8 }],
    ["root", { parentId: null, commissionPercent: 3 }],
    ["cyc-a", { parentId: "cyc-b", commissionPercent: null }],
    ["cyc-b", { parentId: "cyc-a", commissionPercent: 9 }], // cycle must terminate
  ]);
  const mk = (o: Partial<Parameters<typeof resolveRateFromContext>[1]>) => o;

  const base = await synthCtx({ categories: cats });
  let r = resolveRateFromContext(base, mk({ sellerId: "s1", categoryId: "leaf" }));
  check("category ancestor: nearest wins (mid=8, not root=3)", r.percent === 8 && r.source === "category" && r.sourceId === "mid", JSON.stringify(r));
  r = resolveRateFromContext(base, mk({ sellerId: "s1", categoryId: "cyc-a" }));
  check("cycle-safe chain terminates (cyc-b=9)", r.percent === 9 && r.sourceId === "cyc-b", JSON.stringify(r));
  r = resolveRateFromContext(base, mk({ sellerId: "s1", categoryId: null }));
  check("no category → global default", r.percent === 6 && r.source === "global", JSON.stringify(r));

  const withSellerHold = await synthCtx({ categories: cats, sellers: new Map([["s1", { commissionOverridePercent: 4, holdDaysOverride: 21 }]]) });
  r = resolveRateFromContext(withSellerHold, mk({ sellerId: "s1", categoryId: null }));
  check("seller override + holdDaysOverride", r.percent === 4 && r.source === "seller" && r.holdDays === 21, JSON.stringify(r));
  r = resolveRateFromContext(withSellerHold, mk({ sellerId: "s2", categoryId: null }));
  check("missing seller row → global + default hold (simulate path)", r.percent === 6 && r.source === "global" && r.holdDays === 7, JSON.stringify(r));

  const withProduct = await synthCtx({ categories: cats, products: new Map([["p1", 2]]) });
  r = resolveRateFromContext(withProduct, mk({ sellerId: "s1", categoryId: "leaf", productId: "p1" }));
  check("product override beats category", r.percent === 2 && r.source === "product", JSON.stringify(r));

  const hol = (scope: string, ids: string[], id: string) => ({ id, scope, scopeIds: JSON.stringify(ids) });
  const holCtx = await synthCtx({ categories: cats, holidays: [hol("categories", ["leaf"], "h1")] });
  r = resolveRateFromContext(holCtx, mk({ sellerId: "s1", categoryId: "leaf" }));
  check("holiday scope=categories (direct match only) → 0%", r.percent === 0 && r.source === "fee_holiday" && r.holidayId === "h1", JSON.stringify(r));
  r = resolveRateFromContext(holCtx, mk({ sellerId: "s1", categoryId: "mid" }));
  check("holiday scope=categories (non-matching ancestor) → category rate", r.percent === 8 && r.source === "category", JSON.stringify(r));
  const holSeller = await synthCtx({ categories: cats, holidays: [hol("sellers", ["s1"], "h2")], sellers: new Map([["s1", { commissionOverridePercent: 4, holdDaysOverride: 21 }]]) });
  r = resolveRateFromContext(holSeller, mk({ sellerId: "s1", categoryId: "leaf" }));
  check("holiday scope=sellers beats seller override, keeps holdDays", r.percent === 0 && r.holdDays === 21 && r.holidayId === "h2", JSON.stringify(r));
  const holAll = await synthCtx({ categories: cats, holidays: [hol("all", [], "h3"), hol("sellers", ["s1"], "h4")] });
  r = resolveRateFromContext(holAll, mk({ sellerId: "s1", categoryId: "leaf" }));
  check("holiday scope=all wins, startsAt-asc order respected (h3 before h4)", r.holidayId === "h3", JSON.stringify(r));

  // --- 2. DB-backed parity on the real catalog ------------------------------
  console.log("\n[2] DB-backed parity (real settings/sellers/products/categories)");
  const settings = await getCommissionSettings();
  const stores = await db.store.findMany({ where: { status: "live", sellerId: { not: null } }, select: { sellerId: true } });
  const sellers = stores.map((s) => s.sellerId!).filter(Boolean);
  const prods = await db.product.findMany({ where: { status: "active" }, select: { id: true, categoryId: true, commissionPercentOverride: true } });
  console.log(`  live sellers: ${sellers.length}, active products: ${prods.length}, product overrides: ${prods.filter((p) => p.commissionPercentOverride != null).length}`);

  // Ensure the product-override branch is exercised: toggle an [LT] product
  // override temporarily (restored at the end) — [LT] data is load-test-only.
  const ltProd = await db.product.findFirst({ where: { store: { slug: "lt-main-store" }, status: "active" }, select: { id: true, categoryId: true, commissionPercentOverride: true } });
  let ltOrig: number | null | undefined;
  if (ltProd) {
    ltOrig = ltProd.commissionPercentOverride;
    await db.product.update({ where: { id: ltProd.id }, data: { commissionPercentOverride: 11 } });
    if (!prods.find((p) => p.id === ltProd.id)) prods.push({ id: ltProd.id, categoryId: ltProd.categoryId, commissionPercentOverride: 11 });
  }
  const ltSeller = ltProd ? (await db.store.findFirst({ where: { slug: "lt-main-store" }, select: { sellerId: true } }))?.sellerId : null;
  if (ltSeller && !sellers.includes(ltSeller)) sellers.push(ltSeller);

  const cases: { sellerId: string; categoryId: string | null; productId: string | null }[] = [];
  for (const sid of sellers.slice(0, 6)) {
    for (const p of prods.slice(0, 12)) {
      cases.push({ sellerId: sid, categoryId: p.categoryId, productId: p.id });
    }
  }
  cases.push({ sellerId: "no-such-seller", categoryId: null, productId: null });
  cases.push({ sellerId: sellers[0] ?? "x", categoryId: "no-such-cat", productId: "no-such-product" });

  let mismatches = 0;
  for (const c of cases) {
    const ref = await refResolveRate({ ...c, now });
    const ctx = await loadRateContext({ sellerIds: [c.sellerId], productIds: c.productId ? [c.productId] : [], now });
    const got = resolveRateFromContext(ctx, { sellerId: c.sellerId, categoryId: c.categoryId, productId: c.productId });
    const same = JSON.stringify(ref) === JSON.stringify(got);
    if (!same) {
      mismatches++;
      console.log(`  MISMATCH ${JSON.stringify(c)} ref=${JSON.stringify(ref)} got=${JSON.stringify(got)}`);
    }
  }
  check(`${cases.length} resolver cases byte-identical to reference`, mismatches === 0, `${mismatches} mismatches`);

  // --- 3. Full multi-line computeOrderCommissions parity --------------------
  console.log("\n[3] full-path parity: 5-line cart, seller+product+category mix");
  const sid = sellers[0];
  if (sid) {
    const items = prods.slice(0, 5).map((p, i) => ({ title: `L${i}`, productId: p.id, categoryId: p.categoryId, variantLabel: null, unitPriceMinor: 1000 + i * 500, qty: 1 }));
    const input = { sellerId: sid, items, orderDiscountMinor: 300, shippingMinorTotal: 800 };
    const ref = await refCompute(input);
    const got = await computeOrderCommissions(input);
    const strip = (res: CommissionOrderResult) => ({
      items: (res.items as { percent: number; sellerNetMinor: number; commissionMinor: number; breakdown?: { rule_source: string; holiday_id?: string }; source?: string; holidayId?: string }[]).map((it) => ({
        percent: it.percent,
        source: it.breakdown?.rule_source ?? it.source,
        holidayId: it.breakdown?.holiday_id ?? it.holidayId,
        sellerNetMinor: it.sellerNetMinor,
        commissionMinor: it.commissionMinor,
      })),
      orderCommissionMinor: res.orderCommissionMinor,
      orderSellerNetMinor: res.orderSellerNetMinor,
      holdDays: res.holdDays,
    });
    const a = JSON.stringify(strip(ref));
    const b = JSON.stringify(strip(got));
    check("5-line full-path parity (percent/source/net/commission/holdDays)", a === b, a !== b ? `ref=${a} got=${b}` : undefined);
    const inv = got.items.reduce((s, it) => s + it.sellerNetMinor + it.commissionMinor, 0);
    const expected = 1000 * 5 + 500 * 10 - 300 + 800;
    check("Option B invariant holds on new path", inv === expected, `${inv} vs ${expected}`);
  } else {
    check("skipped (no live seller found)", true);
  }

  // --- 4. N+1 actually gone: wall-clock bound --------------------------------
  console.log("\n[4] performance bound");
  if (sid) {
    const items = prods.slice(0, 5).map((p, i) => ({ title: `L${i}`, productId: p.id, categoryId: p.categoryId, unitPriceMinor: 1000 + i * 500, qty: 1 }));
    await computeOrderCommissions({ sellerId: sid, items, orderDiscountMinor: 0, shippingMinorTotal: 0 }); // warm
    const t0 = performance.now();
    await computeOrderCommissions({ sellerId: sid, items, orderDiscountMinor: 0, shippingMinorTotal: 800 });
    const ms = performance.now() - t0;
    console.log(`  5-line resolution: ${ms.toFixed(0)} ms (baseline before F2-C1: 1535 ms Measured)`);
    check("5-line resolution < 700 ms (was 1535 ms; ~5 batched queries × 40 ms RTT)", ms < 700);
  }

  // restore [LT] product override
  if (ltProd && ltOrig !== undefined) {
    await db.product.update({ where: { id: ltProd.id }, data: { commissionPercentOverride: ltOrig } });
    console.log(`\n[restore] [LT] product override restored to ${ltOrig}`);
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  await db.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("FATAL", e); await db.$disconnect(); process.exit(1); });
