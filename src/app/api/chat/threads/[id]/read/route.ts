import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { broadcastToThread, sellerIdForStore } from "@/lib/chat";
import type { ChatMarkReadData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/chat/threads/[id]/read — mark the whole thread as read for the
// shopper (used by the chat UI when a message arrives while the thread is
// open; opening the thread also marks read via the detail GET). Stamps
// `readAt` on the seller's messages so the sender sees ✓✓ live via chat:read.
export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const me = await requireShopper();
  const thread = await db.chatThread.findUnique({ where: { id }, select: { id: true, shopperId: true, storeId: true } });
  if (!thread) throw new ApiError(404, "NOT_FOUND", "Conversation not found");
  if (thread.shopperId !== me.id) throw new ApiError(403, "FORBIDDEN", "Not your conversation");

  const now = new Date();
  const [_, marked] = await Promise.all([
    db.chatThread.update({ where: { id: thread.id }, data: { shopperUnread: 0 } }),
    db.chatMessage.updateMany({
      where: { threadId: thread.id, senderType: { not: "shopper" }, readAt: null },
      data: { readAt: now },
    }),
  ]);

  // tell the seller's open conversation panel that their messages were read
  const sellerUserId = await sellerIdForStore(thread.storeId);
  await broadcastToThread(
    thread.id,
    "chat:read",
    { threadId: thread.id, readerType: "shopper", at: now.toISOString() },
    sellerUserId ? [`user:${sellerUserId}`] : []
  );
  const payload: ChatMarkReadData = { read: true, marked };
  return ok(payload);
});
