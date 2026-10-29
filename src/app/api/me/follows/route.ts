import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/me/follows — stores the signed-in shopper follows.
// Counts are ALWAYS derived from StoreFollow/Product relations (the legacy
// ShopperUser.followingCount/followerCount columns are dormant — do not use).
// All followed rows are returned (incl. non-live stores, flagged via status)
// so the Me hub can grey them out instead of silently losing history.
export const GET = handle(async () => {
  const me = await requireShopper();
  const follows = await db.storeFollow.findMany({
    where: { shopperUserId: me.id },
    orderBy: { createdAt: "desc" },
    include: {
      store: {
        select: {
          id: true,
          name: true,
          slug: true,
          logoUrl: true,
          bannerUrl: true,
          status: true,
          tagline: true,
          _count: { select: { products: true, followers: true } },
        },
      },
    },
  });
  const stores = follows.map((f) => ({
    id: f.store.id,
    name: f.store.name,
    slug: f.store.slug,
    logoUrl: f.store.logoUrl,
    bannerUrl: f.store.bannerUrl,
    tagline: f.store.tagline,
    status: f.store.status,
    isLive: f.store.status === "live",
    productCount: f.store._count.products,
    followers: f.store._count.followers,
    followedAt: f.createdAt,
  }));
  return ok({ stores, total: stores.length });
});

// POST /api/me/follows {storeId} — follow a live store.
export const POST = handle(async (req: Request) => {
  const me = await requireShopper();
  const body = (await req.json().catch(() => ({}))) as { storeId?: unknown };
  const storeId = typeof body.storeId === "string" ? body.storeId.trim() : "";
  if (!storeId) throw new ApiError(400, "VALIDATION", "storeId is required");

  const store = await db.store.findUnique({ where: { id: storeId }, select: { id: true, status: true } });
  if (!store) throw new ApiError(404, "NOT_FOUND", "Store not found");
  if (store.status !== "live") throw new ApiError(409, "STORE_NOT_LIVE", "Only live stores can be followed");

  try {
    await db.storeFollow.create({ data: { shopperUserId: me.id, storeId: store.id } });
  } catch (e) {
    // createMany-safe insert: the unique [shopperUserId,storeId] pair turns
    // into a friendly 409 instead of a 500 (P2002 = unique constraint violation).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const followers = await db.storeFollow.count({ where: { storeId: store.id } });
      return ok({ following: true, followers, already: true }, { status: 200 });
    }
    throw e;
  }
  const followers = await db.storeFollow.count({ where: { storeId: store.id } });
  return ok({ following: true, followers }, { status: 201 });
});

// DELETE /api/me/follows {storeId} — unfollow (storeId via JSON body or ?storeId= query).
export const DELETE = handle(async (req: Request) => {
  const me = await requireShopper();
  const url = new URL(req.url);
  let storeId = url.searchParams.get("storeId")?.trim() ?? "";
  if (!storeId) {
    const body = (await req.json().catch(() => ({}))) as { storeId?: unknown };
    if (typeof body.storeId === "string") storeId = body.storeId.trim();
  }
  if (!storeId) throw new ApiError(400, "VALIDATION", "storeId is required");

  const existing = await db.storeFollow.findUnique({
    where: { shopperUserId_storeId: { shopperUserId: me.id, storeId } },
  });
  if (!existing) throw new ApiError(404, "NOT_FOUND", "You are not following this store");

  await db.storeFollow.delete({ where: { id: existing.id } });
  const followers = await db.storeFollow.count({ where: { storeId } });
  return ok({ following: false, followers });
});
