import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { quoteRatesFor, eddWindow } from "@/lib/shipping";

export const dynamic = "force-dynamic";

// POST /api/store/orders/[id]/shipping/quote
// Live courier rates for THIS order's parcel (destination + weight derived from
// the order itself so the seller can't misquote). Returns options with price
// + EDD window for the Ship modal. Rate ids are then passed to the ship
// endpoint to book (platform-billed aggregator account — Model A).
export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { store } = await requireActiveSellerStore();
  const { id } = await ctx.params;

  const order = await db.order.findFirst({
    where: { OR: [{ id }, { orderNumber: id }], storeId: store.id },
    select: {
      orderNumber: true, shippingAddressJson: true, status: true,
      shipmentStatus: true,
      items: { select: { qty: true, product: { select: { weightGrams: true } } } },
    },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
  if (!["paid", "processing"].includes(order.status)) {
    throw new ApiError(409, "INVALID_STATUS", `Cannot quote shipping for order in status '${order.status}'`);
  }

  let destState: string | null = null;
  let destPostcode: string | null = null;
  try {
    const addr = JSON.parse(order.shippingAddressJson || "{}") as Record<string, unknown>;
    destState = typeof addr.state === "string" ? addr.state : null;
    destPostcode = typeof addr.postcode === "string" ? addr.postcode : null;
  } catch {
    /* unparseable address — quote with null state (peninsular default) */
  }

  const weightGrams = order.items.reduce((s, it) => s + it.qty * (it.product?.weightGrams ?? 500), 0);
  const quotes = quoteRatesFor(weightGrams, destState);

  return ok({
    orderNumber: order.orderNumber,
    weightGrams,
    destState,
    destPostcode,
    alreadyBooked: !!order.shipmentStatus,
    rates: quotes.map((q) => ({
      rateId: q.rateId,
      carrierCode: q.carrierCode,
      carrierName: q.carrierName,
      service: q.service,
      serviceName: q.serviceName,
      priceMinor: q.priceMinor,
      etaDaysMin: q.etaDaysMin,
      etaDaysMax: q.etaDaysMax,
      eddFrom: eddWindow(q.etaDaysMin, q.etaDaysMax).fromISO,
      eddTo: eddWindow(q.etaDaysMin, q.etaDaysMax).toISO,
      zone: q.zone,
    })),
  });
});
