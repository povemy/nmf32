// ============================================================================
// expiry-sweep.ts — shared expiry runner core (F3). The POST /api/orders/expiry/tick
// route is the scheduled entry point; payment-status polling lazily triggers
// the same sweep (fire-and-forget). The DB-side CAS claim in
// releaseOrderReservation is the correctness mechanism — in-memory throttling
// is only a load valve, so timers/missed runs can never lose a release.
// ============================================================================

import { db } from "./db";
import { releaseOrderReservation } from "./inventory-release";

const SWEEP_BATCH = 50;
const THROTTLE_MS = 1_500;

export type SweepResult = {
  scanned: number;
  released: number;
  skipped: number;
  errors: { orderId: string; error: string }[];
  throttled: boolean;
};

/** Run one bounded sweep of eligible expired unpaid reservations. */
export async function runExpirySweep(): Promise<SweepResult> {
  // Phase 1 (E1): TWO candidate classes.
  //  (a) Modern checkout: order's PaymentGroup past expiry in
  //      requires_payment OR failed (failed = PSP declined + buyer abandoned
  //      the retry — previously leaked reserved stock forever).
  //  (b) LEGACY single-PaymentIntent orders (paymentGroupId null): intent in
  //      requires_payment OR failed past its own expiresAt. Previously these
  //      orders matched NO sweep (the query required a paymentGroup relation).
  // releaseOrderReservation is the SAME CAS primitive for both: it claims the
  // ORDER row (payment_pending → cancelled) and only the winner restocks —
  // exactly-once release regardless of candidate class.
  const eligible = await db.order.findMany({
    where: {
      status: "payment_pending",
      OR: [
        { paymentGroup: { status: { in: ["requires_payment", "failed"] }, expiresAt: { lt: new Date() } } },
        {
          paymentGroupId: null,
          paymentIntents: { some: { status: { in: ["requires_payment", "failed"] }, expiresAt: { lt: new Date() } } },
        },
      ],
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: SWEEP_BATCH,
  });

  let released = 0;
  let skipped = 0;
  const errors: { orderId: string; error: string }[] = [];
  // Sequential per-order processing keeps DB pressure bounded (pool=10); the
  // per-order claim makes concurrent workers redundant, not harmful.
  for (const o of eligible) {
    try {
      const outcome = await releaseOrderReservation({ orderId: o.id, actor: "expiry-sweep", reason: "expired unpaid" });
      if (outcome.released) released++;
      else skipped++;
    } catch (e) {
      // One failing order must not hide the rest of the batch.
      errors.push({ orderId: o.id, error: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160) });
    }
  }
  return { scanned: eligible.length, released, skipped, errors, throttled: false };
}

/** Fire-and-forget lazy trigger with in-process throttle — never throws, never
 *  blocks the caller. Overlapping/missed executions are inherently safe (CAS). */
export function maybeRunExpirySweepLazy(): void {
  const g = globalThis as Record<string, unknown>;
  const last = typeof g.__expiryTickAt === "number" ? g.__expiryTickAt : 0;
  if (Date.now() - last < THROTTLE_MS) return;
  g.__expiryTickAt = Date.now();
  void runExpirySweep().catch((e) => {
    console.warn("[f3] lazy expiry sweep failed (will retry on next trigger):", e instanceof Error ? e.message.slice(0, 160) : e);
  });
}
