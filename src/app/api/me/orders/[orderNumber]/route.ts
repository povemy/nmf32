import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { maybeSyncTracking, mockPodUrl } from "@/lib/shipping";
import { parseJson } from "@/lib/json";
import { placeholderUrl } from "@/lib/placeholder";
import type {
  MeOrderDetailItem,
  MeOrderDispute,
  MeOrderHistoryEntry,
  MeShipmentDetail,
  MeShipmentEvent,
  OrderDetailData,
} from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

type AddressShape = { line1?: string; city?: string; state?: string; postcode?: string };

// GET /api/me/orders/[orderNumber] — account-scoped order detail for the
// signed-in buyer: full money breakdown, customer & shipping block, item rows
// with the first product image, and the shipment timeline (incl. POD proof).
// Ownership is enforced by shopperId (claimed at login/checkout) — no
// order-number tweaking can read another buyer's order.
// Lazy tracking: opening the timeline advances a stale (>45s) mock shipment.
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ orderNumber: string }> }) => {
  const me = await requireShopper();
  const { orderNumber } = await ctx.params;

  let order = await db.order.findFirst({
    where: { orderNumber: orderNumber.trim().toUpperCase(), shopperId: me.id },
    select: {
      id: true, orderNumber: true, status: true, currency: true,
      subtotalMinor: true, discountMinor: true, shippingMinor: true, taxMinor: true, totalMinor: true,
      customerName: true, customerEmail: true, customerPhone: true, customerNote: true,
      shippingAddressJson: true,
      paymentProvider: true, paidAt: true, shippedAt: true, deliveredAt: true, receivedAt: true, completedAt: true,
      trackingNumber: true, createdAt: true,
      store: { select: { id: true, name: true, slug: true } },
      items: {
        orderBy: { id: "asc" },
        select: {
          id: true, title: true, variantLabel: true, qty: true, unitPriceMinor: true, lineSubtotalMinor: true,
          productId: true, variantId: true,
          product: { select: { slug: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } } } },
        },
      },
      history: { orderBy: { createdAt: "asc" }, select: { fromStatus: true, toStatus: true, actor: true, note: true, createdAt: true } },
      shipment: {
        include: { events: { orderBy: { occurredAt: "asc" } } },
      },
      disputes: { orderBy: { createdAt: "desc" }, select: { id: true, reason: true, status: true, resolution: true, createdAt: true } },
    },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "No order with that number on your account");

  // Lazy sync — advance the mock courier when the buyer opens the timeline.
  if (
    order.shipment &&
    order.shipment.providerId === "mock" &&
    order.status === "shipped"
  ) {
    await maybeSyncTracking(order.shipment.id);
    order = (await db.order.findFirst({
      where: { id: order.id },
      select: {
        id: true, orderNumber: true, status: true, currency: true,
        subtotalMinor: true, discountMinor: true, shippingMinor: true, taxMinor: true, totalMinor: true,
        customerName: true, customerEmail: true, customerPhone: true, customerNote: true,
        shippingAddressJson: true,
        paymentProvider: true, paidAt: true, shippedAt: true, deliveredAt: true, receivedAt: true, completedAt: true,
        trackingNumber: true, createdAt: true,
        store: { select: { id: true, name: true, slug: true } },
        items: {
          orderBy: { id: "asc" },
          select: {
            id: true, title: true, variantLabel: true, qty: true, unitPriceMinor: true, lineSubtotalMinor: true,
            productId: true, variantId: true,
            product: { select: { slug: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } } } },
          },
        },
        history: { orderBy: { createdAt: "asc" }, select: { fromStatus: true, toStatus: true, actor: true, note: true, createdAt: true } },
        shipment: { include: { events: { orderBy: { occurredAt: "asc" } } } },
        disputes: { orderBy: { createdAt: "desc" }, select: { id: true, reason: true, status: true, resolution: true, createdAt: true } },
      },
    }))!;
  }

  const address = parseJson<AddressShape>(order.shippingAddressJson, {});
  const shipment = order.shipment;

  const shipmentDetail: MeShipmentDetail | null = shipment
    ? {
        status: shipment.status,
        providerId: shipment.providerId,
        courierName: shipment.courierName,
        awbNumber: shipment.awbNumber,
        labelUrl: shipment.labelUrl,
        etaFrom: shipment.etaFrom ? shipment.etaFrom.toISOString() : null,
        etaTo: shipment.etaTo ? shipment.etaTo.toISOString() : null,
        bookedAt: shipment.bookedAt ? shipment.bookedAt.toISOString() : null,
        deliveredAt: shipment.deliveredAt ? shipment.deliveredAt.toISOString() : null,
        events: shipment.events.map((e): MeShipmentEvent => ({
          id: e.id,
          status: e.status,
          description: e.description,
          location: e.location,
          occurredAt: e.occurredAt.toISOString(),
          proofImageUrl: e.proofImageUrl ?? (e.status === "DELIVERED" && !e.proofImageUrl ? mockPodUrl(shipment.awbNumber ?? order.orderNumber) : null),
        })),
      }
    : null;

  const disputeDetail: MeOrderDispute | null = order.disputes[0]
    ? {
        id: order.disputes[0].id,
        reason: order.disputes[0].reason,
        status: order.disputes[0].status,
        resolution: order.disputes[0].resolution,
        createdAt: order.disputes[0].createdAt.toISOString(),
      }
    : null;

  const payload: OrderDetailData = {
    orderNumber: order.orderNumber,
    status: order.status,
    currency: order.currency,
    subtotalMinor: order.subtotalMinor,
    discountMinor: order.discountMinor,
    shippingMinor: order.shippingMinor,
    taxMinor: order.taxMinor,
    totalMinor: order.totalMinor,
    createdAt: order.createdAt.toISOString(),
    customerName: order.customerName,
    customerEmail: order.customerEmail, // lets the receipt endpoint work for account orders
    customerPhone: order.customerPhone,
    customerNote: order.customerNote,
    shippingAddress: address.line1 || address.city || address.state ? address : null,
    paymentProvider: order.paymentProvider,
    paidAt: order.paidAt ? order.paidAt.toISOString() : null,
    shippedAt: order.shippedAt ? order.shippedAt.toISOString() : null,
    deliveredAt: order.deliveredAt ? order.deliveredAt.toISOString() : null,
    receivedAt: order.receivedAt ? order.receivedAt.toISOString() : null,
    completedAt: order.completedAt ? order.completedAt.toISOString() : null,
    trackingNumber: order.trackingNumber ?? shipment?.awbNumber ?? null,
    storeName: order.store.name,
    storeId: order.store.id,
    storeSlug: order.store.slug,
    items: order.items.map((i): MeOrderDetailItem => ({
      id: i.id,
      title: i.title,
      variantLabel: i.variantLabel,
      qty: i.qty,
      unitPriceMinor: i.unitPriceMinor,
      lineTotalMinor: i.lineSubtotalMinor,
      productId: i.productId,
      variantId: i.variantId,
      imageUrl: i.product?.images[0]?.url ?? placeholderUrl(i.product?.slug ?? i.title, { w: 200, h: 200, label: i.title }),
    })),
    history: order.history.map((h): MeOrderHistoryEntry => ({
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      actor: h.actor,
      note: h.note,
      createdAt: h.createdAt.toISOString(),
    })),
    shipment: shipmentDetail,
    shipmentStatus: shipment?.status ?? null,
    shippingCourierName: shipment?.courierName ?? null,
    dispute: disputeDetail,
  };
  return ok(payload);
});
