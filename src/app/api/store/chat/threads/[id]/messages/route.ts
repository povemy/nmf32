import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { broadcastToThread, notifyUserInbox } from "@/lib/chat";
import { clearThreadContext, resolveThreadContext } from "@/lib/chat-context";

export const dynamic = "force-dynamic";

// GET /api/store/chat/threads/[id]/messages — seller reads a conversation.
// Returns the context card (product/order bubble) and clears the seller-side
// unread badge (opening a conversation = read).
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { store } = await requireActiveSellerStore();
  const thread = await db.chatThread.findUnique({
    where: { id },
    include: {
      store: { select: { slug: true } },
      shopper: { select: { fullName: true, email: true } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
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
    // shopper's open panel flips their messages to ✓✓ live
    await broadcastToThread(thread.id, "chat:read", { threadId: thread.id, readerType: "seller", at: now.toISOString() });
  }

  const context = await resolveThreadContext({
    contextType: thread.contextType,
    orderNumber: thread.orderNumber,
    productId: thread.productId,
    storeId: thread.storeId,
    storeSlug: thread.store.slug,
  });

  return ok({
    thread: {
      id: thread.id,
      shopperName: thread.shopper.fullName,
      shopperEmail: thread.shopper.email,
      orderNumber: thread.orderNumber,
      contextType: thread.contextType,
      subject: thread.subject,
      lastMessageAt: thread.lastMessageAt,
    },
    context,
    messages: thread.messages.map((m) => ({
      id: m.id,
      senderType: m.senderType,
      senderName: m.senderName,
      body: m.body,
      createdAt: m.createdAt,
      readAt: m.readAt,
    })),
  });
});

// POST /api/store/chat/threads/[id]/messages { body } — seller replies.
// Bumps the shopper's unread badge.
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
  await db.chatThread.update({
    where: { id: thread.id },
    data: { lastMessageAt: new Date(), shopperUnread: { increment: 1 }, sellerUnread: 0 },
  });

  const payload = {
    id: message.id,
    threadId: thread.id,
    senderType: "seller" as const,
    senderName: store.name,
    body: message.body,
    createdAt: message.createdAt,
    readAt: null,
  };
  // thread room → open panels; shopper user room → inbox feed refresh
  await broadcastToThread(thread.id, "chat:message", payload, [`user:${thread.shopperId}`]);
  await notifyUserInbox([thread.shopperId], {
    threadId: thread.id,
    event: "chat:activity",
    at: new Date().toISOString(),
    preview: message.body,
    senderType: "seller",
  });
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

// PATCH /api/store/chat/threads/[id]/messages { action: "clearContext" } — the
// seller closes the quoted product/order, turning the thread into a casual
// direct message. Broadcasts `chat:context` so the shopper's pinned card
// disappears live.
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { store } = await requireActiveSellerStore();
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== "clearContext") throw new ApiError(400, "BAD_REQUEST", "Unsupported action");

  const thread = await db.chatThread.findUnique({
    where: { id },
    select: { id: true, storeId: true },
  });
  if (!thread || thread.storeId !== store.id) throw new ApiError(404, "NOT_FOUND", "Conversation not found");

  await clearThreadContext(thread.id);
  return ok({ threadId: thread.id, contextType: null });
});
