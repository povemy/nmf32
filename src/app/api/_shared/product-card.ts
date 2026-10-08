// Shared product-card shaping for market + storefront APIs (Task 2-b scope).
// ProductCard = {id, slug, title, priceMinor, compareAtPriceMinor, imageUrl,
//                storeName, storeSlug, ratingAvg, ratingCount, salesCount, categoryName}
import { parseJson } from "@/lib/json";

export const FALLBACK_IMG = "/api/img/fallback?w=600&h=600";

export const productCardInclude = {
  images: { orderBy: { sortOrder: "asc" as const } },
  variants: { orderBy: { createdAt: "asc" as const } },
  store: { select: { id: true, name: true, slug: true, status: true } },
  category: { select: { id: true, name: true, slug: true } },
};

type VariantLike = { priceMinor: number; compareAtPriceMinor: number | null; isActive?: boolean };

export function minVariant(variants: VariantLike[]): VariantLike | null {
  const active = variants.filter((v) => v.isActive !== false);
  const pool = active.length > 0 ? active : variants;
  if (pool.length === 0) return null;
  return pool.reduce((min, v) => (v.priceMinor < min.priceMinor ? v : min), pool[0]);
}

export type ProductWithRelations = {
  id: string;
  slug: string;
  title: string;
  priceMinor: number;
  salesCount: number;
  ratingAvg: number;
  ratingCount: number;
  images: { url: string; sortOrder: number }[];
  variants: VariantLike[];
  store: { name: string; slug: string };
  category?: { name: string } | null;
};

export function toProductCard(p: ProductWithRelations) {
  const mv = minVariant(p.variants);
  const priceMinor = mv ? mv.priceMinor : p.priceMinor;
  const compareAtPriceMinor = mv?.compareAtPriceMinor ?? null;
  const imageUrl = p.images[0]?.url ?? FALLBACK_IMG;
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    priceMinor,
    compareAtPriceMinor,
    imageUrl,
    storeName: p.store.name,
    storeSlug: p.store.slug,
    ratingAvg: p.ratingAvg,
    ratingCount: p.ratingCount,
    salesCount: p.salesCount,
    categoryName: p.category?.name ?? null,
  };
}

export function parseSocial(json: string | null | undefined): Record<string, string> {
  return parseJson<Record<string, string>>(json, {});
}
