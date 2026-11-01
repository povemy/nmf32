// GET /api/store/seo — store-level SEO + product SEO list. PATCH — update store SEO.
// Seller-locked fields are protected from re-import (field ownership per spec §5.5/§9.2).
import { NextRequest } from "next/server";
import { handle, ok, fail } from "@/lib/api";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { parseJson } from "@/lib/json";

export const dynamic = "force-dynamic";

async function sellerStore() {
  const session = await getSession();
  if (!session || session.userType !== "seller") return null;
  // PHASE 2.3 select hygiene (C2.7): only these store fields are used (GET
  // response defaults) — selecting the relation explicitly keeps the
  // un-migrated Seller.emailVerifiedAt column out of the query
  // (default/include select → P2022 pre-migration 20261107000000).
  return db.seller.findUnique({
    where: { id: session.userId },
    select: { store: { select: { id: true, name: true, tagline: true, bannerUrl: true } } },
  });
}

export const GET = handle(async function (_req: NextRequest) {
    const seller = await sellerStore();
    if (!seller?.store) return fail(401, "UNAUTHENTICATED", "Seller session required.");
    const storeSeo = await db.seoMeta.findUnique({ where: { entityType_entityId: { entityType: "store", entityId: seller.store.id } } });
    const products = await db.product.findMany({
      where: { storeId: seller.store.id },
      select: { id: true, title: true, slug: true, status: true, seoTitle: true, seoDescription: true, images: { orderBy: { sortOrder: "asc" }, take: 1 } },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    const productSeo = await db.seoMeta.findMany({ where: { entityType: "product", entityId: { in: products.map((p) => p.id) } } });
    const seoByProduct = new Map(productSeo.map((s) => [s.entityId, s]));
    return ok({
      store: {
        seoTitle: storeSeo?.seoTitle ?? seller.store.name,
        seoDescription: storeSeo?.seoDescription ?? seller.store.tagline ?? "",
        ogImage: storeSeo?.ogImage ?? seller.store.bannerUrl,
        canonicalUrl: storeSeo?.canonicalUrl ?? null,
        noindex: storeSeo?.noindex ?? false,
        lockedFields: parseJson<string[]>(storeSeo?.lockedFieldsJson, []),
        warnings: parseJson<string[]>(storeSeo?.warningsJson, []),
      },
      products: products.map((p) => {
        const s = seoByProduct.get(p.id);
        return {
          id: p.id,
          title: p.title,
          slug: p.slug,
          status: p.status,
          image: p.images[0]?.url ?? null,
          seoTitle: p.seoTitle ?? s?.seoTitle ?? "",
          seoDescription: p.seoDescription ?? s?.seoDescription ?? "",
          ogImage: s?.ogImage ?? p.images[0]?.url ?? null,
          noindex: s?.noindex ?? false,
          lockedFields: parseJson<string[]>(s?.lockedFieldsJson, []),
          warnings: parseJson<string[]>(s?.warningsJson, []),
        };
      }),
    });
});

export const PATCH = handle(async function (req: NextRequest) {
    const seller = await sellerStore();
    if (!seller?.store) return fail(401, "UNAUTHENTICATED", "Seller session required.");
    const body = (await req.json().catch(() => ({}))) as {
      target?: "store" | "product";
      productId?: string;
      seoTitle?: string;
      seoDescription?: string;
      ogImage?: string | null;
      canonicalUrl?: string | null;
      noindex?: boolean;
      lock?: string[];
      unlock?: string[];
    };
    const entityType = body.target === "product" ? "product" : "store";
    if (entityType === "product" && !body.productId) return fail(400, "MISSING_PRODUCT", "productId required for product SEO.");
    const entityId = entityType === "store" ? seller.store.id : (body.productId as string);
    if (entityType === "product") {
      const owns = await db.product.findFirst({ where: { id: entityId, storeId: seller.store.id }, select: { id: true } });
      if (!owns) return fail(404, "PRODUCT_NOT_FOUND", "Product not found in your store.");
    }
    const existing = await db.seoMeta.findUnique({ where: { entityType_entityId: { entityType, entityId } } });
    const locked = new Set(parseJson<string[]>(existing?.lockedFieldsJson, []));
    for (const f of body.lock ?? []) locked.add(f);
    for (const f of body.unlock ?? []) locked.delete(f);
    const data = {
      seoTitle: body.seoTitle !== undefined ? body.seoTitle.slice(0, 60) : existing?.seoTitle,
      seoDescription: body.seoDescription !== undefined ? body.seoDescription.slice(0, 155) : existing?.seoDescription,
      ogImage: body.ogImage !== undefined ? body.ogImage : existing?.ogImage,
      canonicalUrl: body.canonicalUrl !== undefined ? body.canonicalUrl : existing?.canonicalUrl,
      noindex: body.noindex ?? existing?.noindex ?? false,
      lockedFieldsJson: JSON.stringify([...locked]),
      warningsJson: JSON.stringify(validateSeo(body.seoTitle, body.seoDescription)),
    };
    const saved = await db.seoMeta.upsert({
      where: { entityType_entityId: { entityType, entityId } },
      create: { entityType, entityId, ...data, structuredDataJson: existing?.structuredDataJson ?? "{}" },
      update: data,
    });
    if (entityType === "product") {
      await db.product.update({
        where: { id: entityId },
        data: { seoTitle: saved.seoTitle, seoDescription: saved.seoDescription },
      }).catch(() => undefined);
      // lock propagation: locked SEO fields recorded in overridesJson so re-import skips them
      if (locked.has("seoTitle") || locked.has("seoDescription")) {
        const prod = await db.product.findUnique({ where: { id: entityId }, select: { overridesJson: true } });
        const ov = JSON.parse(prod?.overridesJson || "{}") as Record<string, boolean>;
        if (locked.has("seoTitle")) ov.seoTitle = true;
        if (locked.has("seoDescription")) ov.description = true;
        await db.product.update({ where: { id: entityId }, data: { overridesJson: JSON.stringify(ov) } });
      }
    }
    return ok({ id: saved.id, seoTitle: saved.seoTitle, seoDescription: saved.seoDescription, ogImage: saved.ogImage, noindex: saved.noindex, lockedFields: [...locked], warnings: parseJson<string[]>(saved.warningsJson, []) });
});

function validateSeo(title?: string, description?: string): string[] {
  const w: string[] = [];
  if (title !== undefined && title.length > 60) w.push("SEO title exceeds 60 characters — it may be truncated in search results");
  if (description !== undefined && description.length > 155) w.push("Meta description exceeds 155 characters");
  if (description !== undefined && description.length > 0 && description.length < 50) w.push("Meta description is short — aim for 50-155 characters");
  return w;
}
