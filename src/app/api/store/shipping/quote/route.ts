import { db } from "@/lib/db";
import { ApiError, handle, ok } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { parcelWeightForItems, quoteRates, zoneOf, cityForState } from "@/lib/shipping";
import { parseJson } from "@/lib/json";

export const dynamic = "force-dynamic";

// GET /api/store/shipping/quote?orderId= — courier rates for the seller ship
// dialog. Deterministic mock rate card (weight bands + peninsular/east zone);
// the ship route re-derives the same quotes to validate the chosen rateId.
export const GET = handle(async (req: Request) => {
  const { store } = await requireActiveSellerStore();
  const url = new URL(req.url);
  const orderId = url.searchParams.get("orderId")?.trim();
  if (!orderId) throw new ApiError(400, "VALIDATION", "orderId is required");

  const order = await db.order.findFirst({
    where: { OR: [{ id: orderId }, { orderNumber: orderId }], storeId: store.id },
    include: {
      items: { select: { qty: true, title: true } },
      shipment: {
        select: { id: true, status: true, awbNumber: true, courierName: true, etaFrom: true, etaTo: true },
      },
    },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");

  const address = parseJson<{ state?: string; city?: string }>(order.shippingAddressJson, {});
  const state = address.state ?? "";
  const parcel = {
    weightGrams: parcelWeightForItems(order.items),
    itemCount: order.items.reduce((s, i) => s + Math.max(0, Math.floor(i.qty)), 0),
  };
  const rates = quoteRates(parcel, { state });

  return ok({
    orderId: order.id,
    orderNumber: order.orderNumber,
    orderStatus: order.status,
    shippedAt: order.shippedAt,
    shipment: order.shipment
      ? {
          status: order.shipment.status,
          awbNumber: order.shipment.awbNumber,
          courierName: order.shipment.courierName,
          etaFrom: order.shipment.etaFrom,
          etaTo: order.shipment.etaTo,
        }
      : null,
    destination: {
      state,
      city: address.city ?? cityForState(state),
      zone: zoneOf(state),
    },
    parcel,
    rates,
  });
});
