import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { handle, okPaged, getPagination } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

// GET /api/admin/payouts?status=&batchId=&page=&size=
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const url = new URL(req.url);
  const { page, size, skip, take } = getPagination(url);
  const status = url.searchParams.get("status");
  const batchId = url.searchParams.get("batchId");

  const where: Prisma.PayoutWhereInput = {
    ...(status && status !== "all" ? { status } : {}),
    ...(batchId ? { batchId } : {}),
  };

  const [rows, total] = await Promise.all([
    db.payout.findMany({
      where,
      include: {
        bankAccount: { select: { id: true, bankName: true, holderName: true, accountNumberMasked: true } },
        batch: { select: { id: true, status: true, runType: true, startedAt: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    db.payout.count({ where }),
  ]);

  // seller info resolved manually (no relation declared on Payout)
  const sellerIds = [...new Set(rows.map((p) => p.sellerId))];
  const sellers = sellerIds.length
    ? await db.seller.findMany({
        where: { id: { in: sellerIds } },
        select: { id: true, email: true, displayName: true, fullName: true, store: { select: { id: true, name: true, slug: true } } },
      })
    : [];
  const sMap = new Map(sellers.map((s) => [s.id, s]));

  const data = rows.map((p) => {
    const s = sMap.get(p.sellerId);
    return { ...p, seller: s ?? null, storeName: s?.store?.name ?? null };
  });
  return okPaged(data, { page, size, total });
});
