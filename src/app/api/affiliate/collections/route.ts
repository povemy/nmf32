import { handle, ok, ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { requireAffiliate, getAffiliateSettings } from "@/lib/affiliate";
import type { CollectionsData, AffiliateCollectionSummary, CreateCollectionBody, CreateCollectionData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

const MAX_COLLECTIONS = 100;
const MAX_ITEMS = 60;

export { MAX_ITEMS };

// GET /api/affiliate/collections — my curated collections with items.
export const GET = handle(async () => {
  const aff = await requireAffiliate();
  const collections = await db.affiliateCollection.findMany({
    where: { affiliateId: aff.id, status: { not: "archived" } },
    orderBy: { updatedAt: "desc" },
    include: {
      items: {
        orderBy: { position: "asc" },
        include: {
          product: {
            select: {
              id: true, title: true, slug: true, priceMinor: true, status: true,
              affiliateEnabled: true, affiliateRateBps: true,
              store: { select: { slug: true, name: true, affiliateOptIn: true, affiliateDefaultRateBps: true, status: true } },
              images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } },
            },
          },
        },
      },
    },
  });
  const rows: AffiliateCollectionSummary[] = collections.map((c) => ({
    id: c.id, title: c.title, description: c.description, slug: c.slug,
    status: c.status, version: c.version,
    createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(),
    publishedAt: c.publishedAt?.toISOString() ?? null,
    items: c.items.map((it, idx) => ({
      productId: it.productId, position: it.position ?? idx,
      title: it.product.title, slug: it.product.slug, priceMinor: it.product.priceMinor,
      image: it.product.images[0]?.url ?? null,
      storeName: it.product.store.name, storeSlug: it.product.store.slug,
      eligible:
        it.product.status === "active" && it.product.store.status === "live" &&
        it.product.store.affiliateOptIn && it.product.affiliateEnabled,
      rateBps: it.product.affiliateRateBps ?? it.product.store.affiliateDefaultRateBps,
    })),
  }));
  const payload: CollectionsData = { collections: rows };
  return ok(payload);
});

// POST /api/affiliate/collections — create a draft collection (spec §3.D).
// POST-IMPLEMENTATION AUDIT (P2): collections are DEFERRED for the initial
// release. While affiliate.collections_enabled is off, creation fails closed.
// Historical collections remain readable (GET above) and archivable — the
// schema and data are preserved untouched for a future deliberate re-enable.
export const POST = handle(async (req: Request) => {
  rateLimit(req, "affiliate-collection-create", 10);
  const aff = await requireAffiliate();
  const settings = await getAffiliateSettings();
  if (!settings.collectionsEnabled) {
    throw new ApiError(403, "COLLECTIONS_DISABLED", "Collections are currently disabled");
  }
  const body = (await req.json().catch(() => ({}))) as CreateCollectionBody;
  const title = String(body.title ?? "").trim();
  if (title.length < 3 || title.length > 80) throw new ApiError(400, "VALIDATION", "Title must be 3-80 characters");
  const description = body.description != null ? String(body.description).slice(0, 500) : null;

  const count = await db.affiliateCollection.count({ where: { affiliateId: aff.id, status: { not: "archived" } } });
  if (count >= MAX_COLLECTIONS) throw new ApiError(400, "LIMIT", "Collection limit reached");

  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "collection";
  let slug = `${aff.slug}-${base}`;
  for (let i = 0; i < 10; i++) {
    const clash = await db.affiliateCollection.findUnique({ where: { slug } });
    if (!clash) break;
    slug = `${aff.slug}-${base}-${i + 2}`;
  }

  const created = await db.affiliateCollection.create({
    data: { affiliateId: aff.id, title, description, slug, status: "draft" },
  });
  const payload: CreateCollectionData = { collection: { id: created.id, slug: created.slug, title: created.title, status: created.status } };
  return ok(payload, { status: 201 });
});
