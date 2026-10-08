import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { handle, okPaged, getPagination } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

// GET /api/admin/refunds?status=&page=&size=
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const url = new URL(req.url);
  const { page, size, skip, take } = getPagination(url);
  const status = url.searchParams.get("status");

  const where: Prisma.RefundWhereInput = status && status !== "all" ? { status } : {};

  const [rows, total] = await Promise.all([
    db.refund.findMany({
      where,
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            status: true,
            totalMinor: true,
            currency: true,
            customerName: true,
            customerEmail: true,
            store: { select: { id: true, name: true, slug: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    db.refund.count({ where }),
  ]);

  return okPaged(rows, { page, size, total });
});
