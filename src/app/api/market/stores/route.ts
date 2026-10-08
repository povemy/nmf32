import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

// GET /api/market/stores — public directory of live stores.
export const GET = handle(async () => {
  const stores = await db.store.findMany({
    where: { status: "live" },
    include: { _count: { select: { products: { where: { status: "active" } } } } },
    orderBy: { createdAt: "asc" },
  });
  return ok(
    stores.map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      tagline: s.tagline,
      logoUrl: s.logoUrl,
      bannerUrl: s.bannerUrl,
      productCount: s._count.products,
    }))
  );
});
