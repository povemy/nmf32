import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Public store lookup (Task 10-d follow feature).
async function publicStore(slug: string) {
  const store = await db.store.findUnique({ where: { slug }, select: { id: true } });
  if (!store) throw new ApiError(404, "STORE_NOT_FOUND", "Store not found");
  return store;
}

// GET /api/stores/[slug]/follow — {following, followers} for the signed-in
// shopper. Guests get the 401 error envelope (the public `followers` count is
// carried by the storefront data route /api/sf/[slug]).
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ slug: string }> }) => {
  const me = await requireShopper();
  const { slug } = await ctx.params;
  const store = await publicStore(slug);

  const [follow, followers] = await Promise.all([
    db.storeFollow.findUnique({
      where: { shopperUserId_storeId: { shopperUserId: me.id, storeId: store.id } },
      select: { id: true },
    }),
    db.storeFollow.count({ where: { storeId: store.id } }),
  ]);

  return ok({ following: !!follow, followers });
});

// POST /api/stores/[slug]/follow — toggle follow → {following, followers}.
export const POST = handle(async (_req: Request, ctx: { params: Promise<{ slug: string }> }) => {
  const me = await requireShopper();
  const { slug } = await ctx.params;
  const store = await publicStore(slug);

  const existing = await db.storeFollow.findUnique({
    where: { shopperUserId_storeId: { shopperUserId: me.id, storeId: store.id } },
    select: { id: true },
  });

  let following: boolean;
  if (existing) {
    await db.storeFollow.delete({ where: { id: existing.id } });
    await db.shopperUser.update({ where: { id: me.id }, data: { followingCount: { decrement: 1 } } });
    following = false;
  } else {
    try {
      await db.storeFollow.create({ data: { shopperUserId: me.id, storeId: store.id } });
      await db.shopperUser.update({ where: { id: me.id }, data: { followingCount: { increment: 1 } } });
      following = true;
    } catch {
      // Lost a race against a concurrent follow (unique constraint) — re-check.
      const now = await db.storeFollow.findUnique({
        where: { shopperUserId_storeId: { shopperUserId: me.id, storeId: store.id } },
        select: { id: true },
      });
      if (!now) throw new ApiError(409, "FOLLOW_CONFLICT", "Could not update follow state, try again");
      following = true;
    }
  }

  const followers = await db.storeFollow.count({ where: { storeId: store.id } });
  return ok({ following, followers });
});
