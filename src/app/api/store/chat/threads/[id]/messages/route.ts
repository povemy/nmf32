import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { broadcastToThread } from "@/lib/chat";

export const dynamic = "force-dynamic";

// GET /api/store/chat/threads/[id]/messages — seller reads a conversation.
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { store } = await requireActiveSellerStore();
  const thread = await db.chatThread.findUnique({
    where: { id },
    include: {
      shopper: { select: { fullName: true, email: true } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!thread || thread.storeId !== store.id) throw new ApiError(404, "NOT_FOUND", "Conversation not found");
  return ok({
    thread: {
      id: thread.id,
      shopperName: thread.shopper.fullName,
      shopperEmail: thread.shopper.email,
      orderNumber: thread.orderNumber,
      subject: thread.subject,
      lastMessageAt: thread.lastMessageAt,
    },
    messages: thread.messages.map((m) => ({
      id: m.id,
      senderType: m.senderType,
      senderName: m.senderName,
      body: m.body,
      createdAt: m.createdAt,
    })),
  });
});

// POST /api/store/chat/threads/[id]/messages { body } — seller replies.
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { me, store } = await requireActiveSellerStore();
  const { body: text } = (await req.json().catch(() => ({}))) as { body?: string };
  const trimmed = (text ?? "").trim();
  if (!trimmed) throw new ApiError(400, "VALIDATION", "Message cannot be empty");

  const thread = await db.chatThread.findUnique({ where: { id } });
  if (!thread || thread.storeId !== store.id) throw new ApiError(404, "NOT_FOUND", "Conversation not found");

  const message = await db.chatMessage.create({
    data: { threadId: thread.id, senderType: "seller", senderName: store.name, body: trimmed.slice(0, 2000) },
  });
  await db.chatThread.update({ where: { id: thread.id }, data: { lastMessageAt: new Date() } });

  const payload = {
    id: message.id,
    threadId: thread.id,
    senderType: "seller" as const,
    senderName: store.name,
    body: message.body,
    createdAt: message.createdAt,
  };
  await broadcastToThread(thread.id, "chat:message", payload);
  await logActivitySafe(me.id, me.email);
  return ok(payload);
});

async function logActivitySafe(sellerId: string, email: string) {
  try {
    const { logActivity } = await import("@/lib/api");
    await logActivity({ actorType: "seller", actorId: sellerId, actorLabel: email, action: "chat.reply" });
  } catch {
    /* activity log is best-effort */
  }
}
