import { db } from "@/lib/db";
import { handle, ok, ApiError, transitionOrder, logActivity } from "@/lib/api";
import { getShippingProvider } from "@/lib/shipping";

export const dynamic = "force-dynamic";

// POST /api/shipping/webhook/[provider] — tracking webhook receiver.
// In sandbox the mock provider "calls" this shape (and syncShipment covers the
// time-based simulation); in production the EasyParcel tracking webhook lands
// here with signature verification (same pattern as
// /api/webhooks/payments/[provider]). Payload contract:
//   { event: "shipment.updated", awb, orderNumber?, status, description?, location?, occurredAt? }
export const POST = handle(async (req: Request, ctx: { params: Promise<{ provider: string }> }) => {
  const { provider } = await ctx.params;
  const providerObj = getShippingProvider(provider);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const awb = String(body.awb ?? body.trackingNumber ?? "").trim();
  const status = String(body.status ?? "").trim().toUpperCase();
  if (!awb || !status) throw new ApiError(400, "VALIDATION", "awb and status are required");

  const order = await db.order.findFirst({ where: { trackingNumber: awb, trackingProvider: providerObj.id } });
  if (!order) throw new ApiError(404, "NOT_FOUND", `No shipment with AWB '${awb}' on provider '${providerObj.id}'`);
  if (!order.shipmentStatus) throw new ApiError(409, "INVALID_STATUS", "Shipment not booked through the platform");

  const terminal = ["DELIVERED", "EXCEPTION", "RETURNED"];
  if (terminal.includes(order.shipmentStatus)) {
    return ok({ orderNumber: order.orderNumber, shipmentStatus: order.shipmentStatus, ignored: true });
  }

  const description = String(body.description ?? status).slice(0, 300);
  const location = body.location != null ? String(body.location).slice(0, 120) : null;
  const occurredAt = body.occurredAt ? new Date(String(body.occurredAt)) : new Date();
  if (Number.isNaN(occurredAt.getTime())) throw new ApiError(400, "VALIDATION", "occurredAt is not a valid date");

  await db.shipmentEvent.create({
    data: { orderId: order.id, status, description, location, occurredAt },
  });

  await db.order.update({
    where: { id: order.id },
    data: {
      shipmentStatus: status,
      ...(status === "DELIVERED" ? { deliveredAt: occurredAt } : {}),
    },
  });

  if (status === "DELIVERED" && order.status === "shipped") {
    await transitionOrder({
      orderId: order.id,
      toStatus: "delivered",
      actor: "system",
      note: `Courier confirmed delivery (AWB ${awb})`,
      timestamps: { deliveredAt: occurredAt },
    });
  }

  await logActivity({
    actorType: "system",
    actorId: `shipping:${providerObj.id}`,
    actorLabel: providerObj.label,
    action: "shipment.updated",
    entityType: "order",
    entityId: order.id,
    meta: { orderNumber: order.orderNumber, awb, status },
  });

  return ok({ orderNumber: order.orderNumber, shipmentStatus: status });
});
