import { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

// GET /api/admin/stores?search=
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const url = new URL(req.url);
  const search = url.searchParams.get("search");

  const rows = await db.store.findMany({
    where: search
      ? {
          OR: [{ name: { contains: search } }, { slug: { contains: search } }, { seller: { is: { email: { contains: search } } } }],
        }
      : {},
    include: {
      seller: { select: { id: true, email: true, fullName: true, displayName: true, status: true, riskTier: true } },
      _count: { select: { products: true, orders: true, pages: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const since = new Date(Date.now() - 30 * 86400000);
  const gmv = await db.order.groupBy({
    by: ["storeId"],
    where: { paidAt: { gte: since, not: null } },
    _sum: { totalMinor: true },
  });
  const gmvByStore = new Map(gmv.map((g) => [g.storeId, g._sum.totalMinor ?? 0]));

  const data = rows.map((s) => ({
    id: s.id,
    name: s.name,
    slug: s.slug,
    status: s.status,
    tagline: s.tagline,
    createdAt: s.createdAt,
    seller: s.seller,
    productCount: s._count.products,
    orderCount: s._count.orders,
    pageCount: s._count.pages,
    gmv30dMinor: gmvByStore.get(s.id) ?? 0,
  }));
  return ok(data);
});
