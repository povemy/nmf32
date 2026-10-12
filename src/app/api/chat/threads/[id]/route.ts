import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { getSession, requireShopper } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/chat/threads/[id] — full conversation. Access: the thread's shopper
// owner or the seller who owns the store.
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

  if (sess.userType === "shopper") {
    const me = await requireShopper();
    if (thread.shopperId !== me.id) throw new ApiError(403, "FORBIDDEN", "Not your conversation");
  } else if (sess.userType === "seller") {
    const store = await db.store.findUnique({ where: { sellerId: sess.userId }, select: { id: true } });
    if (!store || thread.storeId !== store.id) throw new ApiError(403, "FORBIDDEN", "Not your store's conversation");
  } else {
    throw new ApiError(403, "FORBIDDEN", "No access to this conversation");
  }

  return ok({
    thread: {
      id: thread.id,
      storeId: thread.store.id,
      storeName: thread.store.name,
      storeSlug: thread.store.slug,
      shopperName: thread.shopper.fullName,
      orderNumber: thread.orderNumber,
      subject: thread.subject,
      createdAt: thread.createdAt,
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
