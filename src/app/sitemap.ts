// Public sitemap (Phase 9 technical SEO) — live stores + their active products.
// Draft/claim/generating stores are deliberately excluded (never indexed).
import type { MetadataRoute } from "next";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.PUBLIC_APP_ORIGIN || "http://localhost:3000";
  const stores = await db.store.findMany({
    where: { status: "live" },
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
