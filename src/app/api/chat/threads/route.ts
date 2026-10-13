import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { broadcastToThread } from "@/lib/chat";
import type { ChatMessage } from "@prisma/client";

export const dynamic = "force-dynamic";

// GET /api/chat/threads — the signed-in shopper's conversations.
// `unreadCount` = seller messages newer than the shopper's last read mark.
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
      contextType: t.contextType,
      subject: t.subject,
      createdAt: t.createdAt,
      lastMessageAt: t.lastMessageAt,
      unreadCount: t.shopperUnread,
      lastMessage: t.messages[0]
        ? { body: t.messages[0].body, senderType: t.messages[0].senderType, createdAt: t.messages[0].createdAt }
        : null,
    }))
  );
});

// POST /api/chat/threads { storeId | storeSlug, orderNumber? | productId?, message? } —
// get-or-create the conversation with a store, stamp WHAT it is about
// (order vs product — drives the context bubble in the chat UI) and
// optionally seed the first message.
export const POST = handle(async (req: Request) => {
  const me = await requireShopper();
  const body = (await req.json().catch(() => ({}))) as {
    storeId?: string; storeSlug?: string; orderNumber?: string; productId?: string; message?: string; subject?: string;
  };

  const store = body.storeId
    ? await db.store.findUnique({ where: { id: body.storeId } })
    : body.storeSlug
      ? await db.store.findUnique({ where: { slug: body.storeSlug } })
      : null;
  if (!store) throw new ApiError(404, "NOT_FOUND", "Store not found");

  // ---- resolve the conversation context -------------------------------------
  // Product entry point (PDP "Message seller"): quote that product.
  let contextType: string | null = null;
  let productId: string | null = null;
  let productName: string | null = null;
  if (body.productId) {
    const product = await db.product.findUnique({
      where: { id: body.productId },
      select: { id: true, title: true, storeId: true },
    });
    if (!product || product.storeId !== store.id) throw new ApiError(404, "NOT_FOUND", "Product not found in this store");
    contextType = "product";
    productId = product.id;
    productName = product.title;
  }

  // Order entry point (order success / order status "Contact seller"):
  // quote that order. Orders are guest-based (no account link), so scope the
  // lookup to the thread's store — same privacy level as /api/orders/lookup
  // (email + orderNumber).
  let orderId: string | null = null;
  let orderNumber: string | null = null;
  if (body.orderNumber) {
    const order = await db.order.findFirst({
      where: { orderNumber: body.orderNumber, storeId: store.id },
      select: { id: true, orderNumber: true },
    });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
    contextType = "order";
    orderId = order.id;
    orderNumber = order.orderNumber;
  }

  // Default seed message reflects the entry point ("cute bubble" copy).
  const seedMessage =
    (body.message ?? "").trim() ||
    (productName
      ? `Hi ${store.name}! I'd like to ask about “${productName}”.`
      : orderNumber
        ? `Hi ${store.name}! I'd like to ask about my order ${orderNumber}.`
        : "");

  const subject =
    body.subject ??
    (productName ? `About “${productName}”` : orderNumber ? `About order ${orderNumber}` : null);

  const thread = await db.chatThread.upsert({
    where: { shopperId_storeId: { shopperId: me.id, storeId: store.id } },
    create: {
      shopperId: me.id,
      storeId: store.id,
      orderNumber,
      orderId,
      contextType,
      productId,
      subject,
      shopperUnread: 0, // the shopper authored this entry point
    },
    update: {
      lastMessageAt: new Date(),
      // re-stamp the context every time the shopper re-enters from a new spot —
      // the bubble always shows what the LATEST inquiry is about
      ...(contextType ? { contextType, productId, orderId, orderNumber: orderNumber ?? undefined } : {}),
      ...(subject ? { subject } : {}),
      shopperUnread: 0,
    },
  });

  let message: ChatMessage | null = null;
  if (seedMessage) {
    message = await db.chatMessage.create({
      data: { threadId: thread.id, senderType: "shopper", senderName: me.fullName, body: seedMessage.slice(0, 2000) },
    });
    await db.chatThread.update({
      where: { id: thread.id },
      data: { lastMessageAt: new Date(), sellerUnread: { increment: 1 } },
    });
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
      contextType: thread.contextType,
      subject: thread.subject,
      lastMessageAt: thread.lastMessageAt,
    },
    message,
  });
});
