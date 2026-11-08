import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { handle, okPaged, getPagination } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import type { AdminOrdersData } from "@/lib/types/api-contract";

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

  // Destructure items/_count OUT of the row (the pre-contract code nulled
  // them with `items: undefined, _count: undefined`, which JSON.stringify
  // drops — omitting the keys serializes identically) and convert the Date
  // fields to the contract's ISO strings.
  const data: AdminOrdersData[] = rows.map((o) => {
    const { items, _count, ...oRow } = o;
    return {
      ...oRow,
      paidAt: oRow.paidAt ? oRow.paidAt.toISOString() : null,
      fulfilledAt: oRow.fulfilledAt ? oRow.fulfilledAt.toISOString() : null,
      shippedAt: oRow.shippedAt ? oRow.shippedAt.toISOString() : null,
      deliveredAt: oRow.deliveredAt ? oRow.deliveredAt.toISOString() : null,
      receivedAt: oRow.receivedAt ? oRow.receivedAt.toISOString() : null,
      completedAt: oRow.completedAt ? oRow.completedAt.toISOString() : null,
      cancelledAt: oRow.cancelledAt ? oRow.cancelledAt.toISOString() : null,
      createdAt: oRow.createdAt.toISOString(),
      updatedAt: oRow.updatedAt.toISOString(),
      itemsCount: _count.items,
      commissionMinor: items.reduce((s, it) => s + it.commissionMinor, 0),
    };
  });
  return okPaged(data, { page, size, total });
});
