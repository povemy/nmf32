import { db } from "@/lib/db";
import { handle, ok, okPaged, ApiError, getPagination } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { broadcastToThread, notifyUserInbox, sellerIdForStore } from "@/lib/chat";
import { rateLimit } from "@/lib/rate-limit";
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
  // body. NOTE (Phase 2.4 cleanup): on the CURRENT Postgres backend `contains`
  // maps to case-sensitive LIKE — this was written when the DB was SQLite
  // (ASCII-case-insensitive). Search here is therefore exact-case substring;
  // folding to ILIKE/mode:"insensitive" is a deliberate future tweak, not an
  // accident.
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
  // Phase 1 (B4): thread creation throttle (get-or-create upsert + possible
  // seed message + seller notification — keep automated abuse bounded).
  rateLimit(req, "chat-threads", 20);
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
  // quote that order — Phase 1 (B3 / F-1) ownership enforcement, TIGHTENED in
  // Phase 2.1: the signed-in shopper must OWN the order via Order.shopperId.
  // The previous email-match fallback (`order.customerEmail === me.email`) has
  // been REMOVED: shopper registration performs no email verification, so
  // registering with a victim's email address would have granted chat access
  // to that victim's guest orders knowing ONLY the order number — strictly
  // weaker than the /api/orders/lookup knowledge pair. Legitimate buyers are
  // unaffected: guest orders with the account's email are CLAIMED into the
  // account at registration (claimGuestStateForShopper) and logged-in checkout
  // sets shopperId directly, so `shopperId === me.id` covers every real owner.
  // True guest buyers (no account, unclaimed order) contact the seller via the
  // product context or a plain thread, exactly as before. Uniform 404 for
  // missing AND non-owned orders (no existence oracle).
  let orderId: string | null = null;
  let orderNumber: string | null = null;
  if (body.orderNumber) {
    const order = await db.order.findFirst({
      where: { orderNumber: body.orderNumber, storeId: store.id },
      select: { id: true, orderNumber: true, shopperId: true },
    });
    if (!order || order.shopperId !== me.id) throw new ApiError(404, "NOT_FOUND", "Order not found");
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
