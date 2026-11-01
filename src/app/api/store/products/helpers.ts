// Product helpers for seller catalog routes (not a route file — helpers only).
import { db } from "@/lib/db";
import { ApiError, slugify } from "@/lib/api";
import { parseJson } from "@/lib/json";
import { sanitizeExternalUrl } from "@/lib/url-guard";
import { BANNED_KEYWORDS, matchFlags } from "@/lib/product-moderation";

export { BANNED_KEYWORDS, matchFlags };

/** First N products of a store go to moderation (setting moderation.first_n, default 5). */
export async function moderationStatus(storeId: string): Promise<"pending_review" | "active"> {
  const setting = await db.setting.findUnique({ where: { key: "moderation.first_n" } });
  const firstN = Math.max(0, parseJson<number>(setting?.valueJson, 5));
  const count = await db.product.count({ where: { storeId, status: { not: "archived" } } });
  return count < firstN ? "pending_review" : "active";
}

export async function uniqueSlug(storeId: string, title: string): Promise<string> {
  const base = slugify(title) || "product";
  const existing = await db.product.findMany({
    where: { storeId, slug: { startsWith: base } },
    select: { slug: true },
  });
  const taken = new Set(existing.map((e) => e.slug));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** D2 — sanitize the product images array at save time. Product images are
 *  seller-controlled URLs rendered to every shopper, so each entry must be an
 *  http(s) URL or a site-relative path ("/api/img/…", "/uploads/…"), never
 *  javascript:/data:/protocol-relative. Invalid entries are REJECTED (400
 *  VALIDATION naming the input index) — the seller curates this list actively
 *  in the product form, and a silent drop would look like a save bug. Blank
 *  entries keep the legacy filter(Boolean) semantics and drop out. */
export function sanitizeProductImages(raw: unknown[]): string[] {
  const out: string[] = [];
  raw.forEach((entry, i) => {
    const url = String(entry).trim();
    if (!url) return;
    const safe = sanitizeExternalUrl(url, { allowRelative: true });
    if (!safe) {
      throw new ApiError(400, "VALIDATION", `images[${i}] must be a valid http(s) or site-relative URL`);
    }
    out.push(safe);
  });
  return out;
}

export type VariantInput = {
  name: string;
  optionName: string | null;
  optionValue: string | null;
  priceMinor: number;
  compareAtPriceMinor: number | null;
  stock: number;
  moq: number;
  lowStockThreshold: number;
  sku: string | null;
};

export function validateVariants(raw: unknown): VariantInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError(400, "VALIDATION", "At least one variant is required");
  }
  return raw.map((v) => {
    const vv = v as Record<string, unknown>;
    const priceMinor = Math.round(Number(vv.priceMinor));
    if (!Number.isFinite(priceMinor) || priceMinor < 0) {
      throw new ApiError(400, "VALIDATION", "Each variant needs a valid priceMinor >= 0");
    }
    const stock = Math.max(0, Math.round(Number(vv.stock ?? 0)) || 0);
    return {
      name: vv.name ? String(vv.name) : "Default",
      optionName: vv.optionName != null ? String(vv.optionName) : null,
      optionValue: vv.optionValue != null ? String(vv.optionValue) : null,
      priceMinor,
      compareAtPriceMinor: vv.compareAtPriceMinor != null ? Math.max(0, Math.round(Number(vv.compareAtPriceMinor))) : null,
      stock,
      // Seller-set minimum order quantity (per item). Defaults to 1 = no minimum.
      moq: Math.max(1, Math.round(Number(vv.moq ?? 1)) || 1),
      lowStockThreshold: vv.lowStockThreshold != null ? Math.max(0, Math.round(Number(vv.lowStockThreshold))) : 5,
      sku: vv.sku != null ? String(vv.sku) : null,
    };
  });
}

export async function ownProduct(storeId: string, id: string) {
  const product = await db.product.findUnique({
    where: { id },
    include: { variants: { orderBy: { createdAt: "asc" } }, images: { orderBy: { sortOrder: "asc" } } },
  });
  if (!product || product.storeId !== storeId) throw new ApiError(404, "NOT_FOUND", "Product not found");
  return product;
}

export function recomputePrice(variants: { priceMinor: number; isActive: boolean }[]): number {
  const active = variants.filter((v) => v.isActive);
  const pool = active.length > 0 ? active : variants;
  return pool.length > 0 ? Math.min(...pool.map((v) => v.priceMinor)) : 0;
}
