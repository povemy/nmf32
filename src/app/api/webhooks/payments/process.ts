// ============================================================================
// Shared payment-webhook verification + processing.
// Used by POST /api/webhooks/payments/[provider] AND POST /api/checkout/payments/[ref]/simulate
// (sandbox mock) AND POST /api/webhooks/payments/payout-simulate (sandbox mock,
// payout lifecycle). HMAC secret NEVER leaves the server.
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
//
// FIN-2b HARDENING (this revision):
//   • secret from PSP_WEBHOOK_SECRET env (sandbox fallback documented below)
//   • timing-safe signature compare (safeEqual, lib/secretbox.ts)
//   • ±10 min timestamp acceptance window → 400 STALE_EVENT (replay guard)
//   • PSP_PROVIDERS[id].sandboxOnly enforced (403 in production)
//   • success paths are CLAIM-FIRST + Serializable: one conditional updateMany
//     serializes concurrent deliveries; only the winner moves money
//   • inbound payout.succeeded / payout.failed events drive the payout
//     lifecycle (T4/T4f) with the same claim pattern
//   • optional T2 auto-settle after success (setting psp.split.auto_settle)
//   • notifications carry stable dedupKeys (unique (channel, dedupKey))
//   • webhook rows are ALWAYS logged first (log-then-verify order preserved)
// ============================================================================
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { safeEqual } from "@/lib/secretbox";
import { hmacSha256Hex } from "@/lib/password";
import { transitionOrder, dispatchStoreWebhooks, notify, logActivity } from "@/lib/api";
import { getCommissionSettings } from "@/lib/commission";
import { postOrderPaid, postGatewaySettlement, postPayoutConfirmed, postPayoutFailed, AUTO_SETTLE_SETTING_KEY } from "@/lib/ledger";
import { assertTransition } from "@/lib/payout-state";
import { resolvePspProvider } from "@/lib/psp";
import { parseMaybeJson } from "@/app/api/admin/_helpers";
import { toJson } from "@/lib/json";
import { notifyShopperOrderConfirmed } from "@/lib/notify-shopper";

// Sandbox fallback keeps the mock rails working without env setup; production
// MUST set PSP_WEBHOOK_SECRET (a real PSP secret) — the fallback is intentionally
// public knowledge so it can never be trusted to authenticate real money events.
const WEBHOOK_SECRET = process.env.PSP_WEBHOOK_SECRET ?? "sm_webhook_secret_demo";

/** Replay-acceptance window: a correct MAC over an out-of-window timestamp is
 *  still a replay — rejected with STALE_EVENT. Simulate endpoints stamp
 *  Date.now() so sandbox flows always fall inside the window. */
export const WEBHOOK_TS_WINDOW_MS = 10 * 60_000;

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
  // FIN-2b inbound payout events:
  /** True when the delivery was a replay/conflict (claim lost or already
   *  applied) — answered ok so PSP retries converge; never a raw throw. */
  payoutConflict?: boolean;
  /** Payout status after processing (consumed by payout-simulate + probes). */
  payoutStatus?: string;
};

// ---------------------------------------------------------------------------
// Payout state machine: SHARED import from lib/payout-state.ts (FIN-2-a's
// single source of truth). Initially ran as a local copy under
// TODO(FIN-2-a merge) while that file was landing in parallel — swapped to the
// shared import the moment it was detected. Contract matches the checklist:
// assertTransition(from, to) throws ApiError 409 (code STATE_INVALID) on an
// illegal transition; map: requested→processing|rejected, processing→
// paid|failed, paid→returned|reversed (future, webhook-only), failed→processing.
// ---------------------------------------------------------------------------

/** FIN-1 1.6 wiring lives here: T2 auto-settle toggle. Default false = DORMANT
 *  (documented decision) — GATEWAY:* intentionally carries the unsettled PSP
 *  position until a real PSP contract exists. */
async function autoSettleEnabled(): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { key: AUTO_SETTLE_SETTING_KEY } });
  return parseMaybeJson<boolean>(row?.valueJson, false) === true;
}

/**
 * Verify signature (caller may pre-compute it, as simulate does), log the raw
 * webhook, then process idempotently. Throws ApiError with proper status codes.
 *
 * RACE SAFETY (why claim-first): the success paths' FIRST write inside the
 * Serializable transaction is a CONDITIONAL updateMany (status flip guarded by
 * the pre-status). Two concurrent deliveries of the same event race on that
 * row lock; the loser matches zero rows, writes nothing and returns the
 * duplicate result — money movement, order transitions and notifications can
 * only ever run for the winner. The ledger dedupKeys (FIN-1) backstop this at
 * the posting layer, and the notification dedupKeys backstop the mail log.
 */
export async function processPaymentWebhook(input: {
  provider: string;
  body: { providerRef?: string; eventType?: string; amountMinor?: number; ts?: number; sig?: string; reason?: string };
  rawBody: string;
  headerSignature?: string | null;
}): Promise<ProcessResult> {
  // (2b.2) Provider sandbox enforcement FIRST — fail closed. resolvePspProvider
  // falls back to the mock provider for unknown ids, so in production an
  // unregistered provider id can never sneak through: mock is sandboxOnly → 403.
  const psp = resolvePspProvider(input.provider);
  if (psp.sandboxOnly && process.env.NODE_ENV === "production") {
    throw new ApiError(403, "PROVIDER_SANDBOX_ONLY", `Provider "${input.provider}" is sandbox-only and cannot process webhooks in production`);
  }

  const providerRef = String(input.body.providerRef ?? "");
  const eventType = String(input.body.eventType ?? "");
  const amountMinor = Math.round(Number(input.body.amountMinor ?? 0));
  const ts = Math.round(Number(input.body.ts ?? 0));
  if (!providerRef || !eventType) {
    throw new ApiError(400, "BAD_REQUEST", "providerRef and eventType are required");
  }

  // (2b.1) Timing-safe compare + freshness. signatureValid in the log means
  // "authenticated as a LIVE event": correct MAC AND inside the replay window —
  // a stale-but-correctly-signed delivery is recorded as signatureValid=false
  // (replay protection is part of webhook authentication semantics) and
  // rejected with STALE_EVENT below, AFTER the row is logged.
  const providedSig = input.headerSignature ?? (input.body.sig ? String(input.body.sig) : null);
  const expected = expectedSignature(providerRef, eventType, amountMinor, ts);
  const sigMatches = !!providedSig && safeEqual(providedSig, expected);
  const fresh = Math.abs(Date.now() - ts) <= WEBHOOK_TS_WINDOW_MS;
  const signatureValid = sigMatches && fresh;

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

  // ALWAYS log the webhook first (even for invalid signature / unknown ref) —
  // invalid/stale rows stay in the log with their signatureValid flag.
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

  if (!sigMatches) {
    throw new ApiError(400, "BAD_SIGNATURE", "Webhook signature verification failed");
  }
  if (!fresh) {
    throw new ApiError(400, "STALE_EVENT", `Webhook timestamp is outside the ±${WEBHOOK_TS_WINDOW_MS / 60_000}-minute acceptance window (replay protection)`);
  }

  // ------------------------------------------------------------------ FIN-2b: inbound payout events
  if (eventType === "payout.succeeded" || eventType === "payout.failed") {
    return processPayoutEvent({ provider: input.provider, providerRef, eventType, amountMinor, reason: input.body.reason ?? null, logId: log.id });
  }

  // ------------------------------------------------------------------ OPTION A group path
  if (group) {
    if (eventType === "payment.failed") {
      // No money moves on failure — a single conditional update is fine outside
      // a Serializable tx (an already-succeeded group ignores the failed event).
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

    // Unknown-event + amount checks BEFORE the claim (unchanged order) — a
    // malformed delivery must never even attempt the status flip.
    if (eventType !== "payment.succeeded") {
      throw new ApiError(400, "UNKNOWN_EVENT", `Unsupported eventType: ${eventType}`);
    }

    if (amountMinor !== group.totalMinor) {
      throw new ApiError(409, "AMOUNT_MISMATCH", `Webhook amount ${amountMinor} does not match payment group ${group.totalMinor}`);
    }

    const settings = await getCommissionSettings();
    const paidAt = new Date();

    // SUCCESS PATH — one Serializable transaction around claim + money.
    // The conditional claim is the FIRST write: count 0 ⇒ another delivery
    // already succeeded ⇒ nothing this tx wrote (the claim was the only
    // intended write) ⇒ return the duplicate sentinel; committing an empty tx
    // is equivalent to rollback-by-return.
    const outcome = await db.$transaction(
      async (tx) => {
        const claim = await tx.paymentGroup.updateMany({
          where: { id: group.id, status: { not: "succeeded" } },
          data: { status: "succeeded", paidAt },
        });
        if (claim.count === 0) return { claimed: false as const };

        for (const order of group.orders) {
          await transitionOrder({
            orderId: order.id,
            toStatus: "paid",
            actor: "system",
            note: `Payment ${providerRef} succeeded via ${group.provider} (group payment)`,
            timestamps: { paidAt },
            tx,
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
              tx,
            });
          }

          // Store webhooks + notifications run inside the success tx (log-only
          // writes on their own connections). notify carries dedupKeys so even
          // an aborted tx + provider retry cannot multiply seller/customer mail.
          await dispatchStoreWebhooks({
            storeId: order.storeId,
            event: "order.paid",
            payload: { orderNumber: order.orderNumber, totalMinor: order.totalMinor, currency: order.currency, paymentGroupRef: providerRef },
          });
          if (seller) {
            await notify({ event: "order.paid", channel: "email", recipient: seller.email, subject: `You have a new paid order ${order.orderNumber}`, dedupKey: `order.paid.email:${order.id}` });
            await notify({ event: "order.paid", channel: "inapp", recipient: seller.email, subject: "You have a new paid order", dedupKey: `order.paid.inapp:${order.id}` });
          }
          await notify({ event: "order.receipt", channel: "email", recipient: order.customerEmail, subject: `Your order ${order.orderNumber} is confirmed`, dedupKey: `order.receipt.email:${order.id}` });
          // Shopper in-app nudge (Task 10-d) — payment confirmed → "Order confirmed".
          // Left as-is: its own promo-cap rules make it idempotent-ish, and the
          // claim above means it only runs for the winning delivery anyway.
          await notifyShopperOrderConfirmed({ orderNumber: order.orderNumber, shopperId: order.shopperId, storeId: order.storeId, store: order.store });
          await logActivity({ actorType: "system", action: "payment.succeeded", entityType: "order", entityId: order.id, meta: { providerRef, provider: group.provider, totalMinor: order.totalMinor, paymentGroup: true } });
        }

        // Server-side cart clearing — only the PURCHASED variants leave the cart,
        // and only on verified payment success (never on failure/pending). Lines
        // the buyer unchecked (kept for later) survive: selection-aware carts.
        // PaymentGroups are account-scoped (shopperId always set). Inside the tx:
        // a rollback never strands paid items out of the cart inconsistently.
        const purchasedVariantIds = [
          ...new Set(group.orders.flatMap((o) => o.items.map((it) => it.variantId)).filter((v): v is string => Boolean(v))),
        ];
        await tx.cartItem.deleteMany({
          where: { cart: { shopperId: group.shopperId }, variantId: { in: purchasedVariantIds } },
        });

        return { claimed: true as const };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    if (!outcome.claimed) {
      // Duplicate delivery — existing duplicate branch shape, processed=true.
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

    await db.paymentWebhookLog.update({ where: { id: log.id }, data: { processed: true } });

    // (FIN-1 1.6 wiring) T2 auto-settle — AFTER the success tx commits. The
    // recipe is idempotent (dedupKey gateway_settlement:settlement:{ref}), so a
    // crash here is healed by the next delivery's claim-miss path... which is
    // why the call lives outside the tx: the PSP settles buyer funds to the
    // platform bank account; T2 clears the GATEWAY:{provider} receivable into
    // BANK_MAIN. Default setting false = dormant (documented decision).
    if (await autoSettleEnabled()) {
      await postGatewaySettlement({ provider: group.provider, amountMinor: group.totalMinor, ref: providerRef, occurredAt: paidAt });
    }

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

  if (eventType === "payment.failed") {
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

  const settings = await getCommissionSettings();
  const paidAt = new Date();

  // SUCCESS PATH — same claim-first Serializable pattern as the group path.
  const outcome = await db.$transaction(
    async (tx) => {
      const claim = await tx.paymentIntent.updateMany({
        where: { id: intent.id, status: { not: "succeeded" } },
        data: { status: "succeeded" },
      });
      if (claim.count === 0) return { claimed: false as const };

      const order = await tx.order.findUnique({
        where: { id: intent.orderId },
        include: { items: true, store: { include: { seller: { include: { wallet: true } } } } },
      });
      if (!order) throw new ApiError(404, "ORDER_NOT_FOUND", "Order for payment intent not found");

      await transitionOrder({ orderId: order.id, toStatus: "paid", actor: "system", note: `Payment ${providerRef} succeeded via ${intent.provider}`, timestamps: { paidAt }, tx });

      // Server-side cart clearing — only the PURCHASED variants leave the cart,
      // and only on verified payment success (never on failure/pending, never
      // client-driven). Account carts clear by shopperId; the token is a legacy/
      // reconciliation fallback for rows that predate account-scoped carts.
      // Selection-aware: unchecked (kept-for-later) lines are never removed here.
      const purchasedVariantIds = [...new Set(order.items.map((it) => it.variantId).filter((v): v is string => Boolean(v)))];
      if (order.shopperId) {
        await tx.cartItem.deleteMany({
          where: { cart: { shopperId: order.shopperId }, variantId: { in: purchasedVariantIds } },
        });
      } else if (order.cartToken) {
        await tx.cartItem.deleteMany({
          where: { cart: { token: order.cartToken }, variantId: { in: purchasedVariantIds } },
        });
      }

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
          provider: intent.provider,
          totalMinor: intent.amountMinor,
          sellerNetMinor,
          commissionMinor,
          holdUntil,
          currency: order.currency,
          occurredAt: paidAt,
          tx,
        });
      }

      // Store webhooks + notifications (see group path rationale — dedupKeys).
      await dispatchStoreWebhooks({
        storeId: order.storeId,
        event: "order.paid",
        payload: { orderNumber: order.orderNumber, totalMinor: order.totalMinor, currency: order.currency },
      });
      if (seller) {
        await notify({ event: "order.paid", channel: "email", recipient: seller.email, subject: `You have a new paid order ${order.orderNumber}`, dedupKey: `order.paid.email:${order.id}` });
        await notify({ event: "order.paid", channel: "inapp", recipient: seller.email, subject: "You have a new paid order", dedupKey: `order.paid.inapp:${order.id}` });
      }
      await notify({ event: "order.receipt", channel: "email", recipient: order.customerEmail, subject: `Your order ${order.orderNumber} is confirmed`, dedupKey: `order.receipt.email:${order.id}` });
      // Shopper in-app nudge (Task 10-d) — payment confirmed → "Order confirmed".
      await notifyShopperOrderConfirmed({ orderNumber: order.orderNumber, shopperId: order.shopperId, storeId: order.storeId, store: order.store });
      await logActivity({ actorType: "system", action: "payment.succeeded", entityType: "order", entityId: order.id, meta: { providerRef, provider: intent.provider, totalMinor: intent.amountMinor } });

      return { claimed: true as const };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  if (!outcome.claimed) {
    await db.paymentWebhookLog.update({ where: { id: log.id }, data: { processed: true } });
    const order = await db.order.findUnique({ where: { id: intent.orderId } });
    return {
      ok: true,
      duplicate: true,
      eventType,
      orderNumber: order?.orderNumber ?? "",
      orderStatus: order?.status ?? "",
      intentStatus: "succeeded",
    };
  }

  await db.paymentWebhookLog.update({ where: { id: log.id }, data: { processed: true } });

  // T2 auto-settle (see group path) — after commit, idempotent recipe.
  if (await autoSettleEnabled()) {
    await postGatewaySettlement({ provider: intent.provider, amountMinor: intent.amountMinor, ref: providerRef, occurredAt: paidAt });
  }

  return {
    ok: true,
    duplicate: false,
    eventType,
    orderNumber: (await db.order.findUnique({ where: { id: intent.orderId } }))?.orderNumber ?? "",
    orderStatus: "paid",
    intentStatus: "succeeded",
  };
}

/**
 * FIN-2b (2b.4) — inbound PAYOUT lifecycle events from the PSP.
 *
 * The provider confirms (or fails) a bank transfer we initiated. providerRef
 * resolution: try Payout.referenceNo first (the canonical platform reference —
 * what the mock PSP and payout-simulate echo); fall back to Payout.providerRef
 * (the transfer ref an admin recorded at mark-paid — some providers echo that
 * instead). Both lookups are documented PSP integration surface.
 *
 * Same claim-first race safety as the payment paths: assertTransition guards
 * the semantics, the conditional updateMany serializes concurrent deliveries,
 * and T4/T4f post inside the same Serializable tx as the status flip.
 */
async function processPayoutEvent(args: {
  provider: string;
  providerRef: string;
  eventType: "payout.succeeded" | "payout.failed";
  amountMinor: number;
  reason: string | null;
  logId: string;
}): Promise<ProcessResult> {
  const payout =
    (await db.payout.findUnique({ where: { referenceNo: args.providerRef } })) ??
    (await db.payout.findFirst({ where: { providerRef: args.providerRef } }));
  if (!payout) {
    throw new ApiError(404, "PAYOUT_NOT_FOUND", `No payout matches providerRef ${args.providerRef}`);
  }

  const toStatus = args.eventType === "payout.succeeded" ? "paid" : "failed";
  const dedupKey = `${toStatus === "paid" ? "payout.paid" : "payout.failed"}:${payout.id}`;

  // Idempotent replay: the provider re-delivered an event we already applied
  // (e.g. payout.succeeded for an already-paid payout) → ok + conflict flag,
  // never a raw 409 at the provider. Decision is recorded (processed=true).
  if (payout.status === toStatus) {
    await db.paymentWebhookLog.update({ where: { id: args.logId }, data: { processed: true } });
    return {
      ok: true,
      duplicate: true,
      payoutConflict: true,
      eventType: args.eventType,
      orderNumber: "",
      orderStatus: payout.status,
      intentStatus: "",
      payoutStatus: payout.status,
    };
  }

  // State machine guard (cheap, no locks): an illegal transition (e.g.
  // requested→paid — the money was never reserved by T3) is a hard 409. The
  // decision is recorded on the webhook row before throwing.
  assertTransition(payout.status, toStatus);

  // Amount guard BEFORE the claim (mirror of the payment paths).
  if (args.amountMinor !== payout.amountMinor) {
    throw new ApiError(409, "AMOUNT_MISMATCH", `Webhook amount ${args.amountMinor} does not match payout ${payout.amountMinor}`);
  }

  const seller = await db.seller.findUnique({ where: { id: payout.sellerId } });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller for payout not found");

  const at = new Date();
  // T4f reason: use the provider-supplied reason when present.
  const reason = args.reason ?? "provider reported failure";
  const subject = toStatus === "paid" ? `Payout ${payout.referenceNo} on the way` : `Payout ${payout.referenceNo} failed`;

  const outcome = await db.$transaction(
    async (tx) => {
      // Conditional claim — expectedFrom is "processing" per the state machine
      // (only processing payouts are awaiting provider confirmation). count 0
      // ⇒ lost race / concurrent admin action ⇒ empty-tx-return (rollback-by-
      // return: the claim was the only intended write and it wrote nothing).
      const claim = await tx.payout.updateMany({
        where: { id: payout.id, status: "processing" },
        data: { status: toStatus },
      });
      if (claim.count === 0) return { claimed: false as const };

      if (toStatus === "paid") {
        await tx.payout.update({ where: { id: payout.id }, data: { paidAt: at } });
        // T4 — clearing → bank; refreshWalletCache runs inside the recipe (tx).
        await postPayoutConfirmed({
          walletId: payout.walletId,
          payoutId: payout.id,
          referenceNo: payout.referenceNo,
          amountMinor: payout.amountMinor,
          tx,
        });
      } else {
        await tx.payout.update({ where: { id: payout.id }, data: { failReason: reason } });
        // T4f — reversal of T3 (clearing → back to seller payable).
        await postPayoutFailed({
          walletId: payout.walletId,
          payoutId: payout.id,
          referenceNo: payout.referenceNo,
          amountMinor: payout.amountMinor,
          reason,
          tx,
        });
      }

      // Seller notifications (email + inapp) with stable per-event dedupKeys;
      // subjects mirror the admin mark-paid / fail routes.
      await notify({ event: toStatus === "paid" ? "payout.paid" : "payout.failed", channel: "email", recipient: seller.email, subject, dedupKey });
      await notify({ event: toStatus === "paid" ? "payout.paid" : "payout.failed", channel: "inapp", recipient: seller.email, subject, dedupKey });
      await logActivity({
        actorType: "system",
        action: toStatus === "paid" ? "payout.provider_confirmed" : "payout.provider_failed",
        entityType: "payout",
        entityId: payout.id,
        meta: { providerRef: args.providerRef, referenceNo: payout.referenceNo, amountMinor: payout.amountMinor },
      });

      return { claimed: true as const };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  const freshPayout = await db.payout.findUnique({ where: { id: payout.id } });
  const payoutStatus = freshPayout?.status ?? payout.status;

  if (!outcome.claimed) {
    // Lost the race (e.g. an admin transitioned the payout concurrently) —
    // answer ok with payoutConflict so the provider's retry converges; never
    // throw raw 5xx at a PSP. Decision recorded (processed=true).
    await db.paymentWebhookLog.update({ where: { id: args.logId }, data: { processed: true } });
    return {
      ok: true,
      duplicate: true,
      payoutConflict: true,
      eventType: args.eventType,
      orderNumber: "",
      orderStatus: payoutStatus,
      intentStatus: "",
      payoutStatus,
    };
  }

  await db.paymentWebhookLog.update({ where: { id: args.logId }, data: { processed: true } });
  return {
    ok: true,
    duplicate: false,
    eventType: args.eventType,
    orderNumber: "",
    orderStatus: payoutStatus,
    intentStatus: "",
    payoutStatus,
  };
}

export function webhookPayloadJson(body: unknown): string {
  return toJson(body);
}
