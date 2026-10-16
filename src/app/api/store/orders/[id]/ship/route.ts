import { db } from "@/lib/db";
import { handle, ok, ApiError, transitionOrder, dispatchStoreWebhooks, notify, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import {
  assertShippable,
  bookShipment,
  findQuote,
  parcelWeightForItems,
  pushBuyerNotificationForShipped,
} from "@/lib/shipping";
import { parseJson } from "@/lib/json";

export const dynamic = "force-dynamic";

// POST /api/store/orders/[id]/ship
//   {mode:"platform", rateId}            → book via the platform mock courier
//   {mode:"manual", provider, trackingNumber}
//   {provider, trackingNumber}           → legacy manual body (still works)
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { me, store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const mode = body.mode == null ? null : String(body.mode).trim();

  const order = await db.order.findFirst({
    where: { OR: [{ id }, { orderNumber: id }], storeId: store.id },
    include: { items: { select: { qty: true } } },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
  assertShippable(order);

  const destState = parseJson<{ state?: string }>(order.shippingAddressJson, {}).state ?? "";

  if (mode === "platform") {
    const rateId = String(body.rateId ?? "").trim();
    const providerId = body.providerId == null ? "mock" : String(body.providerId).trim();
    if (!rateId) throw new ApiError(400, "VALIDATION", "rateId is required for platform shipping");
    if (providerId !== "mock") throw new ApiError(400, "VALIDATION", "Unknown shipping provider — only 'mock' is available");

    // Re-derive the rates deterministically (same engine the quote endpoint
    // used) so the chosen rateId is validated against fresh, identical quotes.
    const quote = findQuote(
      rateId,
      { weightGrams: parcelWeightForItems(order.items), itemCount: order.items.length },
      { state: destState }
    );
    if (!quote) {
      throw new ApiError(404, "RATE_NOT_FOUND", "That courier rate is no longer available — fetch a fresh quote");
    }

    const shipment = await bookShipment(
      {
        id: order.id,
        orderNumber: order.orderNumber,
        storeId: store.id,
        storeName: store.name,
        customerName: order.customerName,
        shippingAddressJson: order.shippingAddressJson,
        items: order.items,
      },
      quote
    );

    await transitionOrder({
      orderId: order.id,
      toStatus: "shipped",
      actor: "seller",
      note: `Booked ${quote.courierName} (platform) · AWB ${shipment.awbNumber}`,
      timestamps: { shippedAt: new Date() },
    });
    const fresh = await db.order.update({
      where: { id: order.id },
      data: { trackingProvider: "mock", trackingNumber: shipment.awbNumber },
    });

    await dispatchStoreWebhooks({
      storeId: store.id,
      event: "order.shipped",
      payload: { orderNumber: order.orderNumber, tracking: shipment.awbNumber, provider: "mock", courier: quote.courierName },
    });
    await notify({
      event: "order.shipped",
      channel: "email",
      recipient: order.customerEmail,
      subject: `Your order ${order.orderNumber} has shipped`,
    });
    await pushBuyerNotificationForShipped({
      shopperId: order.shopperId,
      orderNumber: order.orderNumber,
      storeId: store.id,
      storeName: store.name,
      storeSlug: store.slug,
      courierName: quote.courierName,
      awbNumber: shipment.awbNumber,
    });
    await logActivity({
      actorType: "seller",
      actorId: me.id,
      actorLabel: me.email,
      action: "order.shipped",
      entityType: "order",
      entityId: order.id,
      meta: { orderNumber: order.orderNumber, mode: "platform", rateId, awb: shipment.awbNumber, courier: quote.courierName },
    });

    return ok({
      id: fresh.id,
      status: fresh.status,
      shippedAt: fresh.shippedAt,
      trackingNumber: shipment.awbNumber,
      trackingProvider: "mock",
      shipmentStatus: shipment.status,
      shipment: {
        awbNumber: shipment.awbNumber,
        courierName: shipment.courierName,
        etaFrom: shipment.etaFrom,
        etaTo: shipment.etaTo,
        labelUrl: shipment.labelUrl,
      },
    });
  }

  // Legacy manual mode — {provider, trackingNumber} (explicit or implicit).
  const provider = String(body.provider ?? "").trim();
  const trackingNumber = String(body.trackingNumber ?? "").trim();
  if (!provider || !trackingNumber) {
    throw new ApiError(400, "VALIDATION", "provider and trackingNumber are required (or use mode:'platform' with rateId)");
  }
  if (mode && mode !== "manual") {
    throw new ApiError(400, "VALIDATION", "mode must be 'platform' or 'manual'");
  }

  await transitionOrder({
    orderId: order.id,
    toStatus: "shipped",
    actor: "seller",
    note: `Shipped via ${provider}: ${trackingNumber}`,
    timestamps: { shippedAt: new Date() },
  });

  const fresh = await db.order.update({
    where: { id: order.id },
    data: { trackingProvider: provider, trackingNumber },
  });

  await dispatchStoreWebhooks({
    storeId: store.id,
    event: "order.shipped",
    payload: { orderNumber: order.orderNumber, tracking: trackingNumber, provider },
  });

  await notify({
    event: "order.shipped",
    channel: "email",
    recipient: order.customerEmail,
    subject: `Your order ${order.orderNumber} has shipped`,
  });

  await pushBuyerNotificationForShipped({
    shopperId: order.shopperId,
    orderNumber: order.orderNumber,
    storeId: store.id,
    storeName: store.name,
    storeSlug: store.slug,
    courierName: provider,
    awbNumber: trackingNumber,
  });

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "order.shipped",
    entityType: "order",
    entityId: order.id,
    meta: { orderNumber: order.orderNumber, provider, trackingNumber },
  });

  return ok({
    id: fresh.id,
    status: fresh.status,
    shippedAt: fresh.shippedAt,
    trackingNumber,
    trackingProvider: provider,
    shipmentStatus: null,
    shipment: null,
  });
});
