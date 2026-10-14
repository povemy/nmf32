import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";

export const dynamic = "force-dynamic";

// POST /api/chat/threads/[id]/read — mark the whole thread as read for the
// shopper (used by the chat UI when a message arrives while the thread is
// open; opening the thread also marks read via the detail GET).
export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const me = await requireShopper();
  const thread = await db.chatThread.findUnique({ where: { id }, select: { id: true, shopperId: true } });
  if (!thread) throw new ApiError(404, "NOT_FOUND", "Conversation not found");
  if (thread.shopperId !== me.id) throw new ApiError(403, "FORBIDDEN", "Not your conversation");
  await db.chatThread.update({ where: { id: thread.id }, data: { shopperUnread: 0 } });
  return ok({ read: true });
});
