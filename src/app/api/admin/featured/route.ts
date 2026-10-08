import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, str, optNum } from "@/app/api/admin/_helpers";

// GET /api/admin/featured — featured slots joined with product info
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const slots = await db.featuredSlot.findMany({
    include: {
      product: {
        include: {
          images: { orderBy: { sortOrder: "asc" }, take: 1 },
          store: { select: { id: true, name: true, slug: true } },
        },
      },
    },
    orderBy: [{ slot: "asc" }, { sortOrder: "asc" }],
  });

  const data = slots.map((s) => ({
    id: s.id,
    slot: s.slot,
    sortOrder: s.sortOrder,
    isActive: s.isActive,
    createdAt: s.createdAt,
    product: {
      id: s.product.id,
      title: s.product.title,
      slug: s.product.slug,
      priceMinor: s.product.priceMinor,
      status: s.product.status,
      imageUrl: s.product.images[0]?.url ?? null,
      storeName: s.product.store.name,
      storeSlug: s.product.store.slug,
    },
  }));
  return ok(data);
});

// POST /api/admin/featured {productId, slot?}
export const POST = handle(async (req: NextRequest) => {
  const admin = await requireAdmin();
  const body = await readBody(req);
  const productId = typeof body.productId === "string" ? body.productId : "";
  const slot = str(body, "slot") ?? "home_grid";
  const sortOrder = Math.round(optNum(body, "sortOrder") ?? 0);

  const product = await db.product.findUnique({ where: { id: productId } });
  if (!product) throw new ApiError(404, "NOT_FOUND", "Product not found");

  const created = await db.featuredSlot.create({ data: { productId, slot, sortOrder } });
  await db.product.update({ where: { id: productId }, data: { isFeatured: true } });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "featured.create",
    entityType: "featured_slot",
    entityId: created.id,
    after: { productId, title: product.title, slot, sortOrder },
  });

  return ok(created);
});
