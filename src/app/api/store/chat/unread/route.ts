import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/store/chat/unread — total unread shopper messages for the store.
// Powers the "Messages" badge in the seller nav (polled + event-driven).
export const GET = handle(async () => {
  const { store } = await requireActiveSellerStore();
  const agg = await db.chatThread.aggregate({ where: { storeId: store.id }, _sum: { sellerUnread: true } });
  return ok({ total: agg._sum.sellerUnread ?? 0 });
});
