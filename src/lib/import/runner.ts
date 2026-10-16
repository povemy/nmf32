// Import job runner (Phase 6) — executes the real import pipeline with persisted
// progress, idempotent product upserts, partial-failure capture and honest status
// reporting. Jobs run inline (sandbox has no worker infra) and are resumable.
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { logActivity } from "@/lib/api";
import { randomToken, sha256Hex } from "@/lib/secretbox";
import { transitionStore } from "@/lib/store-lifecycle";
import { defaultHomeSections } from "@/lib/sections";
import { parseJson } from "@/lib/json";
import { assertPublicHost, platformLabel } from "@/lib/marketplaces/resolver";
import { getConnector, resolveForConnector } from "@/lib/marketplaces";
import type { NormalizedProduct, NormalizedShop, Platform } from "@/lib/marketplaces/types";
import { deriveProductSeo, htmlToText, mapCategory, sanitiseDescriptionHtml, slugifyProductTitle, slugifyStoreName } from "./normalise";

type Progress = { discovered?: number; processed?: number; succeeded?: number; skipped?: number; failed?: number; imagesCopied?: number };
type JobSummary = {
  shop?: { name: string; sourceShopId: string; region?: string | null };
  platform?: string;
  platformLabel?: string;
  isFixture?: boolean;
  storeId?: string;
  storeSlug?: string;
  productsOk?: number;
  productsFailed?: number;
  warnings?: string[];
  authorisationRequired?: boolean;
  beginUrl?: string | null;
  missingEnv?: string[];
  claimToken?: string;
  claimExpiresAt?: string;
  claimMethod?: string;
};

async function setPhase(jobId: string, status: string, phaseDetail?: string) {
  await db.importJob.update({ where: { id: jobId }, data: { status, ...(phaseDetail !== undefined ? { phaseDetail } : {}) } });
}

async function bumpProgress(jobId: string, patch: Progress) {
  const job = await db.importJob.findUnique({ where: { id: jobId }, select: { progressJson: true } });
  const cur = parseJson<Progress>(job?.progressJson, {});
  const next = { ...cur, ...patch };
  await db.importJob.update({ where: { id: jobId }, data: { progressJson: JSON.stringify(next) } });
}

// ---------------------------------------------------------------- images

const IMG_EXT: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };

/** SSRF-guarded, size-limited copy of an external product image into public/uploads. */
export async function copyExternalImage(storeId: string, url: string): Promise<string | null> {
  try {
    const parsed = new URL(url);
    await assertPublicHost(parsed);
    const res = await fetch(parsed, {
      headers: { "User-Agent": "SHOPMESH-Importer/1.0 (+https://shopmesh.local)" },
      signal: AbortSignal.timeout(10000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    const ext = IMG_EXT[type];
    if (!ext) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 5 * 1024 * 1024) return null;
    const hash = sha256Hex(url).slice(0, 16);
    const dir = path.join(process.cwd(), "public", "uploads", storeId);
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${hash}${ext}`);
    await fs.promises.writeFile(file, buf);
    return `/uploads/${storeId}/${hash}${ext}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- store creation

async function uniqueSlug(name: string): Promise<string> {
  return slugifyStoreName(name);
}

async function ensureStoreForJob(job: { id: string; platform: string }, shop: NormalizedShop): Promise<{ id: string; slug: string }> {
  // reuse store bound to a prior import from the same source shop
  const prior = await db.store.findFirst({
    where: { products: { some: { sourcePlatform: job.platform, sourceShopId: shop.sourceShopId } } },
    select: { id: true, slug: true },
  });
  if (prior) return prior;

  const label = platformLabel(job.platform);
  const slug = await uniqueSlug(shop.name);
  const store = await db.store.create({
    data: {
      sellerId: null,
      name: shop.name.slice(0, 80),
      slug,
      tagline: `Imported from ${label}`,
      description: shop.name ? `${shop.name} — catalogue imported from ${label}.` : null,
      logoUrl: shop.logoUrl ?? null,
      status: "generating",
      lifecycleSource: "import",
    },
    select: { id: true, slug: true },
  });
  await transitionStore({ storeId: store.id, to: "pending_verification", actorType: "system", note: "import generated" }).catch(() => undefined);
  // home page draft so preview + publish render real sections
  await db.cmsPage.create({
    data: {
      storeId: store.id,
      slug: "home",
      title: `${shop.name} — Home`,
      pageType: "home",
      draftJson: JSON.stringify({ sections: defaultHomeSections(shop.name, `Imported from ${label}`), version: 1 }),
    },
  }).catch(() => {
    // home page might exist for reused slug store — ignore
  });
  return store;
}

// ---------------------------------------------------------------- product upsert

type Overrides = Record<string, boolean>;

async function upsertProduct(job: { id: string; platform: string; isFixture: boolean }, storeId: string, storeName: string, sourceShopId: string, np: NormalizedProduct): Promise<{ productId: string; warnings: string[] }> {
  const warnings = [...np.warnings];
  const existing = await db.product.findUnique({
    where: { storeId_sourcePlatform_sourceProductId: { storeId, sourcePlatform: job.platform, sourceProductId: np.sourceProductId } },
    include: { images: true, variants: true },
  });
  const overrides = parseJson<Overrides>(existing?.overridesJson, {});
  const description = sanitiseDescriptionHtml(np.descriptionHtml);
  const minPrice = np.variants.length > 0 ? Math.min(...np.variants.map((v) => v.priceMinor)) : 0;

  let productId: string;
  if (!existing) {
    const slug = await slugifyProductTitle(storeId, np.title);
    const categoryId = await mapCategory(np.categoryHint);
    const created = await db.product.create({
      data: {
        storeId,
        categoryId,
        title: np.title.slice(0, 160),
        slug,
        description,
        status: np.isAvailable ? "active" : "archived",
        priceMinor: minPrice,
        sourcePlatform: job.platform,
        sourceShopId,
        sourceProductId: np.sourceProductId,
        sourceUrl: np.sourceUrl ?? null,
        sourceBrand: np.brand ?? null,
        sourceStatus: np.sourceStatus,
        isFixture: job.isFixture,
        lastSyncedAt: new Date(),
        overridesJson: "{}",
        ...seoFields(np, storeName),
        images: { create: np.images.map((im) => ({ url: im.url, sortOrder: im.sortOrder, alt: im.alt ?? null })) },
        variants: {
          create: np.variants.map((v) => ({
            name: v.options.map((o) => `${o.name}: ${o.value}`).join(" / ") || "Default",
            optionName: v.options[0]?.name ?? null,
            optionValue: v.options[0]?.value ?? null,
            sourceModelId: v.sourceModelId,
            imageUrl: v.imageUrl ?? null,
            sku: v.sourceSku ?? null,
            priceMinor: v.priceMinor,
            compareAtPriceMinor: v.compareAtPriceMinor ?? null,
            stock: v.stock ?? 0,
            isActive: v.isAvailable,
          })),
        },
      },
      select: { id: true },
    });
    productId = created.id;
  } else {
    productId = existing.id;
    await db.product.update({
      where: { id: productId },
      data: {
        // seller-locked fields survive re-import
        ...(overrides.title ? {} : { title: np.title.slice(0, 160) }),
        ...(overrides.description ? {} : { description }),
        priceMinor: minPrice,
        sourceStatus: np.sourceStatus,
        sourceBrand: np.brand ?? existing.sourceBrand ?? null,
        sourceUrl: np.sourceUrl ?? existing.sourceUrl,
        lastSyncedAt: new Date(),
        // disappeared at source → archive (never delete: order history preserved)
        status: np.isAvailable ? (existing.status === "archived" ? "active" : existing.status) : "archived",
        ...(overrides.description ? {} : seoFields(np, storeName)),
      },
      select: { id: true },
    });
    if (!overrides.images) {
      await db.productImage.deleteMany({ where: { productId } });
      if (np.images.length > 0) {
        await db.productImage.createMany({ data: np.images.map((im) => ({ productId, url: im.url, sortOrder: im.sortOrder, alt: im.alt ?? null })) });
      }
    }
    if (!overrides.variants) {
      await db.productVariant.deleteMany({ where: { productId } });
      await db.productVariant.createMany({
        data: np.variants.map((v) => ({
          productId,
          name: v.options.map((o) => `${o.name}: ${o.value}`).join(" / ") || "Default",
          optionName: v.options[0]?.name ?? null,
          optionValue: v.options[0]?.value ?? null,
          sourceModelId: v.sourceModelId,
          imageUrl: v.imageUrl ?? null,
          sku: v.sourceSku ?? null,
          priceMinor: v.priceMinor,
          compareAtPriceMinor: v.compareAtPriceMinor ?? null,
          stock: v.stock ?? 0,
          isActive: v.isAvailable,
        })),
      });
    }
  }

  // image processing: copy external images into local storage (permitted strategy),
  // fall back to source URL reference with a warning on failure.
  let imagesCopied = 0;
  const rows = await db.productImage.findMany({ where: { productId }, orderBy: { sortOrder: "asc" } });
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.url.startsWith("/")) continue; // already local (fixture/mockup)
    const local = await copyExternalImage(storeId, row.url);
    if (local) {
      await db.productImage.update({ where: { id: row.id }, data: { url: local } });
      imagesCopied++;
    } else {
      warnings.push(`Image ${i + 1} kept as source reference (copy failed)`);
    }
  }
  if (imagesCopied > 0) await bumpProgress(job.id, { imagesCopied });
  return { productId, warnings };
}

const summaryCache = new Map<string, string>();

function seoFields(np: NormalizedProduct, storeName: string) {
  const { seoTitle, seoDescription } = deriveProductSeo(np.title, np.descriptionHtml, storeName);
  return { seoTitle, seoDescription };
}

// ---------------------------------------------------------------- job creation

export async function createImportJob(input: { inputUrl: string; allowFixture?: boolean }): Promise<{ jobId: string; trackingToken: string; status: string }> {
  const { connector, resolved } = await resolveForConnector(input.inputUrl);
  const auth = await connector.authStatus();
  const isFixture = resolved.platform === "fixture";
  if (isFixture && input.allowFixture === false) {
    throw new ApiError(400, "FIXTURE_NOT_ALLOWED", "Fixture imports are disabled.");
  }
  const trackingToken = randomToken(24);
  const job = await db.importJob.create({
    data: {
      trackingToken,
      platform: resolved.platform,
      inputUrl: resolved.normalizedUrl,
      urlType: resolved.urlType,
      sourceShopId: resolved.shopId ?? null,
      status: "queued",
      isFixture,
      summaryJson: JSON.stringify({
        platform: resolved.platform,
        platformLabel: platformLabel(resolved.platform),
        isFixture,
      } satisfies JobSummary),
    },
    select: { id: true },
  });
  if (!isFixture && (auth.needsAuthorisation || !auth.envConfigured)) {
    await db.importJob.update({
      where: { id: job.id },
      data: {
        status: "awaiting_authorisation",
        phaseDetail: auth.envConfigured
          ? "Seller authorisation required before the catalogue can be imported."
          : "Marketplace app credentials are not configured on the server.",
        summaryJson: JSON.stringify({
          platform: resolved.platform,
          platformLabel: platformLabel(resolved.platform),
          isFixture,
          authorisationRequired: true,
          beginUrl: auth.beginUrl ?? null,
          missingEnv: auth.missing,
        } satisfies JobSummary),
      },
    });
    await logActivity({ actorType: "shopper", action: "import.awaiting_authorisation", entityType: "import_job", entityId: job.id, meta: { platform: resolved.platform } }).catch(() => undefined);
  }
  return { jobId: job.id, trackingToken, status: isFixture ? "queued" : "awaiting_authorisation" };
}

// ---------------------------------------------------------------- job execution

export async function runJob(jobId: string): Promise<{ status: string }> {
  const job = await db.importJob.findUnique({ where: { id: jobId } });
  if (!job) throw new ApiError(404, "JOB_NOT_FOUND", "Import job not found.");
  if (job.status === "completed" || job.status === "completed_with_warnings") return { status: job.status };
  if (job.status === "awaiting_authorisation") return { status: job.status };

  const connector = getConnector(job.platform as Platform);
  const warnings: string[] = [];
  try {
    // connection resolution: fixture creates a pseudo-connection keyed by shop slug
    let connectionId: string | null = job.connectionId;
    if (!connectionId) {
      if (job.isFixture) {
        const conn = await db.marketplaceConnection.upsert({
          where: { platform_shopId: { platform: "fixture", shopId: job.sourceShopId ?? "demo-store" } },
          create: {
            platform: "fixture",
            shopId: job.sourceShopId ?? "demo-store",
            shopName: job.sourceShopId ?? "Demo Store",
            status: "connected",
            envConfigured: true,
          },
          update: { status: "connected" },
          select: { id: true },
        });
        connectionId = conn.id;
      } else {
        const conn = await db.marketplaceConnection.findFirst({ where: { platform: job.platform, status: "connected" }, orderBy: { createdAt: "desc" }, select: { id: true } });
        if (!conn) throw new ApiError(409, "NO_CONNECTION", `No authorised ${platformLabel(job.platform)} connection. Connect the marketplace first.`);
        connectionId = conn.id;
      }
      await db.importJob.update({ where: { id: jobId }, data: { connectionId } });
    }

    if (!job.isFixture) await setPhase(jobId, "connecting", "Connecting to marketplace…");
    await setPhase(jobId, "fetching_shop", "Retrieving shop information…");
    const shop = await connector.getShop(connectionId);
    summaryCache.set(jobId, JSON.stringify({ shop } satisfies JobSummary));

    const store = await ensureStoreForJob(job, shop);
    await db.importJob.update({ where: { id: jobId }, data: { storeId: store.id } });
    await transitionStore({ storeId: store.id, to: "pending_claim", actorType: "system", note: `import job ${jobId}` }).catch(() => undefined);

    // ---- discover products
    await setPhase(jobId, "importing_products", "Listing marketplace products…");
    const discovered: { sourceProductId: string }[] = [];
    if (job.urlType === "product" && job.sourceProductId) {
      discovered.push({ sourceProductId: job.sourceProductId });
    } else {
      let cursor: string | null = null;
      for (let page = 0; page < 25; page++) {
        const pageRes = await connector.listProductsPage(connectionId, cursor, 50);
        discovered.push(...pageRes.products);
        await bumpProgress(jobId, { discovered: discovered.length });
        if (!pageRes.nextCursor) break;
        cursor = pageRes.nextCursor;
      }
    }
    if (discovered.length === 0) throw new ApiError(422, "EMPTY_CATALOGUE", "No products were found for this shop.");

    // ---- per-product import (partial failures never abort the job)
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    const storeRow = await db.store.findUnique({ where: { id: store.id }, select: { name: true } });
    for (const d of discovered) {
      const item = await db.importJobItem.upsert({
        where: { jobId_sourcePlatform_sourceProductId: { jobId, sourcePlatform: job.platform, sourceProductId: d.sourceProductId } },
        create: { jobId, sourcePlatform: job.platform, sourceShopId: shop.sourceShopId, sourceProductId: d.sourceProductId, status: "pending" },
        update: {},
        select: { id: true, status: true, productId: true },
      });
      if (item.status === "ok") {
        skipped++;
        await bumpProgress(jobId, { processed: succeeded + failed + skipped, skipped });
        continue;
      }
      try {
        const np: NormalizedProduct = await connector.getProduct(connectionId, d.sourceProductId);
        await db.importJobItem.update({
          where: { id: item.id },
          data: { title: np.title, sourceShopId: shop.sourceShopId, status: "importing", warningsJson: "[]" },
        });
        const { productId, warnings: pw } = await upsertProduct(job, store.id, storeRow?.name ?? shop.name, shop.sourceShopId, np);
        for (const w of pw) warnings.push(`${np.title}: ${w}`);
        await db.importJobItem.update({
          where: { id: item.id },
          data: { productId, status: "ok", warningsJson: JSON.stringify(pw), processedAt: new Date(), title: np.title },
        });
        succeeded++;
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`${d.sourceProductId}: ${msg}`);
        await db.importJobItem.update({
          where: { id: item.id },
          data: { status: "failed", error: msg.slice(0, 500), processedAt: new Date() },
        });
      }
      await bumpProgress(jobId, { processed: succeeded + failed + skipped, succeeded, failed, skipped });
    }

    // ---- variants summary phase (variants are created inline; phase kept for progress fidelity)
    await setPhase(jobId, "importing_variants", "Importing product variants…");
    const variantCount = await db.productVariant.count({ where: { product: { storeId: store.id, sourcePlatform: job.platform } } });
    await setPhase(jobId, "processing_images", "Processing product images…");

    // ---- SEO
    await setPhase(jobId, "generating_seo", "Generating SEO metadata…");
    const importedProducts = await db.product.findMany({
      where: { storeId: store.id, sourcePlatform: job.platform },
      select: { id: true, title: true, description: true, seoTitle: true, images: { orderBy: { sortOrder: "asc" }, take: 1 } },
    });
    for (const p of importedProducts) {
      if (!p.seoTitle) {
        const { seoTitle, seoDescription } = deriveProductSeo(p.title, p.description, storeRow?.name ?? shop.name);
        await db.product.update({ where: { id: p.id }, data: { seoTitle, seoDescription } });
      }
      const ogImage = p.images[0]?.url ?? null;
      await db.seoMeta.upsert({
        where: { entityType_entityId: { entityType: "product", entityId: p.id } },
        create: {
          entityType: "product", entityId: p.id,
          seoTitle: `${p.title} | ${storeRow?.name ?? shop.name}`.slice(0, 60),
          seoDescription: (htmlToText(p.description) || p.title).slice(0, 155),
          ogImage,
          structuredDataJson: JSON.stringify({ "@type": "Product", name: p.title }),
          warningsJson: "[]",
        },
        update: { ogImage },
      });
    }
    const storeSeo = await db.seoMeta.upsert({
      where: { entityType_entityId: { entityType: "store", entityId: store.id } },
      create: {
        entityType: "store", entityId: store.id,
        seoTitle: `${storeRow?.name ?? shop.name} — Official Store`.slice(0, 60),
        seoDescription: `Shop ${storeRow?.name ?? shop.name} on NOMOFEE. Imported from ${platformLabel(job.platform)}.`.slice(0, 155),
        ogImage: null,
        structuredDataJson: JSON.stringify({ "@type": "Store", name: storeRow?.name ?? shop.name }),
        warningsJson: "[]",
      },
      update: {},
    });

    // ---- storefront
    await setPhase(jobId, "generating_storefront", "Generating storefront…");
    const home = await db.cmsPage.findFirst({ where: { storeId: store.id, slug: "home" } });
    if (home && !home.publishedJson) {
      await db.cmsPage.update({ where: { id: home.id }, data: { publishedJson: home.draftJson, publishedVersion: 1 } });
    }

    // ---- claim token: while the store is unclaimed, each completed run issues a
    // fresh claim link (previous links revoked — the owner may have lost theirs).
    // Once claimed, the claim phase is skipped entirely.
    await setPhase(jobId, "awaiting_claim", "Preparing secure claim link…");
    const storeFresh = await db.store.findUnique({ where: { id: store.id }, select: { sellerId: true, status: true } });
    let claimToken: string | null = null;
    let claimExpiresAt: Date | null = null;
    let claimMethod: string | null = null;
    if (!storeFresh?.sellerId) {
      await db.storeClaim.updateMany({ where: { storeId: store.id, status: "active" }, data: { status: "revoked" } });
      claimToken = randomToken(24);
      claimExpiresAt = new Date(Date.now() + 14 * 86400 * 1000);
      claimMethod = job.isFixture ? "claim_code" : "pending";
      await db.storeClaim.create({
        data: {
          storeId: store.id,
          jobId: job.id,
          tokenHash: sha256Hex(claimToken),
          status: "active",
          verificationMethod: claimMethod,
          expiresAt: claimExpiresAt,
        },
      });
    }

    const failedItems = await db.importJobItem.count({ where: { jobId, status: "failed" } });
    const summary: JobSummary = {
      shop: { name: shop.name, sourceShopId: shop.sourceShopId, region: shop.region ?? null },
      platform: job.platform,
      platformLabel: platformLabel(job.platform),
      isFixture: job.isFixture,
      storeId: store.id,
      storeSlug: store.slug,
      productsOk: succeeded,
      productsFailed: failed,
      warnings: warnings.slice(0, 20),
      claimMethod: claimMethod ?? undefined,
    };
    if (claimToken && claimExpiresAt) {
      summary.claimToken = claimToken;
      summary.claimExpiresAt = claimExpiresAt.toISOString();
    }
    await db.importJob.update({
      where: { id: jobId },
      data: {
        status: failedItems > 0 ? "completed_with_warnings" : "completed",
        phaseDetail: failedItems > 0 ? `${failedItems} product(s) could not be imported.` : null,
        summaryJson: JSON.stringify(summary),
        storeCreated: true,
        startedAt: job.startedAt ?? new Date(),
        finishedAt: new Date(),
      },
    });
    await logActivity({ actorType: "system", action: "import.completed", entityType: "import_job", entityId: jobId, meta: { platform: job.platform, succeeded, failed } }).catch(() => undefined);
    void storeSeo;
    return { status: failedItems > 0 ? "completed_with_warnings" : "completed" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.importJob.update({
      where: { id: jobId },
      data: { status: "failed", errorJson: JSON.stringify({ code: err instanceof ApiError ? err.code : "IMPORT_FAILED", message: msg.slice(0, 500) }), finishedAt: new Date() },
    });
    return { status: "failed" };
  }
}

/** Resume failed/pending items of a non-terminal job. */
export async function resumeJob(jobId: string): Promise<{ status: string }> {
  const job = await db.importJob.findUnique({ where: { id: jobId } });
  if (!job) throw new ApiError(404, "JOB_NOT_FOUND", "Import job not found.");
  if (job.status === "failed" || job.status === "completed_with_warnings") {
    await db.importJob.update({ where: { id: jobId }, data: { status: "queued", errorJson: "{}" } });
  }
  return runJob(jobId);
}

/** Verify a raw claim token against the store claim row (single-use validation happens at bind time). */
export async function validateClaimToken(jobId: string, rawToken: string): Promise<{ storeId: string; storeSlug: string; storeName: string; method: string }> {
  const job = await db.importJob.findUnique({ where: { id: jobId }, select: { storeId: true, isFixture: true } });
  const tokenHash = sha256Hex(rawToken);
  const claim = await db.storeClaim.findFirst({
    where: { tokenHash, status: "active", expiresAt: { gt: new Date() } },
    include: { store: { select: { id: true, slug: true, name: true } } },
  });
  if (!claim || !job || claim.storeId !== job.storeId) {
    throw new ApiError(403, "INVALID_CLAIM_TOKEN", "This claim link is invalid, already used, or expired.");
  }
  return { storeId: claim.store.id, storeSlug: claim.store.slug, storeName: claim.store.name, method: claim.verificationMethod };
}

/** Exported for the claim-binding flow (Phase 7 consumes the raw token). */
export function hashClaimToken(rawToken: string): string {
  return sha256Hex(rawToken);
}
