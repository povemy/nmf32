import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { requireShopper } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/chat/unread — total unread seller messages for the shopper.
// Powers the "My messages" badge in the shopper header (polled + event-driven).
export const GET = handle(async () => {
  const me = await requireShopper();
  const agg = await db.chatThread.aggregate({ where: { shopperId: me.id }, _sum: { shopperUnread: true } });
  return ok({ total: agg._sum.shopperUnread ?? 0 });
});
