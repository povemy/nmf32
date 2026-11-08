// ============================================================================
// POST /api/shipping/webhook/[provider] — tracking webhook receiver (F-05).
// ----------------------------------------------------------------------------
// Payload contract (unchanged from the original receiver):
//   { event: "shipment.updated", awb, orderNumber?, status, description?, location?, occurredAt?, ts }
//
// F-05 REMEDIATION — authentication + replay protection (mirrors the payments
// webhook pattern in /api/webhooks/payments/process.ts):
//   • x-shipping-signature (header, or body.sig fallback) =
//       HMAC-SHA256(SHIPPING_WEBHOOK_SECRET, `${awb}.${status}.${ts}`) hex
//     compared timing-safe (length-guarded) — invalid ⇒ 400 BAD_SIGNATURE.
//   • ±10-minute replay window on `ts` — a correctly-signed but stale
//     delivery ⇒ 400 STALE_EVENT.
//   • Production + SHIPPING_WEBHOOK_SECRET unset ⇒ 503 SHIPPING_SECRET_UNSET
//     (FAIL CLOSED: unsigned external state transitions are never accepted;
//     no provider-native scheme is invented — this is the documented
//     platform-side shared-secret scheme the EasyParcel integration will use).
//   • Sandbox/dev falls back to a documented public demo secret so the mock
//     tracking rails keep working without env setup.
//   • 60 req/min/IP flood control before any body parsing (same as payments).
//
// Also rewritten against the CURRENT schema (the previous version predated the
// Shipment model and did not compile): shipments are looked up on
// Shipment(providerId, awbNumber); events are ShipmentEvent(shipmentId); only
// platform-booked shipments participate (legacy manual tracking has no
// platform shipment row — sellers close those via /deliver, unchanged).
// ============================================================================
import { db } from "@/lib/db";
import { handle, ok, ApiError, transitionOrder, logActivity } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { hmacSha256Hex, safeEqualHex } from "@/lib/password";
import { deliverySideEffects } from "@/lib/shipping";
import type { ShippingWebhookBody, ShippingWebhookData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

/** Replay-acceptance window (same as the payments webhook). */
const WEBHOOK_TS_WINDOW_MS = 10 * 60_000;

/** Valid courier statuses (Shipment.status vocabulary). */
const SHIPMENT_STATUSES = ["BOOKED", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "EXCEPTION", "RETURNED"] as const;
const TERMINAL_STATUSES = ["DELIVERED", "EXCEPTION", "RETURNED"] as const;

/** F-05 fail-closed secret resolution (see file header). */
function shippingWebhookSecret(): string {
  const secret = process.env.SHIPPING_WEBHOOK_SECRET;
  if (secret && secret.length > 0) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new ApiError(
      503,
      "SHIPPING_SECRET_UNSET",
      "SHIPPING_WEBHOOK_SECRET is not configured — tracking webhook processing is disabled (fail closed)"
    );
  }
  return "sm_shipping_webhook_demo";
}

export const POST = handle(async (req: Request, ctx: { params: Promise<{ provider: string }> }) => {
  rateLimit(req, "shipping-webhook", 60); // flood control before body parsing

  const { provider } = await ctx.params;
  const providerId = provider.trim().toLowerCase();
  const body = (await req.json().catch(() => ({}))) as ShippingWebhookBody;

  const awb = String(body.awb ?? body.trackingNumber ?? "").trim();
  const status = String(body.status ?? "").trim().toUpperCase();
  const ts = Math.round(Number(body.ts ?? 0));
  if (!awb || !status) throw new ApiError(400, "VALIDATION", "awb and status are required");
  if (!SHIPMENT_STATUSES.includes(status as (typeof SHIPMENT_STATUSES)[number])) {
    throw new ApiError(400, "VALIDATION", `status must be one of: ${SHIPMENT_STATUSES.join("|")}`);
  }

  // --- signature + replay gate (BEFORE any DB access) ---
  const providedSig = req.headers.get("x-shipping-signature") ?? (body.sig ? String(body.sig) : null);
  if (!providedSig || !Number.isFinite(ts) || ts <= 0) {
    throw new ApiError(400, "BAD_SIGNATURE", "Webhook signature verification failed");
  }
  const expected = hmacSha256Hex(shippingWebhookSecret(), `${awb}.${status}.${ts}`);
  const sigMatches = safeEqualHex(providedSig, expected);
  const fresh = Math.abs(Date.now() - ts) <= WEBHOOK_TS_WINDOW_MS;
  if (!sigMatches) throw new ApiError(400, "BAD_SIGNATURE", "Webhook signature verification failed");
  if (!fresh) {
    throw new ApiError(400, "STALE_EVENT", `Webhook timestamp is outside the ±${WEBHOOK_TS_WINDOW_MS / 60_000}-minute acceptance window (replay protection)`);
  }

  // --- shipment lookup (platform-booked only) ---
  const shipment = await db.shipment.findFirst({
    where: { awbNumber: awb, providerId: providerId },
    include: {
      order: { select: { id: true, orderNumber: true, status: true, customerEmail: true, shopperId: true, storeId: true, store: { select: { slug: true } } } },
    },
  });
  if (!shipment) throw new ApiError(404, "NOT_FOUND", `No platform shipment with AWB '${awb}' on provider '${providerId}'`);

  // --- idempotent terminal guard ---
  if (TERMINAL_STATUSES.includes(shipment.status as (typeof TERMINAL_STATUSES)[number])) {
    const ignoredPayload: ShippingWebhookData = { orderNumber: shipment.order.orderNumber, shipmentStatus: shipment.status, ignored: true };
    return ok(ignoredPayload);
  }

  const description = String(body.description ?? status).slice(0, 300);
  const location = body.location != null ? String(body.location).slice(0, 120) : null;
  const occurredAt = body.occurredAt ? new Date(String(body.occurredAt)) : new Date();
  if (Number.isNaN(occurredAt.getTime())) throw new ApiError(400, "VALIDATION", "occurredAt is not a valid date");

  await db.shipmentEvent.create({
    data: { shipmentId: shipment.id, status, description, location, occurredAt },
  });

  const updated = await db.shipment.update({
    where: { id: shipment.id },
    data: {
      status,
      lastSyncedAt: occurredAt,
      ...(status === "DELIVERED" ? { deliveredAt: occurredAt } : {}),
    },
  });

  if (status === "DELIVERED" && ["shipped", "processing"].includes(shipment.order.status)) {
    await transitionOrder({
      orderId: shipment.order.id,
      toStatus: "delivered",
      actor: "system",
      note: `Courier confirmed delivery (AWB ${awb})`,
      timestamps: { deliveredAt: occurredAt },
    });
    await deliverySideEffects({
      order: shipment.order,
      storeSlug: shipment.order.store?.slug ?? null,
      courierName: shipment.courierName,
      awbNumber: awb,
      note: `Delivered by ${shipment.courierName ?? "courier"}`,
      deliveredAt: occurredAt,
    });
  }

  await logActivity({
    actorType: "system",
    actorId: `shipping:${providerId}`,
    actorLabel: providerId,
    action: "shipment.updated",
    entityType: "order",
    entityId: shipment.order.id,
    meta: { orderNumber: shipment.order.orderNumber, awb, status },
  });

  const payload: ShippingWebhookData = { orderNumber: shipment.order.orderNumber, shipmentStatus: updated.status };
  return ok(payload);
});
