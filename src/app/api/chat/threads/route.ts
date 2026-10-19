import { db } from "@/lib/db";
import { handle, ok, okPaged, ApiError, getPagination } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { broadcastToThread, notifyUserInbox, sellerIdForStore } from "@/lib/chat";
import type { ChatMessage } from "@prisma/client";

export const dynamic = "force-dynamic";

// GET /api/chat/threads?q=&filter=all|active&page=&size= — the signed-in
// shopper's conversations, newest activity first. Search matches store name,
// subject, order reference or the latest message body. `filter=active` keeps
// only threads with unread activity. `unreadCount` = seller messages newer
// than the shopper's last read mark.
export const GET = handle(async (req: Request) => {
  const me = await requireShopper();
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const filter = url.searchParams.get("filter") === "active" ? "active" : "all";
  const { page, size, skip, take } = getPagination(url, 100);

  // Search across store name, subject/order reference AND the latest message
  // body: SQLite `contains` is ASCII-case-insensitive, good enough for lookup.
  const baseWhere = {
    shopperId: me.id,
    ...(q
      ? {
          OR: [
            { store: { name: { contains: q } } },
            { store: { slug: { contains: q } } },
            { subject: { contains: q } },
            { orderNumber: { contains: q } },
            { messages: { some: { body: { contains: q } } } },
          ],
        }
      : {}),
    ...(filter === "active" ? { shopperUnread: { gt: 0 } } : {}),
  };

  const [threads, total] = await Promise.all([
    db.chatThread.findMany({
      where: baseWhere,
      orderBy: { lastMessageAt: "desc" },
      skip,
      take,
      include: {
        store: { select: { id: true, name: true, slug: true, logoUrl: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    }),
    db.chatThread.count({ where: baseWhere }),
  ]);

  return okPaged(
    threads.map((t) => ({
      id: t.id,
      storeId: t.store.id,
      displayName: t.store.name,
      avatarUrl: t.store.logoUrl,
      storeSlug: t.store.slug,
      orderNumber: t.orderNumber,
      contextType: t.contextType,
      subject: t.subject,
      createdAt: t.createdAt,
      lastMessageAt: t.lastMessageAt,
      unreadCount: t.shopperUnread,
      lastMessage: t.messages[0]
        ? { body: t.messages[0].body, senderType: t.messages[0].senderType, createdAt: t.messages[0].createdAt, readAt: t.messages[0].readAt }
        : null,
    })),
    { page, size, total }
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
    const payload = {
      id: message.id,
      threadId: thread.id,
      senderType: "shopper",
      senderName: me.fullName,
      body: message.body,
      createdAt: message.createdAt,
      readAt: null,
    };
    const sellerUserId = await sellerIdForStore(store.id);
    // thread room → open conversation panels; seller user room → inbox push
    // (brand-new thread appears live, no refresh needed)
    await broadcastToThread(thread.id, "chat:message", payload, sellerUserId ? [`user:${sellerUserId}`] : []);
    await notifyUserInbox([sellerUserId], {
      threadId: thread.id,
      event: "chat:activity",
      at: new Date().toISOString(),
      preview: message.body,
      senderType: "shopper",
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
