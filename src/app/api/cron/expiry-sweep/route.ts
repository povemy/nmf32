import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { toJson } from "@/lib/json";
import { assertCronAuth } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

// ============================================================================
// F3 REMEDIATION — PAYMENT-WINDOW EXPIRY SWEEP (cron tick)
// ----------------------------------------------------------------------------
// WHY: checkout decrements stock AT CREATE; an unpaid PaymentGroup keeps that
// stock reserved until it is paid or expired. Before this sweep, `expiresAt`
// (+30 min, written by /api/checkout/create) was enforced NOWHERE — measured
// evidence: an unpaid checkout held its stock 75 s past expiry with the order
// still payment_pending (performance/REPORT.md §3.4). Abandoned checkouts
// leaked stock forever.
//
// WHAT IT DOES (per expired group, ONE transaction per group, claim-first):
//   1. CLAIM: conditional updateMany `requires_payment → expired`. The loser
//      of any race (another sweep, a payment confirmation) matches 0 rows and
//      touches NOTHING → repeated/overlapping sweeps can never double-restock.
//   2. Per-order guard: `payment_pending → payment_expired` (conditional).
//      An order that somehow became paid is skipped, not restocked.
//   3. Stock release: INCREMENT per item + InventoryLog (`expiry:{ref}`) +
//      salesCount decrement (floor-guarded). Atomic with the claim → a
//      committed expiry always owns its restock exactly once.
//
// LATE PAYMENT AFTER RELEASE (defined recovery policy, exercised by the
// webhook path): a payment.succeeded arriving for an expired group is refused
// with 409 GROUP_EXPIRED — no money moves, no order is resurrected, the PSP
// treats it as a permanent failure and (in production) refunds per its own
// cadence. The mock PSP surfaces the refusal to the buyer directly. The
// ±10 min webhook retry window vs the 30 min payment window means a real PSP
// redelivery can only arrive for a group expired ≥ 20 min — the refusal is
// the expected steady-state, not an anomaly.
//
// SCHEDULING (durable): this route is the worker TICK, not the scheduler. The
// recurring invocation lives in mini-services/expiry-scheduler (port 3005,
// interval + durable state + alerts — see its README), which POSTs this
// endpoint; a platform cron / uptime pinger is the production equivalent.
// Every run records its outcome in Setting `cron.expiry_sweep.last` (survives
// restarts) so ops can observe backlog, failures and last-success age.
// AUTH (mission: final operational gaps): assertCronAuth (lib/cron-auth.ts) —
// in production a MISSING CRON_SECRET fails CLOSED (503, never publicly
// callable); when set, the `x-cron-secret` header is compared timing-safely.
// Dev without a secret stays open for direct sandbox testing.
// ============================================================================

const SWEEP_THROTTLE_MS = 1_500;
const BATCH = 50;

export const POST = handle(async (req: Request) => {
  const auth = assertCronAuth(req);
  const g = globalThis as Record<string, unknown>;
  const last = typeof g.__expirySweepAt === "number" ? (g.__expirySweepAt as number) : 0;
  const now = Date.now();
  if (now - last < SWEEP_THROTTLE_MS) {
    return ok({ throttled: true, expired: 0, auth: auth.mode });
  }
  g.__expirySweepAt = now;

  const t0 = performance.now();
  const stats = { examined: 0, expired: 0, ordersExpired: 0, itemsRestocked: 0, skippedConcurrent: 0, anomalies: 0, failures: 0 };

  const nowDate = new Date();
  const candidates = await db.paymentGroup.findMany({
    where: { status: "requires_payment", expiresAt: { lt: nowDate } },
    include: { orders: { include: { items: { select: { variantId: true, productId: true, qty: true } } } } },
    orderBy: { expiresAt: "asc" },
    take: BATCH,
  });
  stats.examined = candidates.length;

  for (const group of candidates) {
    try {
      // ONE transaction per group: claim + order transitions + restock are
      // atomic. Default isolation (READ COMMITTED) + conditional claims: the
      // group claim is the first write and the only gate — concurrent sweeps
      // and payment confirmations can never both win it.
      const result = await db.$transaction(async (tx) => {
        const claim = await tx.paymentGroup.updateMany({
          where: { id: group.id, status: "requires_payment" },
          data: { status: "expired" },
        });
        if (claim.count === 0) return { claimed: false as const };

        let ordersExpired = 0;
        let itemsRestocked = 0;
        for (const order of group.orders) {
          // Per-order guard: only still-unpaid orders expire; an order paid
          // by a racing confirmation is skipped (its group claim would have
          // lost anyway — this is belt-and-braces).
          const moved = await tx.order.updateMany({
            where: { id: order.id, status: "payment_pending" },
            data: { status: "payment_expired", cancelledAt: nowDate },
          });
          if (moved.count === 0) {
            stats.anomalies++;
            continue; // never restock an order that is not safely unpaid
          }
          ordersExpired++;
          await tx.orderStatusHistory.create({
            data: { orderId: order.id, fromStatus: "payment_pending", toStatus: "payment_expired", actor: "system", note: `Payment window expired (${group.ref}) — stock released by expiry sweep` },
          });
          for (const item of order.items) {
            await tx.productVariant.update({
              where: { id: item.variantId },
              data: { stock: { increment: item.qty } },
            });
            await tx.inventoryLog.create({
              data: { variantId: item.variantId, delta: item.qty, reason: `expiry:${group.ref}`, refId: order.id },
            });
            if (item.productId) {
              // Floor-guarded decrement: salesCount must never go negative.
              await tx.product.updateMany({
                where: { id: item.productId, salesCount: { gte: item.qty } },
                data: { salesCount: { decrement: item.qty } },
              });
            }
            itemsRestocked++;
          }
        }
        return { claimed: true as const, ordersExpired, itemsRestocked };
      });

      if (result.claimed) {
        stats.expired++;
        stats.ordersExpired += result.ordersExpired;
        stats.itemsRestocked += result.itemsRestocked;
      } else {
        stats.skippedConcurrent++;
      }
    } catch (e) {
      stats.failures++;
      console.error(`[expiry-sweep] group ${group.ref} failed (will retry next tick):`, e instanceof Error ? e.message : e);
    }
  }

  const remaining = await db.paymentGroup.count({ where: { status: "requires_payment", expiresAt: { lt: new Date() } } });
  const outcome = { ...stats, remainingBacklog: remaining, durationMs: Math.round(performance.now() - t0), at: new Date().toISOString(), batchLimit: BATCH, auth: auth.mode };

  // Durable observability — survives restarts, queryable by ops/admin.
  await db.setting.upsert({
    where: { key: "cron.expiry_sweep.last" },
    create: { key: "cron.expiry_sweep.last", valueJson: toJson(outcome), description: "Last expiry-sweep outcome (F3 remediation)" },
    update: { valueJson: toJson(outcome) },
  });

  return ok(outcome);
});

// GET — backlog + last-run observability without triggering a sweep.
// Same auth posture as POST (scheduler/ops surface: fail-closed in production
// without a secret; timing-safe header check when configured).
export const GET = handle(async (req: Request) => {
  const auth = assertCronAuth(req);
  const [backlog, oldest, lastSetting] = await Promise.all([
    db.paymentGroup.count({ where: { status: "requires_payment", expiresAt: { lt: new Date() } } }),
    db.paymentGroup.findFirst({
      where: { status: "requires_payment", expiresAt: { lt: new Date() } },
      orderBy: { expiresAt: "asc" },
      select: { expiresAt: true },
    }),
    db.setting.findUnique({ where: { key: "cron.expiry_sweep.last" } }),
  ]);
  return ok({
    backlog,
    oldestExpiredAt: oldest?.expiresAt?.toISOString() ?? null,
    lastRun: lastSetting ? JSON.parse(lastSetting.valueJson) : null,
    auth: auth.mode,
    schedulingNote: "Recurring invocation: mini-services/expiry-scheduler (this deployment) or a platform cron in production; this endpoint is the tick, not the scheduler",
  });
});
