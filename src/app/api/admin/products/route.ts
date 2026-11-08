import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { handle, okPaged, getPagination } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { parseMaybeJson } from "@/app/api/admin/_helpers";
import type { AdminProductsData } from "@/lib/types/api-contract";

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

  // Destructure flagsJson OUT of the row (the pre-contract code nulled it
  // with `flagsJson: undefined`, which JSON.stringify drops — omitting the
  // key serializes identically) and convert the Date fields to ISO strings.
  const data: AdminProductsData[] = rows.map((p) => {
    const { flagsJson, ...rest } = p;
    return {
      ...rest,
      publishedAt: rest.publishedAt ? rest.publishedAt.toISOString() : null,
      lastSyncedAt: rest.lastSyncedAt ? rest.lastSyncedAt.toISOString() : null,
      createdAt: rest.createdAt.toISOString(),
      updatedAt: rest.updatedAt.toISOString(),
      flags: parseMaybeJson<string[]>(flagsJson, []),
    };
  });
  return okPaged(data, { page, size, total });
});
