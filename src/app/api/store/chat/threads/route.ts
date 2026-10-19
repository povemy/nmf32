import { db } from "@/lib/db";
import { handle, okPaged, getPagination } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/store/chat/threads?q=&filter=all|active&page=&size= — seller inbox:
// conversations with shoppers, newest activity first. Search matches shopper
// name/email, subject, order reference or the latest message body.
// `filter=active` keeps only threads with unread shopper messages.
export const GET = handle(async (req: Request) => {
  const { store } = await requireActiveSellerStore();
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const filter = url.searchParams.get("filter") === "active" ? "active" : "all";
  const { page, size, skip, take } = getPagination(url, 100);

  const baseWhere = {
    storeId: store.id,
    ...(q
      ? {
          OR: [
            { shopper: { fullName: { contains: q } } },
            { shopper: { email: { contains: q } } },
            { subject: { contains: q } },
            { orderNumber: { contains: q } },
            { messages: { some: { body: { contains: q } } } },
          ],
        }
      : {}),
    ...(filter === "active" ? { sellerUnread: { gt: 0 } } : {}),
  };

  const [threads, total] = await Promise.all([
    db.chatThread.findMany({
      where: baseWhere,
      orderBy: { lastMessageAt: "desc" },
      skip,
      take,
      include: {
        shopper: { select: { id: true, fullName: true, email: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    }),
    db.chatThread.count({ where: baseWhere }),
  ]);

  return okPaged(
    threads.map((t) => ({
      id: t.id,
      shopperId: t.shopper.id,
      displayName: t.shopper.fullName,
      avatarUrl: null as string | null,
      shopperEmail: t.shopper.email,
      orderNumber: t.orderNumber,
      contextType: t.contextType,
      subject: t.subject,
      createdAt: t.createdAt,
      lastMessageAt: t.lastMessageAt,
      unreadCount: t.sellerUnread,
      lastMessage: t.messages[0]
        ? { body: t.messages[0].body, senderType: t.messages[0].senderType, createdAt: t.messages[0].createdAt, readAt: t.messages[0].readAt }
        : null,
    })),
    { page, size, total }
  );
});
