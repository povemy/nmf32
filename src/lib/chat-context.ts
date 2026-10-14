import { db } from "@/lib/db";

// ============================================================================
// Chat context card — the clickable "what is this conversation about" bubble.
// A thread's context is stamped by the entry point the SHOPPER used:
//   • product page ("Message seller")          → kind: "product"
//   • order page ("Contact seller")            → kind: "order"
// Both sides of the conversation receive the card data from the thread detail
// endpoints and render it as a tappable bubble; tapping deep-links to the
// product (shopper) or the order/product admin (seller).
// ============================================================================

export type ThreadContextCard =
  | {
      kind: "product";
      productId: string;
      title: string;
      slug: string;
      storeSlug: string;
      image: string | null;
      priceMinor: number;
      compareAtPriceMinor: number | null;
    }
  | {
      kind: "order";
      orderId: string;
      orderNumber: string;
      status: string;
      totalMinor: number;
      placedAt: string;
      itemCount: number;
      firstItemTitle: string | null;
      firstItemImage: string | null;
    };

/**
 * Resolve the context card for a chat thread (null when the thread has no
 * product/order context — e.g. a plain direct message).
 */
export async function resolveThreadContext(thread: {
  contextType: string | null;
  orderNumber: string | null;
  productId: string | null;
  storeId: string;
  storeSlug: string;
}): Promise<ThreadContextCard | null> {
  if (thread.contextType === "product" && thread.productId) {
    const product = await db.product.findUnique({
      where: { id: thread.productId },
      select: {
        id: true,
        title: true,
        slug: true,
        priceMinor: true,
        images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } },
      },
    });
    if (!product) return null;
    return {
      kind: "product",
      productId: product.id,
      title: product.title,
      slug: product.slug,
      storeSlug: thread.storeSlug,
      image: product.images[0]?.url ?? null,
      priceMinor: product.priceMinor,
      compareAtPriceMinor: null as number | null,
    };
  }

  if (thread.contextType === "order" && thread.orderNumber) {
    const order = await db.order.findFirst({
      where: { orderNumber: thread.orderNumber, storeId: thread.storeId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        totalMinor: true,
        createdAt: true,
        items: { take: 1, select: { title: true, qty: true, product: { select: { images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } } } } } },
        _count: { select: { items: true } },
      },
    });
    if (!order) return null;
    return {
      kind: "order",
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      totalMinor: order.totalMinor,
      placedAt: order.createdAt.toISOString(),
      itemCount: order._count.items,
      firstItemTitle: order.items[0]?.title ?? null,
      firstItemImage: order.items[0]?.product?.images[0]?.url ?? null,
    };
  }

  return null;
}
