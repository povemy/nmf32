import { db } from "@/lib/db";
import { handle, getPagination, okPaged } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { productCardInclude, toProductCard } from "../../_shared/product-card";

export const dynamic = "force-dynamic";

const SELLING_FAST_SALES = 40;
const PAYLATER_MIN_MINOR = 10_000; // RM100+

// GET /api/me/recommendations — "You May Also Like" feed for the buyer dashboard.
// Personalised when possible: categories the shopper recently viewed/liked are
// boosted first; the rest of the feed fills with the most popular live products.
// Supports ?sort=popular|sales|new and pagination (?page&size).
export const GET = handle(async (req: Request) => {
  const me = await requireShopper();
  const url = new URL(req.url);
  const { page, size, skip, take } = getPagination(url, 40);
  const sort = url.searchParams.get("sort") ?? "popular";
  // Task 34: the id tiebreaker makes the order DETERMINISTIC — rating/sales
  // ties are everywhere (most products sit at 0/0) and Postgres returns tied
  // rows in arbitrary order, which shuffled pages 2+ under the old query.
  const orderBy =
    sort === "sales"
      ? [{ salesCount: "desc" as const }, { ratingCount: "desc" as const }, { id: "asc" as const }]
      : sort === "new"
        ? [{ publishedAt: "desc" as const }, { createdAt: "desc" as const }, { id: "asc" as const }]
        : [{ ratingCount: "desc" as const }, { salesCount: "desc" as const }, { id: "asc" as const }];

  // Personalisation seeds — most recent 30 activities, categories + product ids.
  // (Fixed: previously unscoped — every shopper's personalisation pulled the
  // GLOBAL activity feed; now scoped to the authenticated shopper.)
  const acts = await db.userActivity.findMany({
    where: { userId: me.id },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { productId: true, activityType: true, product: { select: { categoryId: true } } },
  });
  const viewedIds = [...new Set(acts.map((a) => a.productId))];
  const catIds = [...new Set(acts.map((a) => a.product.categoryId).filter((x): x is string => Boolean(x)))];

  const baseWhere = { status: "active" as const };
  const liveScope = { store: { status: "live" as const } };

  // Round 1 — boosted categories, properly PAGINATED. (The old code re-ran
  // this round from the top on EVERY page, so "Load more" page 2 returned
  // the same boosted rows as page 1 — the literal source of React's
  // "two children with the same key" in the feed.)
  const boostedWhere =
    catIds.length > 0
      ? { ...baseWhere, ...liveScope, categoryId: { in: catIds }, id: { notIn: viewedIds } }
      : null;
  const boostedCount = boostedWhere ? await db.product.count({ where: boostedWhere }) : 0;
  const rows =
    boostedWhere && skip < boostedCount
      ? await db.product.findMany({
          where: boostedWhere,
          include: productCardInclude,
          orderBy,
          skip,
          take: Math.min(take, boostedCount - skip),
        })
      : [];

  // Round 2 — top up with the REST of the catalogue (boosted categories are
  // excluded wholesale so the two pools are disjoint and can never repeat
  // each other), offset by how far past the boosted window this page is.
  if (rows.length < take) {
    const fillSkip = Math.max(0, skip - boostedCount);
    const exclude = [...viewedIds, ...rows.map((r) => r.id)];
    const fill = await db.product.findMany({
      where: {
        ...baseWhere,
        ...liveScope,
        ...(catIds.length > 0 ? { categoryId: { notIn: catIds } } : {}),
        id: { notIn: exclude },
      },
      include: productCardInclude,
      orderBy,
      skip: fillSkip,
      take: take - rows.length,
    });
    rows.push(...fill);
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
          payLaterEligible: card.priceMinor >= PAYLATER_MIN_MINOR,
        };
      }),
    },
    { page, size, total }
  );
});
