import { db } from "@/lib/db";
import { handle, ok, ApiError, transitionOrder, dispatchStoreWebhooks, notify, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { fastForwardDelivery, mockPodUrl, validateProofDataUrl } from "@/lib/shipping";
import { approveAffiliateCommissionsForOrder } from "@/lib/affiliate";
import type { DeliverBody, DeliverData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/store/orders/[id]/deliver — seller marks the parcel delivered.
// Allowed from "shipped" only (anything else → 409 INVALID_STATUS; another
// store's order → 404). Body: {proof?: dataURL image ≤1.2MB, note?}.
// With a platform shipment we backfill the skipped courier milestones via
// fastForwardDelivery (proof rides the DELIVERED event); with a manual
// shipment we still close the shipment + write its DELIVERED event.
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { me, store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as DeliverBody;
  const proof = validateProofDataUrl(body.proof ?? null);
  const note = body.note != null ? String(body.note).trim().slice(0, 500) : "";

  const order = await db.order.findFirst({
    where: { OR: [{ id }, { orderNumber: id }], storeId: store.id },
    select: {
      id: true, orderNumber: true, status: true, customerEmail: true, shopperId: true,
    },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
  if (order.status !== "shipped") {
    throw new ApiError(409, "INVALID_STATUS", `Cannot mark order ${order.orderNumber} delivered from status '${order.status}'`);
  }

  const now = new Date();
  const shipment = await db.shipment.findUnique({ where: { orderId: order.id } });
  // AFFILIATE — delivered is an authoritative completion state: pending
  // commission entries for this order become approved (best-effort; the
  // affiliate lifecycle cron sweep also covers this path).
  try { await approveAffiliateCommissionsForOrder(order.id); } catch { /* best-effort */ }
  let platformBooking = false;

  if (shipment && shipment.providerId === "mock") {
    // Platform booking — backfill skipped milestones so the timeline reads
    // BOOKED → PICKED_UP → IN_TRANSIT → OUT_FOR_DELIVERY → DELIVERED.
    // fastForwardDelivery also fires the delivered webhook/emails itself.
    platformBooking = true;
    await fastForwardDelivery(order.id, now, proof ?? mockPodUrl(shipment.awbNumber ?? order.orderNumber));
  } else {
    await transitionOrder({
      orderId: order.id,
      toStatus: "delivered",
      actor: "seller",
      note: note ? `Seller marked delivered — ${note}` : "Seller marked delivered",
      timestamps: { deliveredAt: now },
    });
    if (shipment) {
      await db.shipment.update({
        where: { id: shipment.id },
        data: { status: "DELIVERED", deliveredAt: now, lastSyncedAt: now },
      });
      await db.shipmentEvent.create({
        data: {
          shipmentId: shipment.id,
          status: "DELIVERED",
          description: note ? `Delivered by seller — ${note}` : "Delivered by seller",
          location: store.name,
          occurredAt: now,
          proofImageUrl: proof ?? null,
        },
      });
    }
  }

  const fresh = await db.order.findUnique({
    where: { id: order.id },
    select: { id: true, orderNumber: true, status: true, deliveredAt: true },
  });

  if (!platformBooking) {
    await dispatchStoreWebhooks({
      storeId: store.id,
      event: "order.delivered",
      payload: { orderNumber: order.orderNumber, deliveredAt: now.toISOString(), hasProof: !!proof },
    });
    await notify({
      event: "order.delivered",
      channel: "email",
      recipient: order.customerEmail,
      subject: `Your order ${order.orderNumber} was delivered`,
    });
    await logActivity({
      actorType: "seller",
      actorId: me.id,
      actorLabel: me.email,
      action: "order.delivered",
      entityType: "order",
      entityId: order.id,
      meta: { orderNumber: order.orderNumber, hasProof: !!proof, note: note || null },
    });
  }

  // deliveredAt: Date | null on the Prisma row vs contract string — always
  // non-null here because both delivery paths stamped it above.
  const payload: DeliverData = {
    id: fresh!.id,
    orderNumber: fresh!.orderNumber,
    status: fresh!.status,
    deliveredAt: fresh!.deliveredAt ? fresh!.deliveredAt.toISOString() : null,
    shipmentStatus: shipment ? "DELIVERED" : null,
  } as DeliverData;
  return ok(payload);
});
