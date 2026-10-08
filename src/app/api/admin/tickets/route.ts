import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { handle, okPaged, getPagination } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

// GET /api/admin/tickets?status=&page=&size=
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const url = new URL(req.url);
  const { page, size, skip, take } = getPagination(url);
  const status = url.searchParams.get("status");

  const where: Prisma.SupportTicketWhereInput = status && status !== "all" ? { status } : {};

  const [rows, total] = await Promise.all([
    db.supportTicket.findMany({
      where,
      include: {
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
        _count: { select: { messages: true } },
      },
      orderBy: { updatedAt: "desc" },
      skip,
      take,
    }),
    db.supportTicket.count({ where }),
  ]);

  // store names resolved manually (no relation declared on SupportTicket)
  const storeIds = [...new Set(rows.map((t) => t.storeId).filter((x): x is string => !!x))];
  const stores = storeIds.length ? await db.store.findMany({ where: { id: { in: storeIds } }, select: { id: true, name: true, slug: true } }) : [];
  const stMap = new Map(stores.map((s) => [s.id, s]));

  const data = rows.map((t) => ({
    ...t,
    store: t.storeId ? stMap.get(t.storeId) ?? null : null,
    lastMessage: t.messages[0] ?? null,
    messageCount: t._count.messages,
    messages: undefined,
    _count: undefined,
  }));
  return okPaged(data, { page, size, total });
});
