// ============================================================================
// Shared payment-webhook verification + processing.
// Used by POST /api/webhooks/payments/[provider] AND POST /api/checkout/payments/[ref]/simulate
// (sandbox mock). HMAC secret NEVER leaves the server.
//
// PAYMENT MODEL — OPTION B (approved): one PSP charge per checkout. A licensed
// payment service provider (sandbox: the "mock" provider via /simulate — see
// src/lib/psp.ts) collects a SINGLE buyer payment for a PaymentGroup covering
// N per-seller orders, deducts the platform's application fee (commission)
// at payment time and settles each seller their share. NOMOFEE NEVER TAKES
// CUSTODY OF BUYER FUNDS — the ledger T1 postings below are the platform's
// ACCOUNTING MIRROR of the PSP's per-seller balances (bookkeeping that feeds
// seller dashboards + the payout pipeline), not escrow.
// (Historical note: first built as "Option A" collect-then-disburse; the data
// model is identical under Option B — only custody semantics changed.)
// ============================================================================
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { hmacSha256Hex } from "@/lib/password";
import { transitionOrder, dispatchStoreWebhooks, notify, logActivity } from "@/lib/api";
import { getCommissionSettings } from "@/lib/commission";
import { postOrderPaid } from "@/lib/ledger";
import { toJson } from "@/lib/json";
import { notifyShopperOrderConfirmed } from "@/lib/notify-shopper";

export const WEBHOOK_SECRET = "sm_webhook_secret_demo";

export function expectedSignature(providerRef: string, eventType: string, amountMinor: number, ts: number): string {
  return hmacSha256Hex(WEBHOOK_SECRET, `${providerRef}.${eventType}.${amountMinor}.${ts}`);
}

export type ProcessResult = {
  ok: true;
  duplicate: boolean;
  eventType: string;
  orderNumber: string;
  orderStatus: string;
  intentStatus: string;
  orderNumbers?: string[]; // OPTION A: every order paid under this group ref
  isGroup?: boolean;
};

/**
 * Verify signature (caller may pre-compute it, as simulate does), log the raw
 * webhook, then process idempotently. Throws ApiError with proper status codes.
 */
export async function processPaymentWebhook(input: {
  provider: string;
  body: { providerRef?: string; eventType?: string; amountMinor?: number; ts?: number; sig?: string };
  rawBody: string;
  headerSignature?: string | null;
}): Promise<ProcessResult> {
  const providerRef = String(input.body.providerRef ?? "");
  const eventType = String(input.body.eventType ?? "");
  const amountMinor = Math.round(Number(input.body.amountMinor ?? 0));
  const ts = Math.round(Number(input.body.ts ?? 0));
  if (!providerRef || !eventType) {
    throw new ApiError(400, "BAD_REQUEST", "providerRef and eventType are required");
  }

  const providedSig = input.headerSignature ?? (input.body.sig ? String(input.body.sig) : null);
  const expected = expectedSignature(providerRef, eventType, amountMinor, ts);
  const signatureValid = !!providedSig && providedSig === expected;

  // OPTION A first: the ref may be a multi-seller payment group.
  const group = await db.paymentGroup.findUnique({
    where: { ref: providerRef },
    include: {
      orders: {
        orderBy: { createdAt: "asc" },
        include: { items: true, store: { include: { seller: { include: { wallet: true } } } } },
      },
    },
  });

  const intent = group ? null : await db.paymentIntent.findUnique({ where: { providerRef } });

  // ALWAYS log the webhook first (even for invalid signature / unknown ref).
  const log = await db.paymentWebhookLog.create({
    data: {
      provider: input.provider,
      providerRef,
      eventType,
      payloadJson: input.rawBody,
      signatureValid,
      processed: false,
      orderId: group?.orders[0]?.id ?? intent?.orderId ?? null,
    },
  });

  if (!signatureValid) {
    throw new ApiError(400, "BAD_SIGNATURE", "Webhook signature verification failed");
  }

  // ------------------------------------------------------------------ OPTION A group path
  if (group) {
    // Idempotency: already succeeded → no-op.
    if (group.status === "succeeded") {
      await db.paymentWebhookLog.update({ where: { id: log.id }, data: { processed: true } });
      return {
        ok: true,
        duplicate: true,
        eventType,
        orderNumber: group.orders[0]?.orderNumber ?? "",
        orderNumbers: group.orders.map((o) => o.orderNumber),
        orderStatus: "paid",
        intentStatus: "succeeded",
        isGroup: true,
      };
    }

    if (eventType === "payment.failed") {
      await db.paymentGroup.update({ where: { id: group.id }, data: { status: "failed" } });
      await db.paymentWebhookLog.update({ where: { id: log.id }, data: { processed: true } });
      return {
        ok: true,
        duplicate: false,
        eventType,
        orderNumber: group.orders[0]?.orderNumber ?? "",
        orderNumbers: group.orders.map((o) => o.orderNumber),
        orderStatus: group.orders[0]?.status ?? "payment_pending",
        intentStatus: "failed",
        isGroup: true,
      };
    }

    if (eventType !== "payment.succeeded") {
      throw new ApiError(400, "UNKNOWN_EVENT", `Unsupported eventType: ${eventType}`);
    }

    if (amountMinor !== group.totalMinor) {
      throw new ApiError(409, "AMOUNT_MISMATCH", `Webhook amount ${amountMinor} does not match payment group ${group.totalMinor}`);
    }

    const paidAt = new Date();
    await db.paymentGroup.update({ where: { id: group.id }, data: { status: "succeeded", paidAt } });

    const settings = await getCommissionSettings();
    for (const order of group.orders) {
      await transitionOrder({
        orderId: order.id,
        toStatus: "paid",
        actor: "system",
        note: `Payment ${providerRef} succeeded via ${group.provider} (group payment)`,
        timestamps: { paidAt },
      });

      // Ledger T1 — seller wallet credited with net, hold until = paidAt + holdDays.
      const seller = order.store.seller;
      const wallet = seller?.wallet;
      if (seller && wallet) {
        const holdDays = seller.holdDaysOverride ?? settings.payoutHoldDays;
        const holdUntil = new Date(paidAt.getTime() + holdDays * 86400000);
        const commissionMinor = order.items.reduce((s, i) => s + i.commissionMinor, 0);
        const sellerNetMinor = order.items.reduce((s, i) => s + i.sellerNetMinor, 0);
        await postOrderPaid({
          orderId: order.id,
          orderNumber: order.orderNumber,
          walletId: wallet.id,
          provider: group.provider,
          totalMinor: order.totalMinor,
          sellerNetMinor,
          commissionMinor,
          holdUntil,
          currency: order.currency,
          occurredAt: paidAt,
        });
      }

      await dispatchStoreWebhooks({
        storeId: order.storeId,
        event: "order.paid",
        payload: { orderNumber: order.orderNumber, totalMinor: order.totalMinor, currency: order.currency, paymentGroupRef: providerRef },
      });
      if (seller) {
        await notify({ event: "order.paid", channel: "email", recipient: seller.email, subject: `You have a new paid order ${order.orderNumber}` });
        await notify({ event: "order.paid", channel: "inapp", recipient: seller.email, subject: "You have a new paid order" });
      }
      await notify({ event: "order.receipt", channel: "email", recipient: order.customerEmail, subject: `Your order ${order.orderNumber} is confirmed` });
      // Shopper in-app nudge (Task 10-d) — payment confirmed → "Order confirmed".
      await notifyShopperOrderConfirmed({ orderNumber: order.orderNumber, shopperId: order.shopperId, storeId: order.storeId, store: order.store });
      await logActivity({ actorType: "system", action: "payment.succeeded", entityType: "order", entityId: order.id, meta: { providerRef, provider: group.provider, totalMinor: order.totalMinor, paymentGroup: true } });
    }

    // Server-side cart clearing — only the PURCHASED variants leave the cart,
    // and only on verified payment success (never on failure/pending). Lines
    // the buyer unchecked (kept for later) survive: selection-aware carts.
    // PaymentGroups are account-scoped (shopperId always set).
    const purchasedVariantIds = [
      ...new Set(group.orders.flatMap((o) => o.items.map((it) => it.variantId)).filter((v): v is string => Boolean(v))),
    ];
    await db.cartItem.deleteMany({
      where: { cart: { shopperId: group.shopperId }, variantId: { in: purchasedVariantIds } },
    });

    await db.paymentWebhookLog.update({ where: { id: log.id }, data: { processed: true } });

    return {
      ok: true,
      duplicate: false,
      eventType,
      orderNumber: group.orders[0]?.orderNumber ?? "",
      orderNumbers: group.orders.map((o) => o.orderNumber),
      orderStatus: "paid",
      intentStatus: "succeeded",
      isGroup: true,
    };
  }

  // ------------------------------------------------------------------ legacy single-order path
  if (!intent) {
    throw new ApiError(404, "INTENT_NOT_FOUND", "Payment intent not found");
  }

  // Idempotency: already succeeded → no-op.
  if (intent.status === "succeeded") {
    await db.paymentWebhookLog.update({ where: { id: log.id }, data: { processed: true } });
    const order = await db.order.findUnique({ where: { id: intent.orderId } });
    return {
      ok: true,
      duplicate: true,
      eventType,
      orderNumber: order?.orderNumber ?? "",
      orderStatus: order?.status ?? "",
      intentStatus: intent.status,
    };
  }

  if (eventType === "payment.failed") {
    await db.paymentIntent.update({ where: { id: intent.id }, data: { status: "failed" } });
    const order = await db.order.findUnique({ where: { id: intent.orderId } });
    await db.paymentWebhookLog.update({ where: { id: log.id }, data: { processed: true } });
    return {
      ok: true,
      duplicate: false,
      eventType,
      orderNumber: order?.orderNumber ?? "",
      orderStatus: order?.status ?? "",
      intentStatus: "failed",
    };
  }

  if (eventType !== "payment.succeeded") {
    throw new ApiError(400, "UNKNOWN_EVENT", `Unsupported eventType: ${eventType}`);
  }

  if (amountMinor !== intent.amountMinor) {
    throw new ApiError(409, "AMOUNT_MISMATCH", `Webhook amount ${amountMinor} does not match intent ${intent.amountMinor}`);
  }

  const paidAt = new Date();
  await db.paymentIntent.update({ where: { id: intent.id }, data: { status: "succeeded" } });
  const order = await db.order.findUnique({
    where: { id: intent.orderId },
    include: { items: true, store: { include: { seller: { include: { wallet: true } } } } },
  });
  if (!order) throw new ApiError(404, "ORDER_NOT_FOUND", "Order for payment intent not found");

  await transitionOrder({ orderId: order.id, toStatus: "paid", actor: "system", note: `Payment ${providerRef} succeeded via ${intent.provider}`, timestamps: { paidAt } });

  // Server-side cart clearing — only the PURCHASED variants leave the cart,
  // and only on verified payment success (never on failure/pending, never
  // client-driven). Account carts clear by shopperId; the token is a legacy/
  // reconciliation fallback for rows that predate account-scoped carts.
  // Selection-aware: unchecked (kept-for-later) lines are never removed here.
  const purchasedVariantIds = [...new Set(order.items.map((it) => it.variantId).filter((v): v is string => Boolean(v)))];
  if (order.shopperId) {
    await db.cartItem.deleteMany({
      where: { cart: { shopperId: order.shopperId }, variantId: { in: purchasedVariantIds } },
    });
  } else if (order.cartToken) {
    await db.cartItem.deleteMany({
      where: { cart: { token: order.cartToken }, variantId: { in: purchasedVariantIds } },
    });
  }

  // Ledger T1 — seller wallet credited with net, hold until = paidAt + holdDays.
  const seller = order.store.seller;
  const wallet = seller?.wallet;
  if (seller && wallet) {
    const settings = await getCommissionSettings();
    const holdDays = seller.holdDaysOverride ?? settings.payoutHoldDays;
    const holdUntil = new Date(paidAt.getTime() + holdDays * 86400000);
    const commissionMinor = order.items.reduce((s, i) => s + i.commissionMinor, 0);
    const sellerNetMinor = order.items.reduce((s, i) => s + i.sellerNetMinor, 0);
    await postOrderPaid({
      orderId: order.id,
      orderNumber: order.orderNumber,
      walletId: wallet.id,
      provider: intent.provider,
      totalMinor: intent.amountMinor,
      sellerNetMinor,
      commissionMinor,
      holdUntil,
      currency: order.currency,
      occurredAt: paidAt,
    });
  }

  // Store webhooks + notifications.
  await dispatchStoreWebhooks({
    storeId: order.storeId,
    event: "order.paid",
    payload: { orderNumber: order.orderNumber, totalMinor: order.totalMinor, currency: order.currency },
  });
  if (seller) {
    await notify({ event: "order.paid", channel: "email", recipient: seller.email, subject: `You have a new paid order ${order.orderNumber}` });
    await notify({ event: "order.paid", channel: "inapp", recipient: seller.email, subject: "You have a new paid order" });
  }
  await notify({ event: "order.receipt", channel: "email", recipient: order.customerEmail, subject: `Your order ${order.orderNumber} is confirmed` });
  // Shopper in-app nudge (Task 10-d) — payment confirmed → "Order confirmed".
  await notifyShopperOrderConfirmed({ orderNumber: order.orderNumber, shopperId: order.shopperId, storeId: order.storeId, store: order.store });
  await logActivity({ actorType: "system", action: "payment.succeeded", entityType: "order", entityId: order.id, meta: { providerRef, provider: intent.provider, totalMinor: intent.amountMinor } });

  await db.paymentWebhookLog.update({ where: { id: log.id }, data: { processed: true } });

  return {
    ok: true,
    duplicate: false,
    eventType,
    orderNumber: order.orderNumber,
    orderStatus: "paid",
    intentStatus: "succeeded",
  };
}

export function webhookPayloadJson(body: unknown): string {
  return toJson(body);
}
