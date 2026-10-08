import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { handle, okPaged, getPagination } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

// GET /api/admin/orders?status=&storeId=&search=&page=&size=
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const url = new URL(req.url);
  const { page, size, skip, take } = getPagination(url);
  const status = url.searchParams.get("status");
  const storeId = url.searchParams.get("storeId");
  const search = url.searchParams.get("search");

  const where: Prisma.OrderWhereInput = {
    ...(status && status !== "all" ? { status } : {}),
    ...(storeId ? { storeId } : {}),
    ...(search
      ? {
          OR: [
            { orderNumber: { contains: search } },
            { customerName: { contains: search } },
            { customerEmail: { contains: search } },
            { store: { is: { name: { contains: search } } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.order.findMany({
      where,
      include: {
        store: { select: { id: true, name: true, slug: true } },
        items: { select: { commissionMinor: true } },
        _count: { select: { items: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    db.order.count({ where }),
  ]);

  const data = rows.map((o) => ({
    ...o,
    itemsCount: o._count.items,
    commissionMinor: o.items.reduce((s, it) => s + it.commissionMinor, 0),
    items: undefined,
    _count: undefined,
  }));
  return okPaged(data, { page, size, total });
});
