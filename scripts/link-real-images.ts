// ============================================================================
// link-real-images.ts — repair broken image URLs across the database.
//
// Background: an earlier pipeline stored image URLs under the `/gen/...`
// prefix (e.g. /gen/products/x.png, /gen/stores/s-hero.png). That prefix is
// served by no route in this codebase — every such URL 404s, so ALL product
// photos, store logos/banners, hero banners and CMS hero images disappeared
// from the UI. The real photos live in `public/`:
//   public/products/<slug>.png            → /products/<slug>.png
//   public/stores/<slug>-logo.png         → /stores/<slug>-logo.png
//   public/stores/<slug>-banner.png       → /stores/<slug>-banner.png
//   public/banners/hero-merdeka.png       → /banners/hero-merdeka.png
//   public/banners/hero-zero-commission.png
// For rows whose photo does not exist (second gallery angles, category tiles,
// campaign art) we fall back to the app's deterministic /api/img placeholder
// service — the established offline convention — so nothing is ever broken.
//
// Idempotent: rows whose URL no longer contains /gen/ are skipped, so the
// script can be re-run safely. All queries run strictly sequentially to stay
// within the Supavisor session pool (pool_size 15, connection_limit 10).
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db";

const PUBLIC_DIR = path.join(process.cwd(), "public");

function listFiles(dir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(path.join(PUBLIC_DIR, dir)));
  } catch {
    return new Set();
  }
}

const productFiles = listFiles("products");
const storeFiles = listFiles("stores");
const bannerFiles = listFiles("banners");

function humanize(name: string): string {
  return name.replace(/[-_]+/g, " ").replace(/\.[a-z0-9]+$/i, "").trim();
}

function placeholder(seed: string, w: number, h: number): string {
  return `/api/img/${encodeURIComponent(seed)}?w=${w}&h=${h}&label=${encodeURIComponent(humanize(seed))}`;
}

/** Map one /gen/... URL to a working same-origin URL. */
function mapUrl(url: string): string {
  if (!url || !url.includes("/gen/")) return url;
  const tail = url.split("/gen/")[1] ?? "";
  const [kind, ...rest] = tail.split("/");
  const file = rest.join("/") || "";
  const base = file.replace(/\.[a-z0-9]+$/i, "");

  if (kind === "products") {
    if (productFiles.has(file)) return `/products/${file}`;
    return placeholder(base, 900, 900);
  }
  if (kind === "stores") {
    if (base.endsWith("-logo") && storeFiles.has(file)) return `/stores/${file}`;
    if (base.endsWith("-hero")) {
      const bannerFile = base.replace(/-hero$/, "-banner") + ".png";
      if (storeFiles.has(bannerFile)) return `/stores/${bannerFile}`;
      return placeholder(base.replace(/-hero$/, "-storefront"), 1600, 640);
    }
    if (storeFiles.has(file)) return `/stores/${file}`;
    return placeholder(base, 400, 400);
  }
  if (kind === "banners") {
    const aliases: Record<string, string> = {
      "banner-merdeka": "hero-merdeka.png",
      "banner-zero": "hero-zero-commission.png",
    };
    const mapped = aliases[base];
    if (mapped && bannerFiles.has(mapped)) return `/banners/${mapped}`;
    if (bannerFiles.has(file)) return `/banners/${file}`;
    return placeholder(base, 1600, 520);
  }
  if (kind === "categories") {
    return placeholder(`cat-${base}`, 400, 300);
  }
  if (kind === "campaigns") {
    return placeholder(`campaign-${base}`, 1200, 630);
  }
  return placeholder(base || "image", 800, 600);
}

/** Rewrite every /gen/... URL inside a JSON string column. */
function mapJson(json: string | null): string | null {
  if (!json || !json.includes("/gen/")) return json;
  return json.replace(/\/gen\/[a-zA-Z0-9\-._/]+/g, (m) => mapUrl(m));
}

async function main() {
  const report: string[] = [];
  let updated = 0;

  // 1) Product gallery images ------------------------------------------------
  const imgs = await db.productImage.findMany({
    select: { id: true, url: true, product: { select: { slug: true } } },
  });
  for (const img of imgs) {
    const next = mapUrl(img.url);
    if (next !== img.url) {
      await db.productImage.update({ where: { id: img.id }, data: { url: next } });
      report.push(`ProductImage ${img.product?.slug ?? img.id}: ${img.url} -> ${next}`);
      updated++;
    }
  }

  // 2) Store logos + banners -------------------------------------------------
  const stores = await db.store.findMany({ select: { id: true, slug: true, logoUrl: true, bannerUrl: true } });
  for (const s of stores) {
    const logo = mapUrl(s.logoUrl);
    const banner = mapUrl(s.bannerUrl);
    if (logo !== s.logoUrl || banner !== s.bannerUrl) {
      await db.store.update({ where: { id: s.id }, data: { logoUrl: logo, bannerUrl: banner } });
      report.push(`Store ${s.slug}: logo ${s.logoUrl} -> ${logo} | banner ${s.bannerUrl} -> ${banner}`);
      updated++;
    }
  }

  // 3) Category tiles --------------------------------------------------------
  const cats = await db.category.findMany({ select: { id: true, slug: true, imageUrl: true } });
  for (const c of cats) {
    const next = mapUrl(c.imageUrl);
    if (next !== c.imageUrl) {
      await db.category.update({ where: { id: c.id }, data: { imageUrl: next } });
      report.push(`Category ${c.slug}: ${c.imageUrl} -> ${next}`);
      updated++;
    }
  }

  // 4) Marketplace hero banners ---------------------------------------------
  const banners = await db.marketplaceBanner.findMany({ select: { id: true, title: true, imageUrl: true } });
  for (const b of banners) {
    const next = mapUrl(b.imageUrl);
    if (next !== b.imageUrl) {
      await db.marketplaceBanner.update({ where: { id: b.id }, data: { imageUrl: next } });
      report.push(`MarketplaceBanner "${b.title}": ${b.imageUrl} -> ${next}`);
      updated++;
    }
  }

  // 5) Campaign theme JSON ---------------------------------------------------
  const campaigns = await db.campaign.findMany({ select: { id: true, name: true, themeJson: true } });
  for (const c of campaigns) {
    const next = mapJson(c.themeJson);
    if (next !== c.themeJson) {
      await db.campaign.update({ where: { id: c.id }, data: { themeJson: next } });
      report.push(`Campaign "${c.name}": themeJson /gen/ refs rewritten`);
      updated++;
    }
  }

  // 6) CMS page builder JSON (published + drafts) ----------------------------
  const pages = await db.cmsPage.findMany({ select: { id: true, slug: true, publishedJson: true, draftJson: true } });
  for (const p of pages) {
    const pub = mapJson(p.publishedJson);
    const draft = mapJson(p.draftJson);
    if (pub !== p.publishedJson || draft !== p.draftJson) {
      await db.cmsPage.update({
        where: { id: p.id },
        data: { publishedJson: pub ?? undefined, draftJson: draft ?? undefined },
      });
      report.push(`CmsPage ${p.slug} (${p.id}): /gen/ refs rewritten`);
      updated++;
    }
  }

  // 7) Verify: no /gen/ URLs remain anywhere ---------------------------------
  const left = await db.productImage.count({ where: { url: { contains: "/gen/" } } })
    + await db.store.count({ where: { OR: [{ logoUrl: { contains: "/gen/" } }, { bannerUrl: { contains: "/gen/" } }] } })
    + await db.category.count({ where: { imageUrl: { contains: "/gen/" } } })
    + await db.marketplaceBanner.count({ where: { imageUrl: { contains: "/gen/" } } });

  console.log(`\n=== link-real-images ===`);
  console.log(`rows updated: ${updated}`);
  for (const r of report) console.log("  " + r);
  console.log(`remaining /gen/ rows in image columns: ${left}`);
  console.log(`available real files — products: ${productFiles.size}, stores: ${storeFiles.size}, banners: ${bannerFiles.size}`);
  await db.$disconnect();
  process.exit(left === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("FAILED:", e);
  await db.$disconnect();
  process.exit(1);
});
