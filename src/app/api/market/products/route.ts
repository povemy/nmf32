import { db } from "@/lib/db";
import { handle, okPaged, getPagination } from "@/lib/api";
import { productCardInclude, toProductCard, type ProductWithRelations } from "../../_shared/product-card";
import { publicCache, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";
import { normalizeSearchQuery } from "@/lib/search-normalize";
import { tokenize, buildTokenWhere, scoreProduct } from "../_shared/search";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

// store "marketplace opt-in" lives on the Seller model (schema) — filter through relation.
// C1.3 (seller publication governance): defense-in-depth — store.status "live"
// alone is not proof of eligibility; the store's seller must ALSO be
// admin-approved (status "active"), so a bypassed or legacy store status can
// never surface ineligible inventory on the public market.
const liveStore = { is: { status: "live", seller: { is: { status: "active", marketplaceOptIn: true } } } };

// ============================================================================
// PHASE 2.4 / C2.2 — main marketplace search now uses the shared tokenized
// search engine (src/app/api/market/_shared/search.ts), fixing the audit
// finding that this route did a CASE-SENSITIVE single-field substring match
// (`title: { contains: search }` — "pulse" found nothing while "Pulse" worked).
// Behaviour after this change:
//   • Case-insensitive (Prisma mode:"insensitive" → Postgres ILIKE).
//   • Tokenized multi-word queries: buildTokenWhere requires EVERY token to
//     hit ≥1 searchable field (title, description, category name, store name),
//     in any order — "earbuds pulse" matches "Pulse ANC Earbuds".
//   • Partial matching: the engine's tokenizer preserves user-typed `%`
//     wildcards ("cer%" → prefix-style LIKE), unchanged from suggest/related.
//   • Relevance ranking (sort=relevance, the shopper UI's default for search
//     mode): scoreProduct ranks a DETERMINISTIC candidate window in JS —
//     phrase-in-title ▸ all-tokens-in-title ▸ per-token title/category/store/
//     description weights, popularity/rating only nudging ties.
//   • Deterministic pagination: every SQL ordering appends the unique `id` as
//     the final tiebreaker, and the ranked order breaks ties on
//     (score ▸ salesCount ▸ ratingAvg ▸ createdAt ▸ id) — identical input data
//     always yields identical pages, so offset pagination never reshuffles.
//   • Category/store filters, the {data, meta} envelope, cache-key guard and
//     tag-based invalidation semantics are PRESERVED unchanged (below).
// ============================================================================

/** Relevance is ranked in JS over this bounded, deterministic candidate window
 *  (top matches by popularity, `id` tiebreak). `total` reported to the client
 *  is capped at the window so "load more" pagination stays consistent — we
 *  never promise more ranked rows than the window can serve (the standard
 *  e-commerce "top N results" pattern; 200 = 10 pages × 20). */
const RELEVANCE_CANDIDATE_CAP = 200;

/** Row shape used for in-memory relevance ranking. Prisma `include` returns
 *  ALL scalar fields (description, createdAt, …) plus the card relations, so
 *  every scoreProduct input is already on each row. createdAt may be a Date
 *  (live row) or ISO string (defensive — cached round-trips). */
type RankableRow = ProductWithRelations & { description: string | null; createdAt: Date | string };

const ts = (v: Date | string): number => (v instanceof Date ? v.getTime() : Date.parse(v));

/** Deterministic relevance comparator: score desc, then popularity, rating,
 *  recency, and finally the unique `id` — the last resort tiebreak that makes
 *  the ordering (and therefore every page slice of it) fully deterministic. */
function byRelevance(a: { p: RankableRow; s: number }, b: { p: RankableRow; s: number }): number {
  if (b.s !== a.s) return b.s - a.s;
  const sales = (b.p.salesCount ?? 0) - (a.p.salesCount ?? 0);
  if (sales !== 0) return sales;
  const rating = (b.p.ratingAvg ?? 0) - (a.p.ratingAvg ?? 0);
  if (rating !== 0) return rating;
  const time = ts(b.p.createdAt) - ts(a.p.createdAt);
  if (time !== 0) return time;
  return a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0;
}

// PHASE 2 / C: public product listing — cached 45 s per (search, category,
// sort, page, size) tuple; the products tag is busted on every product
// mutation. Listing price/stock displays are ADVISORY ONLY — checkout
// revalidates both transactionally (CAS-guarded) and can never be served from
// this cache.
// C2.2 cache-key protection is unchanged: the caller normalizes `search` with
// normalizeSearchQuery BEFORE it becomes a cache key — length capped at 80
// chars (over-length is TRUNCATED, never a giant cache key), control chars
// stripped, whitespace collapsed; whitespace-only junk degrades to the
// unfiltered listing and mints no cache entry. The loader stays a PURE
// function of its args, so the relevance branch is cache-safe too.
const loadProducts = publicCache(
  async (search: string, categorySlug: string, sort: string, page: number, size: number, onSale: boolean) => {
    const skip = (page - 1) * size;
    const where: Prisma.ProductWhereInput = { status: "active", store: liveStore };

    // Work order 14: on-sale listing (the flash-deals “View all deals"
    // destination). SQL-level superset — an active variant with a compare-at
    // price set. Cross-field compareAt>price cannot be expressed in a Prisma
    // where, so a legacy row with compareAt ≤ price can appear WITHOUT a
    // discount badge (rare data shape); the homepage flash-deals section
    // applies the strict compareAt>price filter on top of the same data.
    // Prices/discounts are ALWAYS the seller's own variant data — this filter
    // grants nothing.
    if (onSale) {
      where.variants = { some: { isActive: true, compareAtPriceMinor: { gt: 0 } } };
    }

    // C2.2: tokenized, case-insensitive, multi-word search across title,
    // description, category name and store name (shared engine). No tokens
    // (empty/whitespace query) ⇒ no search filter ⇒ plain browse listing,
    // exactly as before.
    const tokens = tokenize(search);
    const tokenWhere = buildTokenWhere(tokens);
    if (tokenWhere) where.AND = [tokenWhere];

    if (categorySlug) {
      const cat = await db.category.findUnique({ where: { slug: categorySlug } });
      if (cat) {
        const children = await db.category.findMany({ where: { parentId: cat.id }, select: { id: true } });
        where.categoryId = { in: [cat.id, ...children.map((c) => c.id)] };
      } else {
        where.categoryId = "__none__";
      }
    }

    // ---- C2.2 relevance ranking ("Best match") ----
    // Only meaningful with a real query; without tokens it falls through to the
    // standard deterministic sorts below.
    if (tokenWhere && sort === "relevance") {
      const [candidates, totalMatches] = await Promise.all([
        // Deterministic candidate window: the top RELEVANCE_CANDIDATE_CAP
        // matches by popularity (id tiebreak) — same data ⇒ same window ⇒
        // same ranked order ⇒ stable pages.
        db.product.findMany({
          where,
          include: productCardInclude,
          orderBy: [{ salesCount: "desc" }, { id: "asc" }],
          take: RELEVANCE_CANDIDATE_CAP,
        }),
        db.product.count({ where }),
      ]);
      const rows = candidates
        .map((p) => ({ p: p as RankableRow, s: scoreProduct(p as RankableRow, tokens, search) }))
        .sort(byRelevance)
        .slice(skip, skip + size)
        .map(({ p }) => p);
      return { rows, total: Math.min(totalMatches, RELEVANCE_CANDIDATE_CAP) };
    }

    // ---- standard sorts — deterministic via the unique `id` tiebreaker ----
    let orderBy: Prisma.ProductOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "asc" }];
    if (sort === "price_asc") orderBy = [{ priceMinor: "asc" }, { id: "asc" }];
    else if (sort === "price_desc") orderBy = [{ priceMinor: "desc" }, { id: "asc" }];
    else if (sort === "popular") orderBy = [{ salesCount: "desc" }, { id: "asc" }];

    const [rows, total] = await Promise.all([
      db.product.findMany({ where, include: productCardInclude, orderBy, skip, take: size }),
      db.product.count({ where }),
    ]);
    return { rows, total };
  },
  ["market-products"],
  { ttl: 45, tags: [PUBLIC_CACHE_TAGS.products] }
);

// GET /api/market/products?search=&category=&sort=relevance|newest|price_asc|price_desc|popular&page=&size=&onSale=1
// `search` remains SUBMIT-ONLY from the shopper UI (Enter / search button — no
// per-keystroke requests); pagination, filters and sorting all reuse the
// submitted keyword, exactly as before.
export const GET = handle(async (req: Request) => {
  const url = new URL(req.url);
  const { page, size } = getPagination(url);
  // PHASE 2.1 (§9-B): normalize BEFORE the value becomes a cache key — bounded
  // cardinality, no entries for whitespace/control-char/over-length junk.
  const search = normalizeSearchQuery(url.searchParams.get("search"));
  const categorySlug = url.searchParams.get("category")?.trim() ?? "";
  const sort = url.searchParams.get("sort") ?? "newest";
  const onSale = ["1", "true"].includes((url.searchParams.get("onSale") ?? "").toLowerCase());

  const { rows, total } = await loadProducts(search, categorySlug, sort, page, size, onSale);

  return okPaged(rows.map((p) => toProductCard(p as ProductWithRelations)), { page, size, total });
});
