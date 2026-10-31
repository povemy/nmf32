import { handle, ok, ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { requireAffiliate, getAffiliateSettings } from "@/lib/affiliate";
import { newAffiliateLinkCode } from "@/lib/affiliate-attribution";

export const dynamic = "force-dynamic";

const CHANNELS = ["tiktok", "threads", "facebook", "telegram", "whatsapp", "blog", "website", "other"] as const;
const MAX_LINKS = 500;

// GET /api/affiliate/links — my promotional links with performance stats.
export const GET = handle(async () => {
  const aff = await requireAffiliate();
  const links = await db.affiliateLink.findMany({
    where: { affiliateId: aff.id },
    orderBy: { createdAt: "desc" },
  });
  // Target titles for display (resolved in one pass, no N+1). The empty-list
  // branches carry explicit row types so the maps below stay correctly typed.
  const productIds = links.filter((l) => l.productId).map((l) => l.productId!);
  const storeIds = links.filter((l) => l.storeId).map((l) => l.storeId!);
  const collectionIds = links.filter((l) => l.collectionId).map((l) => l.collectionId!);
  type ProductRow = { id: string; title: string; slug: string; store: { slug: string } };
  type StoreRow = { id: string; name: string; slug: string };
  type CollectionRow = { id: string; title: string; slug: string; status: string };
  const [products, stores, collections]: [ProductRow[], StoreRow[], CollectionRow[]] = await Promise.all([
    productIds.length ? db.product.findMany({ where: { id: { in: productIds } }, select: { id: true, title: true, slug: true, store: { select: { slug: true } } } }) : ([] as ProductRow[]),
    storeIds.length ? db.store.findMany({ where: { id: { in: storeIds } }, select: { id: true, name: true, slug: true } }) : ([] as StoreRow[]),
    collectionIds.length ? db.affiliateCollection.findMany({ where: { id: { in: collectionIds } }, select: { id: true, title: true, slug: true, status: true } }) : ([] as CollectionRow[]),
  ]);
  const productMap = new Map(products.map((p) => [p.id, p]));
  const storeMap = new Map(stores.map((s) => [s.id, s]));
  const collectionMap = new Map(collections.map((c) => [c.id, c]));

  return ok({
    links: links.map((l) => ({
      id: l.id, code: l.code, type: l.type, channel: l.channel, label: l.label,
      status: l.status, clicks: l.clicks, lastClickAt: l.lastClickAt?.toISOString() ?? null,
      createdAt: l.createdAt.toISOString(),
      target: l.productId
        ? { kind: "product", title: productMap.get(l.productId)?.title ?? "Product", slug: productMap.get(l.productId)?.slug ?? null, storeSlug: productMap.get(l.productId)?.store.slug ?? null }
        : l.storeId
          ? { kind: "store", title: storeMap.get(l.storeId)?.name ?? "Store", slug: storeMap.get(l.storeId)?.slug ?? null }
          : l.collectionId
            ? { kind: "collection", title: collectionMap.get(l.collectionId)?.title ?? "Collection", slug: collectionMap.get(l.collectionId)?.slug ?? null, status: collectionMap.get(l.collectionId)?.status ?? null }
            : { kind: "showcase", title: "My showcase", slug: aff.slug },
    })),
  });
});

// POST /api/affiliate/links — create a promotional link (spec §3.C).
// Types: product | store | collection | showcase. Server validates ownership
// AND that the target is affiliate-eligible (product enrolled + store opted
// in) — no commission opportunity for non-participating products.
export const POST = handle(async (req: Request) => {
  rateLimit(req, "affiliate-link-create", 30);
  const aff = await requireAffiliate();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const type = String(body.type ?? "");
  // POST-IMPLEMENTATION AUDIT (P2): collections & showcase are deferred for
  // the initial release. While their feature gates are off, creating NEW
  // collection/showcase promotional links fails closed (403). Existing links
  // keep resolving their historical state — never destructively removed.
  const settings = await getAffiliateSettings();
  if (type === "collection" && !settings.collectionsEnabled) {
    throw new ApiError(403, "COLLECTIONS_DISABLED", "Collections are currently disabled");
  }
  if (type === "showcase" && !settings.showcaseEnabled) {
    throw new ApiError(403, "SHOWCASE_DISABLED", "Showcases are currently disabled");
  }
  const channel = CHANNELS.includes(String(body.channel ?? "other") as (typeof CHANNELS)[number])
    ? String(body.channel) : "other";
  const label = body.label != null ? String(body.label).slice(0, 80) : null;

  let productId: string | null = null;
  let storeId: string | null = null;
  let collectionId: string | null = null;

  if (type === "product") {
    productId = String(body.productId ?? "");
    const product = await db.product.findUnique({
      where: { id: productId },
      include: { store: { select: { id: true, status: true, affiliateOptIn: true, slug: true } } },
    });
    if (!product || product.status !== "active" || !product.store || product.store.status !== "live") {
      throw new ApiError(404, "PRODUCT_NOT_FOUND", "Product not found or unavailable");
    }
    if (!product.affiliateEnabled || !product.store.affiliateOptIn) {
      throw new ApiError(400, "NOT_ENROLLED", "This product does not participate in the affiliate programme");
    }
    storeId = product.store.id;
  } else if (type === "store") {
    storeId = String(body.storeId ?? "");
    const store = await db.store.findUnique({ where: { id: storeId } });
    if (!store || store.status !== "live") throw new ApiError(404, "STORE_NOT_FOUND", "Store not found or unavailable");
    if (!store.affiliateOptIn) {
      throw new ApiError(400, "NOT_ENROLLED", "This store does not participate in the affiliate programme");
    }
  } else if (type === "collection") {
    collectionId = String(body.collectionId ?? "");
    const collection = await db.affiliateCollection.findFirst({
      where: { id: collectionId, affiliateId: aff.id },
    });
    if (!collection) throw new ApiError(404, "COLLECTION_NOT_FOUND", "Collection not found");
    if (collection.status !== "published") {
      throw new ApiError(400, "NOT_PUBLISHED", "Publish the collection before creating links to it");
    }
  } else if (type === "showcase") {
    // No target validation — the affiliate's own public page.
  } else {
    throw new ApiError(400, "VALIDATION", "type must be product | store | collection | showcase");
  }

  const count = await db.affiliateLink.count({ where: { affiliateId: aff.id } });
  if (count >= MAX_LINKS) throw new ApiError(400, "LIMIT", "Link limit reached");

  const link = await db.affiliateLink.create({
    data: {
      affiliateId: aff.id, type, code: newAffiliateLinkCode(),
      productId, storeId, collectionId, channel, label,
    },
  });
  return ok({ link: { id: link.id, code: link.code, type: link.type, channel: link.channel, label: link.label } }, { status: 201 });
});
