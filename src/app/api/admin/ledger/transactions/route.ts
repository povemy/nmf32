import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { handle, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

// GET /api/admin/ledger/transactions?type=&walletId=&cursor= — latest 100, cursor by id desc
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  const walletId = url.searchParams.get("walletId");
  const cursor = url.searchParams.get("cursor");

  const where: Prisma.LedgerTransactionWhereInput = {
    ...(type && type !== "all" ? { txnType: type } : {}),
    ...(walletId ? { lines: { some: { walletId } } } : {}),
    ...(cursor ? { id: { lt: cursor } } : {}),
  };

  const txns = await db.ledgerTransaction.findMany({
    where,
    include: { lines: { orderBy: { id: "asc" } } },
    orderBy: { id: "desc" },
    take: 101,
  });

  const hasMore = txns.length > 100;
  const items = hasMore ? txns.slice(0, 100) : txns;
  const nextCursor = hasMore ? items[items.length - 1].id : null;

  return ok({ items, nextCursor, count: items.length });
});
