import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { bustPublicCacheSafe, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";
import type { StoreCategoryRow, StoreCategoryCreateBody } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// SELLER STORE SETTINGS WORK ORDER — storefront categories. Seller-defined
// groupings for their OWN products (distinct from the global marketplace
// Category tree), rendered as the inline chip row below the storefront hero.
// Public payload flows through /api/sf/[slug] (categories list) and
// /api/sf/[slug]/products?category=<id> (filtering).

const MAX_NAME = 40;
const MAX_CATEGORIES = 20;

function cleanName(raw: unknown): string {
  return String(raw ?? "").trim().replace(/\s+/g, " ");
}

// GET /api/store/categories — the store's categories with product counts.
export const GET = handle(async () => {
  const { store } = await requireActiveSellerStore();
  const rows = await db.storeCategory.findMany({
    where: { storeId: store.id },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: { _count: { select: { products: true } } },
  });
  const payload: StoreCategoryRow[] = rows.map((c) => ({
    id: c.id,
    name: c.name,
    sortOrder: c.sortOrder,
    productCount: c._count.products,
  }));
  return ok(payload);
});

// POST /api/store/categories — create { name }; appended after the last row.
export const POST = handle(async (req: Request) => {
  const { me, store } = await requireActiveSellerStore();
  const body = (await req.json().catch(() => ({}))) as StoreCategoryCreateBody;
  const name = cleanName(body.name);
  if (!name) throw new ApiError(400, "VALIDATION", "Category name cannot be empty");
  if (name.length > MAX_NAME) {
    throw new ApiError(400, "VALIDATION", `Category name must be ${MAX_NAME} characters or fewer`);
  }

  const existing = await db.storeCategory.findMany({
    where: { storeId: store.id },
    select: { name: true },
  });
  if (existing.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    throw new ApiError(400, "VALIDATION", "A category with this name already exists");
  }
  if (existing.length >= MAX_CATEGORIES) {
    throw new ApiError(400, "VALIDATION", `You can create up to ${MAX_CATEGORIES} categories`);
  }

  const created = await db.storeCategory.create({
    data: { storeId: store.id, name, sortOrder: existing.length },
  });

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "store.category.created",
    entityType: "store",
    entityId: store.id,
    meta: { name },
  });
  bustPublicCacheSafe(PUBLIC_CACHE_TAGS.stores, PUBLIC_CACHE_TAGS.market);
  const payload: StoreCategoryRow = { id: created.id, name: created.name, sortOrder: created.sortOrder, productCount: 0 };
  return ok(payload, { status: 201 });
});
