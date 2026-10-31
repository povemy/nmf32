// Shared product-card shaping for market + storefront APIs (Task 2-b scope).
// ProductCard = {id, slug, title, priceMinor, compareAtPriceMinor, imageUrl,
//                storeName, storeSlug, ratingAvg, ratingCount, salesCount, categoryName}
import { parseJson } from "@/lib/json";
import { db } from "@/lib/db";
import { sanitizeExternalUrl } from "@/lib/url-guard";

export const FALLBACK_IMG = "/api/img/fallback?w=600&h=600";

export const productCardInclude = {
  images: { orderBy: { sortOrder: "asc" as const } },
  variants: { orderBy: { createdAt: "asc" as const } },
  store: { select: { id: true, name: true, slug: true, status: true } },
  category: { select: { id: true, name: true, slug: true } },
};

// id/stock optional so callers holding full Prisma variants can read them
// (e.g. the cart drawer upsell payload) while toProductCard keeps working.
type VariantLike = { priceMinor: number; compareAtPriceMinor: number | null; isActive?: boolean; id?: string; stock?: number };

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

/** Store social links → render-side map. D2: every value is run through the
 *  URL guard and entries that fail (legacy `javascript:` rows, malformed
 *  junk) are dropped — only http(s) links ever reach an href. Belt and
 *  braces with the save-side guard in /api/store/settings. */
export function parseSocial(json: string | null | undefined): Record<string, string> {
  const raw: unknown = parseJson<unknown>(json, {});
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [network, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value == null || value === "") continue;
    const safe = sanitizeExternalUrl(String(value), { maxLength: 500 });
    if (safe && network) out[network] = safe;
  }
  return out;
}

/** The store's product-card typography (Feature: seller card customization).
 *  Returns null when the store never saved a style — shopper surfaces then
 *  render the platform defaults. */
export async function cardStyleFor(storeId: string) {
  const style = await db.productCardStyle.findUnique({ where: { storeId } });
  if (!style) return null;
  return {
    nameFont: style.nameFont,
    nameSize: style.nameSize,
    nameAlign: style.nameAlign,
    priceFont: style.priceFont,
    priceSize: style.priceSize,
    priceAlign: style.priceAlign,
  };
}
