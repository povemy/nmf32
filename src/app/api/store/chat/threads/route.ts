import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/store/chat/threads — seller inbox: conversations with this store.
export const GET = handle(async () => {
  const { store } = await requireActiveSellerStore();
  const threads = await db.chatThread.findMany({
    where: { storeId: store.id },
    orderBy: { lastMessageAt: "desc" },
    include: {
      shopper: { select: { id: true, fullName: true, email: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  return ok(
    threads.map((t) => ({
      id: t.id,
      shopperName: t.shopper.fullName,
      shopperEmail: t.shopper.email,
      orderNumber: t.orderNumber,
      subject: t.subject,
      createdAt: t.createdAt,
      lastMessageAt: t.lastMessageAt,
      lastMessage: t.messages[0]
        ? { body: t.messages[0].body, senderType: t.messages[0].senderType, createdAt: t.messages[0].createdAt }
        : null,
    }))
  );
});
