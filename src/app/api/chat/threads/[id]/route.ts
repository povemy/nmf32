import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { getSession, requireShopper } from "@/lib/auth";
import { clearThreadContext, resolveThreadContext } from "@/lib/chat-context";
import { broadcastToThread } from "@/lib/chat";
import { loadChatMessagePage } from "@/lib/chat-pagination";
import type { ChatDetailMessage, ThreadDetailData, ClearContextBody, ClearContextData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/chat/threads/[id] — one BOUNDED page of the conversation (Phase 2.4
// C2.x keyset pagination: latest ?limit=50 messages; ?before=<messageId>
// returns the next older page — the UI prepends under "Load older messages").
// Access: the thread's shopper owner or the seller who owns the store.
// Also returns the conversation "context card" (what the chat is about — a
// product or an order) used to render the clickable bubble in the chat UI,
// and clears the reader-side unread badge (opening a conversation = read).
export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const sess = await getSession();
  if (!sess) throw new ApiError(401, "UNAUTHORIZED", "Login required");

  const thread = await db.chatThread.findUnique({
    where: { id },
    include: {
      store: { select: { id: true, name: true, slug: true } },
      shopper: { select: { id: true, fullName: true, email: true } },
    },
  });
  if (!thread) throw new ApiError(404, "NOT_FOUND", "Conversation not found");

  const isShopper = sess.userType === "shopper";
  if (isShopper) {
    const me = await requireShopper();
    if (thread.shopperId !== me.id) throw new ApiError(403, "FORBIDDEN", "Not your conversation");
  } else if (sess.userType === "seller") {
    const store = await db.store.findUnique({ where: { sellerId: sess.userId }, select: { id: true } });
    if (!store || thread.storeId !== store.id) throw new ApiError(403, "FORBIDDEN", "Not your store's conversation");
  } else {
    throw new ApiError(403, "FORBIDDEN", "No access to this conversation");
  }

  // opening the conversation = the reader has seen everything in it; stamp
  // readAt on the other party's messages so the sender sees ✓✓ (chat:read push)
  const now = new Date();
  const [, marked] = await Promise.all([
    db.chatThread.update({
      where: { id: thread.id },
      data: isShopper ? { shopperUnread: 0 } : { sellerUnread: 0 },
    }),
    db.chatMessage.updateMany({
      where: { threadId: thread.id, senderType: isShopper ? { not: "shopper" } : { not: "seller" }, readAt: null },
      data: { readAt: now },
    }),
  ]);
  if (marked.count > 0) {
    await broadcastToThread(thread.id, "chat:read", {
      threadId: thread.id,
      readerType: isShopper ? "shopper" : "seller",
      at: now.toISOString(),
    });
  }

  const context = await resolveThreadContext({
    contextType: thread.contextType,
    orderNumber: thread.orderNumber,
    productId: thread.productId,
    storeId: thread.storeId,
    storeSlug: thread.store.slug,
  });

  // bounded history page — AFTER access control so cursor errors never leak
  // the existence of someone else's thread
  const { messages, hasMore } = await loadChatMessagePage(thread.id, req);

  const payload: ThreadDetailData = {
    thread: {
      id: thread.id,
      storeId: thread.store.id,
      storeName: thread.store.name,
      storeSlug: thread.store.slug,
      shopperName: thread.shopper.fullName,
      orderNumber: thread.orderNumber,
      contextType: thread.contextType,
      subject: thread.subject,
      createdAt: thread.createdAt.toISOString(),
      lastMessageAt: thread.lastMessageAt.toISOString(),
    },
    context,
    hasMore,
    messages: messages.map((m): ChatDetailMessage => ({
      id: m.id,
      senderType: m.senderType,
      senderName: m.senderName,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
      readAt: m.readAt ? m.readAt.toISOString() : null,
    })),
  };
  return ok(payload);
});

// PATCH /api/chat/threads/[id] { action: "clearContext" } — the shopper (or
// the store) closes the quoted product/order, turning the thread into a
// casual direct message. Broadcasts `chat:context` so the other party's
// pinned card disappears live.
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const sess = await getSession();
  if (!sess) throw new ApiError(401, "UNAUTHORIZED", "Login required");
  const body = (await req.json().catch(() => ({}))) as ClearContextBody;
  if (body.action !== "clearContext") throw new ApiError(400, "BAD_REQUEST", "Unsupported action");

  const thread = await db.chatThread.findUnique({
    where: { id },
    select: { id: true, shopperId: true, storeId: true },
  });
  if (!thread) throw new ApiError(404, "NOT_FOUND", "Conversation not found");

  if (sess.userType === "shopper") {
    const me = await requireShopper();
    if (thread.shopperId !== me.id) throw new ApiError(403, "FORBIDDEN", "Not your conversation");
  } else if (sess.userType === "seller") {
    const store = await db.store.findUnique({ where: { sellerId: sess.userId }, select: { id: true } });
    if (!store || thread.storeId !== store.id) throw new ApiError(403, "FORBIDDEN", "Not your store's conversation");
  } else {
    throw new ApiError(403, "FORBIDDEN", "No access to this conversation");
  }

  await clearThreadContext(thread.id);
  const payload: ClearContextData = { threadId: thread.id, contextType: null };
  return ok(payload);
});
