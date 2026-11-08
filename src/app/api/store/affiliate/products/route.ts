import { handle, ok } from "@/lib/api";
import { db } from "@/lib/db";
import { requireActiveSellerStore } from "@/lib/auth";
import { getAffiliateSettings } from "@/lib/affiliate";
import type { AffiliateProductsQuery, AffiliateProductRow, AffiliateProductsData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/store/affiliate/products?enrolled=&q=&page= — the seller's product
// enrollment list (spec §7: review participating products, rates, pause/resume).
export const GET = handle(async (req: Request) => {
  const { store } = await requireActiveSellerStore();
  const settings = await getAffiliateSettings();
  const url = new URL(req.url);
  const enrolledFilter = url.searchParams.get("enrolled");
  const enrolled: AffiliateProductsQuery["enrolled"] =
    enrolledFilter === "true" || enrolledFilter === "false" ? enrolledFilter : undefined;
  const q = url.searchParams.get("q") ?? undefined;
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const size = Math.min(60, Math.max(6, Number(url.searchParams.get("size") ?? 30) || 30));

  const where = {
    storeId: store.id,
    ...(enrolled === "true" ? { affiliateEnabled: true } : enrolled === "false" ? { affiliateEnabled: false } : {}),
    ...(q ? { title: { contains: q, mode: "insensitive" as const } } : {}),
  };
  const [total, products] = await Promise.all([
    db.product.count({ where }),
    db.product.findMany({
      where,
      orderBy: [{ affiliateEnabled: "desc" }, { salesCount: "desc" }],
      skip: (page - 1) * size,
      take: size,
      select: {
        id: true, title: true, slug: true, status: true, priceMinor: true,
        affiliateEnabled: true, affiliateRateBps: true, salesCount: true,
        images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } },
      },
    }),
  ]);
  const rows: AffiliateProductRow[] = products.map((p) => ({
    id: p.id, title: p.title, slug: p.slug, status: p.status, priceMinor: p.priceMinor,
    affiliateEnabled: p.affiliateEnabled,
    effectiveRateBps: Math.min(p.affiliateRateBps ?? store.affiliateDefaultRateBps, settings.maxRateBps),
    rateSource: p.affiliateRateBps != null ? "product" : "store_default",
    salesCount: p.salesCount,
    image: p.images[0]?.url ?? null,
  }));
  const payload: AffiliateProductsData = {
    total,
    page,
    maxRateBps: settings.maxRateBps,
    storeOptIn: store.affiliateOptIn,
    storeDefaultRateBps: store.affiliateDefaultRateBps,
    products: rows,
  };
  return ok(payload);
});
