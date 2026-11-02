// ============================================================================
// AFFILIATE REPORTING QUERIES — hub overview, discovery, network, earnings,
// seller programme report, admin overview + reconciliation (spec §15).
//
// HONESTY RULES:
//   • Estimated analytics (clicks, visitors, views, add-to-cart) are labelled
//     separately from authoritative financial figures (commissions, payouts).
//   • No fabricated history: every number comes from real recorded rows
//     (attribution touches, AnalyticsEvents, AffiliateCommission entries,
//     ledger lines). Empty database ⇒ zero metrics, never backfilled.
//   • Buyer PII is never exposed in affiliate-facing payloads.
// ============================================================================
import { db } from "@/lib/db";
import { affiliateBalances, affiliatePoolMinor, getAffiliateSettings } from "./affiliate";

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86400000);
}

// ---------------------------------------------------------------------------
// Affiliate Hub — Overview (spec §3.A)
// ---------------------------------------------------------------------------
export type HubOverview = {
  estimated: {
    clicks: number;
    uniqueVisitors: number;
    productViews: number;
    addToCart: number;
  };
  commerce: {
    attributedOrders: number;
    paidOrders: number;
    eligibleSalesMinor: number;
    reversedMinor: number;
  };
  earnings: {
    personalDirectMinor: number;
    sponsorMinor: number;
    pendingMinor: number;
    approvedMinor: number;
    availableMinor: number;
    paidMinor: number;
    reversedMinor: number;
    heldMinor: number;
    recoveryMinor: number;
    requestableMinor: number;
    payoutInFlightMinor: number;
  };
  network: {
    directReferrals: number;
    activatedAffiliates: number;
    affiliatesWithSales: number;
  };
  series: { date: string; clicks: number; orders: number; commissionMinor: number }[];
};

export async function hubOverview(affiliateId: string, days = 30): Promise<HubOverview> {
  const since = daysAgo(days);

  // ---- Estimated analytics (advisory: touches + tagged events) ----------
  const [clicks, uniqueVisitors, productViews, addToCart] = await Promise.all([
    db.affiliateAttributionTouch.count({ where: { affiliateId, clickedAt: { gte: since } } }),
    db.affiliateAttributionTouch.findMany({
      where: { affiliateId, clickedAt: { gte: since } },
      select: { visitorId: true },
      distinct: ["visitorId"],
    }).then((rows) => rows.length),
    db.analyticsEvent.count({ where: { affiliateId, eventType: "product_view", createdAt: { gte: since } } }),
    db.analyticsEvent.count({ where: { affiliateId, eventType: "add_to_cart", createdAt: { gte: since } } }),
  ]);

  // ---- Authoritative commerce + finance ----------------------------------
  const commissions = await db.affiliateCommission.findMany({
    where: { affiliateId, createdAt: { gte: since } },
    select: { id: true, orderId: true, status: true, commissionableBaseMinor: true, poolMinor: true, entries: { select: { role: true, amountMinor: true, reversedMinor: true } } },
  });
  const paidOrders = new Set(
    (await db.affiliateCommission.findMany({
      where: { affiliateId },
      select: { orderId: true, order: { select: { status: true, paidAt: true } } },
    })).filter((c) => c.order.paidAt != null).map((c) => c.orderId)
  );
  const sponsorEntries = await db.affiliateCommissionEntry.findMany({
    where: { beneficiaryAffiliateId: affiliateId, role: "sponsor" },
    select: { amountMinor: true, reversedMinor: true },
  });
  const balances = await affiliateBalances(affiliateId);

  const personalDirectMinor = commissions.reduce(
    (s, c) => s + (c.entries.find((e) => e.role === "direct")?.amountMinor ?? 0),
    0
  );

  // ---- Network ------------------------------------------------------------
  const [directReferrals, activatedAffiliates, referralIds] = await Promise.all([
    db.affiliateProfile.count({ where: { sponsorId: affiliateId } }),
    db.affiliateProfile.count({ where: { sponsorId: affiliateId, status: "active" } }),
    db.affiliateProfile.findMany({ where: { sponsorId: affiliateId }, select: { id: true } }),
  ]);
  const withSales = referralIds.length
    ? await db.affiliateCommissionEntry.findMany({
        where: { beneficiaryAffiliateId: { in: referralIds.map((r) => r.id) }, role: "direct" },
        select: { beneficiaryAffiliateId: true },
        distinct: ["beneficiaryAffiliateId"],
      }).then((rows) => rows.length)
    : 0;

  // ---- Daily series (clicks / orders / commission) ------------------------
  const touchRows = await db.affiliateAttributionTouch.findMany({
    where: { affiliateId, clickedAt: { gte: since } },
    select: { clickedAt: true },
  });
  const seriesMap = new Map<string, { clicks: number; orders: number; commissionMinor: number }>();
  for (let d = new Date(since); d <= new Date(); d = new Date(d.getTime() + 86400000)) {
    seriesMap.set(d.toISOString().slice(0, 10), { clicks: 0, orders: 0, commissionMinor: 0 });
  }
  for (const t of touchRows) {
    const k = t.clickedAt.toISOString().slice(0, 10);
    const row = seriesMap.get(k);
    if (row) row.clicks += 1;
  }
  const commissionRows = await db.affiliateCommission.findMany({
    where: { affiliateId, createdAt: { gte: since } },
    select: { createdAt: true, poolMinor: true },
  });
  for (const c of commissionRows) {
    const k = c.createdAt.toISOString().slice(0, 10);
    const row = seriesMap.get(k);
    if (row) {
      row.orders += 1;
      row.commissionMinor += c.poolMinor;
    }
  }

  return {
    estimated: { clicks, uniqueVisitors: uniqueVisitors, productViews, addToCart },
    commerce: {
      attributedOrders: commissions.length,
      paidOrders: paidOrders.size,
      eligibleSalesMinor: commissions.reduce((s, c) => s + c.commissionableBaseMinor, 0),
      reversedMinor: balances.reversedMinor,
    },
    earnings: {
      personalDirectMinor,
      sponsorMinor: sponsorEntries.reduce((s, e) => s + e.amountMinor - e.reversedMinor, 0),
      pendingMinor: balances.pendingMinor,
      approvedMinor: balances.approvedMinor,
      availableMinor: balances.availableMinor,
      paidMinor: balances.paidMinor,
      reversedMinor: balances.reversedMinor,
      heldMinor: balances.heldMinor,
      recoveryMinor: balances.recoveryMinor,
      requestableMinor: balances.requestableMinor,
      payoutInFlightMinor: balances.payoutInFlightMinor,
    },
    network: { directReferrals, activatedAffiliates, affiliatesWithSales: withSales },
    series: [...seriesMap.entries()].map(([date, v]) => ({ date, ...v })),
  };
}

// ---------------------------------------------------------------------------
// Product discovery (spec §3.B) — participating products only.
// ---------------------------------------------------------------------------
export type DiscoverProduct = {
  productId: string;
  title: string;
  slug: string;
  storeSlug: string;
  storeName: string;
  image: string | null;
  priceMinor: number;
  rateBps: number;
  estimatedCommissionMinor: number;
  salesCount: number;
  ratingAvg: number;
  isFeatured: boolean;
  addedAt: string | null;
};

export async function discoverProducts(opts: {
  categorySlug?: string;
  q?: string;
  storeSlug?: string;
  minRateBps?: number;
  maxPriceMinor?: number;
  sort?: "rate" | "price_asc" | "price_desc" | "sales" | "newest" | "featured";
  page?: number;
  size?: number;
}): Promise<{ rows: DiscoverProduct[]; total: number }> {
  const size = Math.min(48, Math.max(6, opts.size ?? 24));
  const page = Math.max(1, opts.page ?? 1);
  const discoverSettings = await getAffiliateSettings();

  const where = {
    status: "active",
    affiliateEnabled: true,
    // C1.3 defense-in-depth (V-F5 fix): affiliate discovery requires an
    // admin-approved seller, not just a live store — same posture as every
    // other public product surface.
    store: { status: "live", affiliateOptIn: true, seller: { status: "active" } },
    ...(opts.categorySlug ? { category: { slug: opts.categorySlug } } : {}),
    ...(opts.storeSlug ? { store: { status: "live", affiliateOptIn: true, slug: opts.storeSlug, seller: { status: "active" } } } : {}),
    ...(opts.maxPriceMinor != null ? { priceMinor: { lte: opts.maxPriceMinor } } : {}),
    ...(opts.q
      ? { OR: [{ title: { contains: opts.q, mode: "insensitive" as const } }, { store: { name: { contains: opts.q, mode: "insensitive" as const } } }] }
      : {}),
  };

  const total = await db.product.count({ where });
  const rows = await db.product.findMany({
    where,
    include: {
      store: { select: { slug: true, name: true, affiliateOptIn: true, affiliateDefaultRateBps: true } },
      images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } },
    },
    orderBy:
      opts.sort === "newest" ? { createdAt: "desc" }
      : opts.sort === "sales" ? { salesCount: "desc" }
      : opts.sort === "featured" ? [{ isFeatured: "desc" as const }, { salesCount: "desc" as const }]
      : opts.sort === "price_asc" ? { priceMinor: "asc" }
      : opts.sort === "price_desc" ? { priceMinor: "desc" }
      : { salesCount: "desc" },
    take: size,
    skip: (page - 1) * size,
  });

  const mapped: DiscoverProduct[] = rows.map((p) => {
    // POST-IMPLEMENTATION AUDIT (P4): display math mirrors the authoritative
    // checkout math — clamped to the platform max rate and FLOOR-rounded via
    // the same affiliatePoolMinor() used at checkout, so the estimated number
    // a buyer/affiliate sees can never exceed what posting would compute.
    const rateBps = Math.max(0, Math.min(p.affiliateRateBps ?? p.store.affiliateDefaultRateBps, discoverSettings.maxRateBps));
    return {
      productId: p.id,
      title: p.title,
      slug: p.slug,
      storeSlug: p.store.slug,
      storeName: p.store.name,
      image: p.images[0]?.url ?? null,
      priceMinor: p.priceMinor,
      rateBps,
      estimatedCommissionMinor: affiliatePoolMinor(p.priceMinor, rateBps),
      salesCount: p.salesCount,
      ratingAvg: p.ratingAvg,
      isFeatured: p.isFeatured,
      addedAt: p.createdAt.toISOString(),
    };
  });

  // Rate sort + filter are applied post-map (effective rate is derived).
  const filtered = opts.minRateBps ? mapped.filter((m) => m.rateBps >= opts.minRateBps!) : mapped;
  const sorted = opts.sort === "rate" ? [...filtered].sort((a, b) => b.rateBps - a.rateBps) : filtered;
  return { rows: sorted, total };
}

// ---------------------------------------------------------------------------
// Seller affiliate report (spec §7) — scoped to the seller's OWN store.
// ---------------------------------------------------------------------------
export async function sellerAffiliateReport(storeId: string, days = 30) {
  const since = daysAgo(days);
  const [products, commissions, reversalAgg] = await Promise.all([
    db.product.findMany({
      where: { storeId },
      select: { id: true, affiliateEnabled: true, affiliateRateBps: true, title: true, slug: true, salesCount: true },
    }),
    db.affiliateCommission.findMany({
      where: { storeId, createdAt: { gte: since } },
      select: {
        id: true, status: true, commissionableBaseMinor: true, poolMinor: true,
        rateBps: true, orderNumber: true, createdAt: true,
        entries: { select: { role: true, amountMinor: true, reversedMinor: true, status: true } },
      },
    }),
    db.refund.aggregate({
      where: { order: { storeId }, status: "processed", processedAt: { gte: since } },
      _sum: { affiliateReversalMinor: true },
    }),
  ]);

  const enrolled = products.filter((p) => p.affiliateEnabled);
  const pool = commissions.reduce((s, c) => s + c.poolMinor, 0);
  const directAlloc = commissions.reduce((s, c) => s + (c.entries.find((e) => e.role === "direct")?.amountMinor ?? 0), 0);
  const sponsorAlloc = commissions.reduce((s, c) => s + (c.entries.find((e) => e.role === "sponsor")?.amountMinor ?? 0), 0);
  const clicks = await db.affiliateAttributionTouch.count({
    where: { clickedAt: { gte: since }, OR: [{ storeId }, { productId: { in: products.map((p) => p.id) } }] },
  }).catch(() => 0);
  const productViews = await db.analyticsEvent.count({
    where: { storeId, eventType: "product_view", affiliateId: { not: null }, createdAt: { gte: since } },
  }).catch(() => 0);

  return {
    enrolledCount: enrolled.length,
    totalProducts: products.length,
    clicks,
    productViews,
    attributedOrders: commissions.length,
    eligibleSalesMinor: commissions.reduce((s, c) => s + c.commissionableBaseMinor, 0),
    totalPoolMinor: pool,
    directAllocationMinor: directAlloc,
    sponsorAllocationMinor: sponsorAlloc,
    reversalMinor: reversalAgg._sum.affiliateReversalMinor ?? 0,
    currentLiabilityMinor: commissions
      .filter((c) => !["reversed"].includes(c.status))
      .reduce((s, c) => s + c.poolMinor - c.entries.reduce((r, e) => r + e.reversedMinor, 0), 0),
    recentCommissions: commissions
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 50)
      .map((c) => ({
        orderNumber: c.orderNumber,
        createdAt: c.createdAt.toISOString(),
        status: c.status,
        baseMinor: c.commissionableBaseMinor,
        rateBps: c.rateBps,
        poolMinor: c.poolMinor,
        directMinor: c.entries.find((e) => e.role === "direct")?.amountMinor ?? 0,
        sponsorMinor: c.entries.find((e) => e.role === "sponsor")?.amountMinor ?? 0,
        reversedMinor: c.entries.reduce((s, e) => s + e.reversedMinor, 0),
      })),
  };
}

// ---------------------------------------------------------------------------
// Admin reconciliation (spec §9) — the 7-point report.
// ---------------------------------------------------------------------------
export async function affiliateReconciliation() {
  const [commissionAgg, entryAgg, payoutAgg] = await Promise.all([
    db.affiliateCommission.aggregate({ _sum: { poolMinor: true }, _count: true }),
    db.affiliateCommissionEntry.groupBy({
      by: ["status"],
      _sum: { amountMinor: true, reversedMinor: true },
      _count: true,
    }),
    db.affiliatePayout.groupBy({
      by: ["status"],
      _sum: { amountMinor: true },
      _count: true,
    }),
  ]);

  // Ledger mirror: PLATFORM:AFFILIATE_LIABILITY balance (credit − debit).
  const lines = await db.ledgerLine.findMany({
    where: { accountCode: "PLATFORM:AFFILIATE_LIABILITY" },
    select: { direction: true, amountMinor: true },
  });
  const ledgerBalance = lines.reduce((s, l) => s + (l.direction === "credit" ? l.amountMinor : -l.amountMinor), 0);

  const entrySum = (status: string) => entryAgg.find((g) => g.status === status)?._sum.amountMinor ?? 0;
  const entryCount = (status: string) => entryAgg.find((g) => g.status === status)?._count ?? 0;
  const entryReversed = (status: string) => entryAgg.find((g) => g.status === status)?._sum.reversedMinor ?? 0;

  // (1) Expected pool = Σ commission.poolMinor (the seller-funded liability
  //     origin). (2) Allocated = Σ entry.amountMinor across BOTH roles — by
  //     construction direct + sponsor === pool per commission, so allocated
  //     must equal expected exactly; any excess = corruption.
  const expectedPoolMinor = commissionAgg._sum.poolMinor ?? 0;
  const allocatedMinor = entryAgg.reduce((s, g) => s + (g._sum.amountMinor ?? 0), 0);
  // (3-6) Status buckets (net of reversals) + payouts + reversal total.
  const netOf = (status: string) => entrySum(status) - entryReversed(status);
  const heldMinor = netOf("held");
  const availableMinor = netOf("available") + netOf("approved"); // approved matures by clock
  const paidOutMinor = payoutAgg.find((g) => g.status === "paid")?._sum.amountMinor ?? 0;
  const reversalsMinor = entryAgg.reduce((s, g) => s + (g._sum.reversedMinor ?? 0), 0);
  // (7) Remaining liability = the ledger's AFFILIATE_LIABILITY balance
  //     (credits: pools; debits: reversals + payout initiations).
  const remainingLiabilityMinor = ledgerBalance;

  return {
    points: {
      expectedPoolMinor,
      allocatedMinor,
      heldMinor,
      availableMinor,
      paidOutMinor,
      reversalsMinor,
      remainingLiabilityMinor,
    },
    ledgerBalanceMinor: ledgerBalance,
    // Invariant: allocations never exceed the pool, and the ledger liability
    // never goes negative (over-payment impossible by construction).
    invariantOk: allocatedMinor <= expectedPoolMinor && ledgerBalance >= 0,
    commissionCount: commissionAgg._count,
    entriesByStatus: entryAgg.map((g) => ({ status: g.status, count: g._count, amountMinor: g._sum.amountMinor ?? 0, reversedMinor: g._sum.reversedMinor ?? 0 })),
    payoutsByStatus: payoutAgg.map((g) => ({ status: g.status, count: g._count, amountMinor: g._sum.amountMinor ?? 0 })),
    pendingEntryCount: entryCount("pending"),
  };
}
