import { db } from "@/lib/db";
import { handle, getPagination, okPaged } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { productCardInclude, toProductCard } from "../../_shared/product-card";

export const dynamic = "force-dynamic";

const SELLING_FAST_SALES = 40;
const SPAYLATER_MIN_MINOR = 10_000; // RM100+

// GET /api/me/recommendations — "You May Also Like" feed for the buyer dashboard.
// Personalised when possible: categories the shopper recently viewed/liked are
// boosted first; the rest of the feed fills with the most popular live products.
// Supports ?sort=popular|sales|new and pagination (?page&size).
export const GET = handle(async (req: Request) => {
  await requireShopper();
  const url = new URL(req.url);
  const { page, size, skip, take } = getPagination(url, 40);
  const sort = url.searchParams.get("sort") ?? "popular";
  const orderBy =
    sort === "sales"
      ? [{ salesCount: "desc" as const }, { ratingCount: "desc" as const }]
      : sort === "new"
        ? [{ publishedAt: "desc" as const }, { createdAt: "desc" as const }]
        : [{ ratingCount: "desc" as const }, { salesCount: "desc" as const }];

  // Personalisation seeds — most recent 30 activities, categories + product ids.
  const acts = await db.userActivity.findMany({
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { productId: true, activityType: true, product: { select: { categoryId: true } } },
  });
  const viewedIds = [...new Set(acts.map((a) => a.productId))];
  const catIds = [...new Set(acts.map((a) => a.product.categoryId).filter((x): x is string => Boolean(x)))];

  const baseWhere = { status: "active" as const };
  const liveScope = { store: { status: "live" as const } };

  // Round 1 — boosted categories (fresh items the shopper hasn't seen yet).
  const boostedWhere =
    catIds.length > 0
      ? { ...baseWhere, ...liveScope, categoryId: { in: catIds }, id: { notIn: viewedIds } }
      : null;
  const primary = boostedWhere
    ? await db.product.findMany({
        where: boostedWhere,
        include: productCardInclude,
        orderBy,
        take,
      })
    : [];

  let rows = primary;
  // Round 2 — top up with globally popular live products.
  if (rows.length < take) {
    const exclude = [...viewedIds, ...rows.map((r) => r.id)];
    const fill = await db.product.findMany({
      where: { ...baseWhere, ...liveScope, id: { notIn: exclude } },
      include: productCardInclude,
      orderBy,
      skip: Math.max(0, skip - (catIds.length > 0 ? 0 : 0)),
      take: take - rows.length,
    });
    rows = [...rows, ...fill];
  }

  const total = await db.product.count({ where: { ...baseWhere, ...liveScope } });

  return okPaged(
    {
      products: rows.map((p) => {
        const card = toProductCard(p);
        const stock = p.variants.reduce((s, v) => s + (v.isActive === false ? 0 : v.stock), 0);
        return {
          ...card,
          inStock: stock > 0,
          isFeatured: p.isFeatured,
          isSellingFast: p.salesCount >= SELLING_FAST_SALES,
          spayLaterEligible: card.priceMinor >= SPAYLATER_MIN_MINOR,
        };
      }),
    },
    { page, size, total }
  );
});
