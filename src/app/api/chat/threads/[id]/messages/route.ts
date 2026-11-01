import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { rateLimitKey } from "@/lib/rate-limit";
import { broadcastToThread, notifyUserInbox, sellerIdForStore } from "@/lib/chat";
import { maybeAutoReply } from "@/lib/chat-quick-replies";

export const dynamic = "force-dynamic";

// POST /api/chat/threads/[id]/messages { body } — shopper sends a message.
// Bumps the seller's unread badge; the (dormant) auto-reply scaffold runs
// after the broadcast so flipping AUTO_REPLY_CONFIG.enabled activates it.
// Phase 2.4 (C2.x): per-user send throttle — 20 msgs/min/shopper (identity-
// keyed, so a spammer rotating IPs still hits the wall).
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const me = await requireShopper();
  rateLimitKey(me.id, "chat-send-shopper", 20, 60_000);
  const { body: text } = (await req.json().catch(() => ({}))) as { body?: string };
  const trimmed = (text ?? "").trim();
  if (!trimmed) throw new ApiError(400, "VALIDATION", "Message cannot be empty");

  const thread = await db.chatThread.findUnique({ where: { id } });
  if (!thread) throw new ApiError(404, "NOT_FOUND", "Conversation not found");
  if (thread.shopperId !== me.id) throw new ApiError(403, "FORBIDDEN", "Not your conversation");

  const message = await db.chatMessage.create({
    data: { threadId: thread.id, senderType: "shopper", senderName: me.fullName, body: trimmed.slice(0, 2000) },
  });
  await db.chatThread.update({
    where: { id: thread.id },
    data: { lastMessageAt: new Date(), sellerUnread: { increment: 1 }, shopperUnread: 0 },
  });

  const payload = {
    id: message.id,
    threadId: thread.id,
    senderType: "shopper" as const,
    senderName: me.fullName,
    body: message.body,
    createdAt: message.createdAt,
    readAt: null,
  };
  const sellerUserId = await sellerIdForStore(thread.storeId);
  // thread room → open panels; seller user room → inbox feed refresh
  await broadcastToThread(thread.id, "chat:message", payload, sellerUserId ? [`user:${sellerUserId}`] : []);
  await notifyUserInbox([sellerUserId], {
    threadId: thread.id,
    event: "chat:activity",
    at: new Date().toISOString(),
    preview: message.body,
    senderType: "shopper",
  });

  // ---- auto-reply scaffold (dormant — see src/lib/chat-quick-replies.ts) ----
  const counts = await db.chatMessage.groupBy({
    by: ["senderType"],
    where: { threadId: thread.id },
    _count: { _all: true },
  });
  const auto = maybeAutoReply({
    threadId: thread.id,
    shopperMessageCount: counts.find((c) => c.senderType === "shopper")?._count._all ?? 0,
    sellerMessageCount: counts.find((c) => c.senderType === "seller")?._count._all ?? 0,
  });
  if (auto) {
    const botMsg = await db.chatMessage.create({
      data: { threadId: thread.id, senderType: "seller", senderName: "NOMOFEE Assistant", body: auto.body },
    });
    await db.chatThread.update({ where: { id: thread.id }, data: { lastMessageAt: new Date(), shopperUnread: { increment: 1 } } });
    await broadcastToThread(thread.id, "chat:message", {
      id: botMsg.id,
      threadId: thread.id,
      senderType: "seller",
      senderName: "NOMOFEE Assistant",
      body: botMsg.body,
      createdAt: botMsg.createdAt,
      readAt: null,
      isAutoReply: true,
    });
  }

  return ok(payload);
});
