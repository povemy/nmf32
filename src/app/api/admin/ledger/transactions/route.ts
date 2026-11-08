import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { handle, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import type {
  AdminLedgerLineRow,
  AdminLedgerTransactionsData,
  AdminLedgerTransactionsQuery,
  AdminLedgerTxnRow,
} from "@/lib/types/api-contract";

// GET /api/admin/ledger/transactions?type=&walletId=&cursor= — latest 100, cursor by id desc
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const url = new URL(req.url);
  const type: AdminLedgerTransactionsQuery["type"] = url.searchParams.get("type") ?? undefined;
  const walletId: AdminLedgerTransactionsQuery["walletId"] = url.searchParams.get("walletId") ?? undefined;
  const cursor: AdminLedgerTransactionsQuery["cursor"] = url.searchParams.get("cursor") ?? undefined;

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
  const page = hasMore ? txns.slice(0, 100) : txns;
  const items: AdminLedgerTxnRow[] = page.map((t) => ({
    ...t,
    occurredAt: t.occurredAt.toISOString(),
    lines: t.lines.map(
      (l): AdminLedgerLineRow => ({
        ...l,
        availableAt: l.availableAt ? l.availableAt.toISOString() : null,
        createdAt: l.createdAt.toISOString(),
      })
    ),
  }));

  const payload: AdminLedgerTransactionsData = {
    items,
    nextCursor: hasMore ? page[page.length - 1].id : null,
    count: items.length,
  };
  return ok(payload);
});
