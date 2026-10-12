import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { broadcastToThread } from "@/lib/chat";

export const dynamic = "force-dynamic";

// GET /api/chat/threads — the signed-in shopper's conversations.
export const GET = handle(async () => {
  const me = await requireShopper();
  const threads = await db.chatThread.findMany({
    where: { shopperId: me.id },
    orderBy: { lastMessageAt: "desc" },
    include: {
      store: { select: { id: true, name: true, slug: true, logoUrl: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  return ok(
    threads.map((t) => ({
      id: t.id,
      storeId: t.store.id,
      storeName: t.store.name,
      storeSlug: t.store.slug,
      storeLogoUrl: t.store.logoUrl,
      orderNumber: t.orderNumber,
      subject: t.subject,
      createdAt: t.createdAt,
      lastMessageAt: t.lastMessageAt,
      lastMessage: t.messages[0]
        ? { body: t.messages[0].body, senderType: t.messages[0].senderType, createdAt: t.messages[0].createdAt }
        : null,
    }))
  );
});

// POST /api/chat/threads { storeId | storeSlug, orderNumber?, message } —
// get-or-create the conversation with a store and optionally seed the first message.
export const POST = handle(async (req: Request) => {
  const me = await requireShopper();
  const body = (await req.json().catch(() => ({}))) as {
    storeId?: string; storeSlug?: string; orderNumber?: string; message?: string; subject?: string;
  };

  const store = body.storeId
    ? await db.store.findUnique({ where: { id: body.storeId } })
    : body.storeSlug
      ? await db.store.findUnique({ where: { slug: body.storeSlug } })
      : null;
  if (!store) throw new ApiError(404, "NOT_FOUND", "Store not found");

  const thread = await db.chatThread.upsert({
    where: { shopperId_storeId: { shopperId: me.id, storeId: store.id } },
    create: {
      shopperId: me.id,
      storeId: store.id,
      orderNumber: body.orderNumber ?? null,
      subject: body.subject ?? (body.orderNumber ? `About order ${body.orderNumber}` : null),
    },
    update: {
      lastMessageAt: new Date(),
      ...(body.orderNumber ? { orderNumber: body.orderNumber } : {}),
    },
  });

  let message = null;
  const text = (body.message ?? "").trim();
  if (text) {
    message = await db.chatMessage.create({
      data: { threadId: thread.id, senderType: "shopper", senderName: me.fullName, body: text.slice(0, 2000) },
    });
    await db.chatThread.update({ where: { id: thread.id }, data: { lastMessageAt: new Date() } });
    await broadcastToThread(thread.id, "chat:message", {
      id: message.id,
      threadId: thread.id,
      senderType: "shopper",
      senderName: me.fullName,
      body: message.body,
      createdAt: message.createdAt,
    });
  }

  return ok({
    thread: {
      id: thread.id,
      storeId: thread.storeId,
      storeName: store.name,
      storeSlug: store.slug,
      orderNumber: thread.orderNumber,
      subject: thread.subject,
      lastMessageAt: thread.lastMessageAt,
    },
    message,
  });
});
