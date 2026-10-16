// Import normalisation helpers (Phase 6) — slugs, categories, description sanitising, SEO derivation.
import { db } from "@/lib/db";

export function slugBase(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "item";
}

/** Generate a unique product slug within a store (suffix -2, -3… on conflict). */
export async function slugifyProductTitle(storeId: string, title: string): Promise<string> {
  const base = slugBase(title);
  let candidate = base;
  for (let n = 2; n < 50; n++) {
    const clash = await db.product.findFirst({ where: { storeId, slug: candidate }, select: { id: true } });
    if (!clash) return candidate;
    candidate = `${base}-${n}`;
  }
  return `${base}-${Date.now()}`;
}

/** Generate a unique store slug globally. */
export async function slugifyStoreName(name: string): Promise<string> {
  const base = slugBase(name);
  let candidate = base;
  for (let n = 2; n < 50; n++) {
    const clash = await db.store.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!clash) return candidate;
    candidate = `${base}-${n}`;
  }
  return `${base}-${Date.now()}`;
}

/** Match an existing global Category by name (case-insensitive) or create it. */
export async function mapCategory(hint: string | null | undefined): Promise<string | null> {
  if (!hint || !hint.trim()) return null;
  const name = hint.trim().slice(0, 60);
  const existing = await db.category.findFirst({ where: { name: { equals: name, } }, select: { id: true } });
  if (existing) return existing.id;
  // case-insensitive second pass
  const all = await db.category.findMany({ select: { id: true, name: true } });
  const ci = all.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (ci) return ci.id;
  const created = await db.category.create({
    data: { name, slug: `${slugBase(name)}-${(Math.abs(hashStr(name)) % 46656).toString(36)}` },
    select: { id: true },
  });
  return created.id;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

/** Conservative HTML sanitiser: strips scripts/styles/iframes/event handlers. */
export function sanitiseDescriptionHtml(html: string | null | undefined, maxLen = 20000): string | null {
  if (!html) return null;
  let out = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[\s\S]*?>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "");
  if (out.length > maxLen) out = out.slice(0, maxLen) + "…";
  return out.trim() || null;
}

/** Plain text from simple HTML (for SEO meta descriptions). */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function deriveProductSeo(title: string, descriptionHtml: string | null | undefined, storeName: string) {
  const seoTitle = `${title} | ${storeName}`.slice(0, 60);
  const text = htmlToText(descriptionHtml);
  const seoDescription = (text ? text : `Buy ${title} from ${storeName} on NOMOFEE.`).slice(0, 155);
  return { seoTitle, seoDescription };
}
