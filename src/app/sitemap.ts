// Public sitemap (Phase 9 technical SEO) — live stores + their active products.
// Draft/claim/generating stores are deliberately excluded (never indexed).
//
// CHUNKING THRESHOLD (Phase 2.4): the catalog is small (tens of stores), so a
// single sitemap file is correct here. When URLs exceed ~5,000 (50k is the
// hard file limit; 5k keeps fetch latency + memory comfortably bounded),
// split: turn this route into /sitemap/[n].ts emitting ≤5k entries each plus
// a /sitemap-index route listing them, and point robots.ts at the index.
import type { MetadataRoute } from "next";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.PUBLIC_APP_ORIGIN || "http://localhost:3000";
  const stores = await db.store.findMany({
    // C1.3 (seller publication governance): index only live stores of
    // admin-approved sellers — ineligible storefronts must never be surfaced
    // to crawlers either (same rule as the public market/storefront queries).
    where: { status: "live", seller: { is: { status: "active" } } },
    select: { slug: true, updatedAt: true, products: { where: { status: "active" }, select: { slug: true, updatedAt: true } } },
  });
  const entries: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified: new Date(), changeFrequency: "daily", priority: 1 },
  ];
  for (const s of stores) {
    entries.push({ url: `${base}/?sf=${s.slug}`, lastModified: s.updatedAt, changeFrequency: "daily", priority: 0.8 });
    for (const p of s.products) {
      entries.push({ url: `${base}/?sf=${s.slug}&sp=${p.slug}`, lastModified: p.updatedAt, changeFrequency: "weekly", priority: 0.6 });
    }
  }
  return entries;
}
