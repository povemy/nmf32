import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { handle, okPaged, getPagination } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { stripSeller } from "@/app/api/admin/_helpers";

// GET /api/admin/sellers?status=&search=&riskTier=&page=&size=
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const url = new URL(req.url);
  const { page, size, skip, take } = getPagination(url);
  const status = url.searchParams.get("status");
  const riskTier = url.searchParams.get("riskTier");
  const search = url.searchParams.get("search");

  const where: Prisma.SellerWhereInput = {
    ...(status && status !== "all" ? { status } : {}),
    ...(riskTier && riskTier !== "all" ? { riskTier } : {}),
    ...(search
      ? {
          OR: [
            { email: { contains: search } },
            { fullName: { contains: search } },
            { displayName: { contains: search } },
            { store: { is: { name: { contains: search } } } },
            { store: { is: { slug: { contains: search } } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.seller.findMany({
      where,
      include: { store: true, wallet: true },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    db.seller.count({ where }),
  ]);

  // GMV last 30d per store (paid orders)
  const since = new Date(Date.now() - 30 * 86400000);
  const gmv = await db.order.groupBy({
    by: ["storeId"],
    where: { paidAt: { gte: since, not: null } },
    _sum: { totalMinor: true },
    _count: { _all: true },
  });
  const gmvByStore = new Map(gmv.map((g) => [g.storeId, { gmv: g._sum.totalMinor ?? 0, orders: g._count._all }]));

  const data = rows.map((s) => {
    const stats = s.store ? gmvByStore.get(s.store.id) : undefined;
    return {
      ...stripSeller(s),
      store: s.store ? { ...s.store, gmv30dMinor: stats?.gmv ?? 0, orders30d: stats?.orders ?? 0 } : null,
      wallet: s.wallet,
    };
  });
  return okPaged(data, { page, size, total });
});
