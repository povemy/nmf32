import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { broadcastToThread } from "@/lib/chat";

export const dynamic = "force-dynamic";

// POST /api/chat/threads/[id]/messages { body } — shopper sends a message.
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const me = await requireShopper();
  const { body: text } = (await req.json().catch(() => ({}))) as { body?: string };
  const trimmed = (text ?? "").trim();
  if (!trimmed) throw new ApiError(400, "VALIDATION", "Message cannot be empty");

  const thread = await db.chatThread.findUnique({ where: { id } });
  if (!thread) throw new ApiError(404, "NOT_FOUND", "Conversation not found");
  if (thread.shopperId !== me.id) throw new ApiError(403, "FORBIDDEN", "Not your conversation");

  const message = await db.chatMessage.create({
    data: { threadId: thread.id, senderType: "shopper", senderName: me.fullName, body: trimmed.slice(0, 2000) },
  });
  await db.chatThread.update({ where: { id: thread.id }, data: { lastMessageAt: new Date() } });

  const payload = {
    id: message.id,
    threadId: thread.id,
    senderType: "shopper" as const,
    senderName: me.fullName,
    body: message.body,
    createdAt: message.createdAt,
  };
  await broadcastToThread(thread.id, "chat:message", payload);
  return ok(payload);
});
