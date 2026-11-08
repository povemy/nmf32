import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { broadcastToThread } from "@/lib/chat";
import type { ThreadReadData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/store/chat/threads/[id]/read — mark the whole thread as read for
// the seller (used by the seller chat UI when a message arrives while the
// thread is open; opening the thread also marks read via the messages GET).
export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { store } = await requireActiveSellerStore();
  const thread = await db.chatThread.findUnique({ where: { id }, select: { id: true, storeId: true } });
  if (!thread || thread.storeId !== store.id) throw new ApiError(404, "NOT_FOUND", "Conversation not found");
  const now = new Date();
  const [_, marked] = await Promise.all([
    db.chatThread.update({ where: { id: thread.id }, data: { sellerUnread: 0 } }),
    db.chatMessage.updateMany({
      where: { threadId: thread.id, senderType: { not: "seller" }, readAt: null },
      data: { readAt: now },
    }),
  ]);
  if (marked.count > 0) {
    await broadcastToThread(thread.id, "chat:read", { threadId: thread.id, readerType: "seller", at: now.toISOString() });
  }
  const payload: ThreadReadData = { read: true, marked };
  return ok(payload);
});
