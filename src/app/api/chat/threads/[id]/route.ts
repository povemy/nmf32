import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { getSession, requireShopper } from "@/lib/auth";
import { resolveThreadContext } from "@/lib/chat-context";

export const dynamic = "force-dynamic";

// GET /api/chat/threads/[id] — full conversation. Access: the thread's shopper
// owner or the seller who owns the store.
// Also returns the conversation "context card" (what the chat is about — a
// product or an order) used to render the clickable bubble in the chat UI,
// and clears the reader-side unread badge (opening a conversation = read).
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const sess = await getSession();
  if (!sess) throw new ApiError(401, "UNAUTHORIZED", "Login required");

  const thread = await db.chatThread.findUnique({
    where: { id },
    include: {
      store: { select: { id: true, name: true, slug: true } },
      shopper: { select: { id: true, fullName: true, email: true } },
      messages: { orderBy: { createdAt: "asc" } },
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

  // opening the conversation = the reader has seen everything in it
  await db.chatThread.update({
    where: { id: thread.id },
    data: isShopper ? { shopperUnread: 0 } : { sellerUnread: 0 },
  });

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
      storeId: thread.store.id,
      storeName: thread.store.name,
      storeSlug: thread.store.slug,
      shopperName: thread.shopper.fullName,
      orderNumber: thread.orderNumber,
      contextType: thread.contextType,
      subject: thread.subject,
      createdAt: thread.createdAt,
      lastMessageAt: thread.lastMessageAt,
    },
    context,
    messages: thread.messages.map((m) => ({
      id: m.id,
      senderType: m.senderType,
      senderName: m.senderName,
      body: m.body,
      createdAt: m.createdAt,
    })),
  });
});
