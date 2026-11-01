import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { productCardInclude, toProductCard, type ProductWithRelations } from "../../../_shared/product-card";
import { tokenize, buildAnyTokenWhere, scoreProduct } from "../../_shared/search";

export const dynamic = "force-dynamic";

// C1.3 (seller publication governance): defense-in-depth — a live store is only
// publicly sellable while its seller is admin-approved (status "active").
const liveStore = { is: { status: "live", seller: { is: { status: "active", marketplaceOptIn: true } } } };

// GET /api/market/search/related?q=&exclude=id,id&limit=8
// "Standard e-commerce" step of the advanced search system: suggest a few
// products similar to the searched one. Matches ANY token (looser than the
// results page), ranks by token overlap + popularity, excludes ids already
// shown in the main results, and falls back to marketplace bestsellers when
// nothing overlaps — so the suggestion rail is never empty.
export const GET = handle(async (req: Request) => {
  const url = new URL(req.url);
  const raw = (url.searchParams.get("q") ?? "").trim();
  const exclude = new Set(
    (url.searchParams.get("exclude") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const limit = Math.min(12, Math.max(1, parseInt(url.searchParams.get("limit") ?? "8", 10) || 8));
  const tokens = tokenize(raw);

  const baseWhere = { status: "active" as const, store: liveStore, id: { notIn: [...exclude] } };

  let cards: ReturnType<typeof toProductCard>[] = [];

  const anyWhere = buildAnyTokenWhere(tokens);
  if (anyWhere) {
    const rows = await db.product.findMany({
      where: { AND: [baseWhere, anyWhere] },
      include: productCardInclude,
      orderBy: { salesCount: "desc" },
      take: 60,
    });
    cards = rows
      .map((p) => ({ p: p as ProductWithRelations, s: scoreProduct(p as ProductWithRelations, tokens, raw) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map(({ p }) => toProductCard(p));
  }

  if (cards.length < limit) {
    const have = new Set(cards.map((c) => c.id));
    // Fallback 1 — marketplace bestsellers; Fallback 2 — newest listings.
    for (const fill of [
      { ...baseWhere, salesCount: { gt: 0 } },
      baseWhere,
    ]) {
      if (cards.length >= limit) break;
      const fillers = await db.product.findMany({
        where: fill,
        include: productCardInclude,
        orderBy: fill === baseWhere ? { createdAt: "desc" } : { salesCount: "desc" },
        take: limit * 2,
      });
      for (const f of fillers) {
        if (cards.length >= limit) break;
        if (have.has(f.id)) continue;
        have.add(f.id);
        cards.push(toProductCard(f as ProductWithRelations));
      }
    }
  }

  return ok({ products: cards });
});
