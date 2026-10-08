import { db } from "@/lib/db";
import { handle, ok, ApiError, slugify } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/store/collections
export const GET = handle(async () => {
  const { store } = await requireActiveSellerStore();
  const collections = await db.collection.findMany({
    where: { storeId: store.id },
    include: { products: { include: { product: { select: { id: true, title: true, slug: true, priceMinor: true, status: true } } } } },
    orderBy: { createdAt: "desc" },
  });
  return ok(
    collections.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      productCount: c.products.length,
      products: c.products.map((cp) => cp.product),
      createdAt: c.createdAt,
    }))
  );
});

// POST /api/store/collections {name, description?}
export const POST = handle(async (req: Request) => {
  const { me, store } = await requireActiveSellerStore();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const name = String(body.name ?? "").trim();
  if (!name) throw new ApiError(400, "VALIDATION", "name is required");

  const base = slugify(name) || "collection";
  const existing = await db.collection.findMany({ where: { storeId: store.id, slug: { startsWith: base } }, select: { slug: true } });
  const taken = new Set(existing.map((e) => e.slug));
  let slug = base;
  let n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;

  const collection = await db.collection.create({
    data: {
      storeId: store.id,
      name,
      slug,
      description: body.description != null ? String(body.description) : null,
    },
  });

  return ok({ ...collection, productCount: 0, products: [] }, { status: 201 });
});
