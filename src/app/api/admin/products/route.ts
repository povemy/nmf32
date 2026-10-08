import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { handle, okPaged, getPagination } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { parseMaybeJson } from "@/app/api/admin/_helpers";

// GET /api/admin/products?status=pending_review|all|<status>&search=&storeId=&page=&size=
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const url = new URL(req.url);
  const { page, size, skip, take } = getPagination(url);
  const status = url.searchParams.get("status");
  const search = url.searchParams.get("search");
  const storeId = url.searchParams.get("storeId");

  const where: Prisma.ProductWhereInput = {
    ...(status && status !== "all" ? { status } : {}),
    ...(storeId ? { storeId } : {}),
    ...(search
      ? {
          OR: [
            { title: { contains: search } },
            { slug: { contains: search } },
            { store: { is: { name: { contains: search } } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.product.findMany({
      where,
      include: {
        images: { orderBy: { sortOrder: "asc" }, take: 1 },
        store: { select: { id: true, name: true, slug: true, status: true } },
        category: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    db.product.count({ where }),
  ]);

  const data = rows.map((p) => ({
    ...p,
    flags: parseMaybeJson<string[]>(p.flagsJson, []),
    flagsJson: undefined,
  }));
  return okPaged(data, { page, size, total });
});
