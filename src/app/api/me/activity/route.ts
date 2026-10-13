import { z } from "zod";
import { db } from "@/lib/db";
import { handle, ok, ApiError, getPagination, okPaged } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { productCardInclude, toProductCard } from "../../_shared/product-card";

export const dynamic = "force-dynamic";

const postSchema = z.object({
  productId: z.string().min(1),
  activityType: z.enum(["LIKE", "VIEWED"]),
});

// POST /api/me/activity — record a product LIKE or VIEWED for the signed-in
// shopper (upsert per product+type; VIEWED refreshes recency for Recently Viewed).
export const POST = handle(async (req: Request) => {
  const me = await requireShopper();
  const parsed = postSchema.safeParse((await req.json().catch(() => ({}))) as unknown);
  if (!parsed.success) throw new ApiError(400, "VALIDATION", "productId and activityType (LIKE|VIEWED) are required");
  const { productId, activityType } = parsed.data;

  const product = await db.product.findUnique({ where: { id: productId }, select: { id: true } });
  if (!product) throw new ApiError(404, "NOT_FOUND", "Product not found");

  const existing = await db.userActivity.findUnique({
    where: { userId_productId_activityType: { userId: me.id, productId, activityType } },
  });
  if (existing) {
    // Keep a single row per (user, product, type) — bump recency instead of stacking rows.
    await db.userActivity.update({ where: { id: existing.id }, data: { createdAt: new Date() } });
  } else {
    await db.userActivity.create({ data: { userId: me.id, productId, activityType } });
  }
  return ok({ tracked: activityType, productId }, { status: 201 });
});

const deleteSchema = z.object({
  productId: z.string().min(1),
  activityType: z.enum(["LIKE", "VIEWED"]),
});

// DELETE /api/me/activity — remove a LIKE/VIEWED row (PDP heart un-like).
export const DELETE = handle(async (req: Request) => {
  const me = await requireShopper();
  const parsed = deleteSchema.safeParse((await req.json().catch(() => ({}))) as unknown);
  if (!parsed.success) throw new ApiError(400, "VALIDATION", "productId and activityType (LIKE|VIEWED) are required");
  const { productId, activityType } = parsed.data;
  await db.userActivity.deleteMany({ where: { userId: me.id, productId, activityType } });
  return ok({ removed: activityType, productId });
});

// GET /api/me/activity?type=LIKE|VIEWED&page&size — product cards for
// "My Likes" / "Recently Viewed", newest first.
//   ?productId=<id> → tiny check used by the PDP heart: { liked: boolean }
export const GET = handle(async (req: Request) => {
  const me = await requireShopper();
  const url = new URL(req.url);

  // PDP helper — is this product liked by me?
  const productIdParam = url.searchParams.get("productId");
  if (productIdParam) {
    const row = await db.userActivity.findUnique({
      where: { userId_productId_activityType: { userId: me.id, productId: productIdParam, activityType: "LIKE" } },
      select: { id: true },
    });
    return ok({ liked: Boolean(row) });
  }

  const { page, size, skip, take } = getPagination(url, 50);
  const type = url.searchParams.get("type") ?? "VIEWED";
  if (type !== "LIKE" && type !== "VIEWED") {
    throw new ApiError(400, "VALIDATION", "type must be LIKE or VIEWED");
  }

  const [rows, total] = await Promise.all([
    db.userActivity.findMany({
      where: { userId: me.id, activityType: type },
      orderBy: { createdAt: "desc" },
      skip,
      take,
      include: { product: { include: productCardInclude } },
    }),
    db.userActivity.count({ where: { userId: me.id, activityType: type } }),
  ]);

  return okPaged(
    {
      activities: rows
        .filter((a) => a.product && a.product.status === "active")
        .map((a) => ({
          activityId: a.id,
          trackedAt: a.createdAt,
          product: toProductCard(a.product),
        })),
    },
    { page, size, total }
  );
});
