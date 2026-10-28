import { handle, ok } from "@/lib/api";
import { runExpirySweep } from "@/lib/expiry-sweep";

export const dynamic = "force-dynamic";

// POST /api/orders/expiry/tick — the durable reservation-expiry runner (F3).
//
// Sweeps UNPAID, EXPIRED reservations and releases their stock exactly once
// via the shared atomic primitive (CAS claim on the order row — overlapping
// runs and concurrent payment confirmations are safe by construction; a paid
// or already-released order can never be restocked).
//
// Eligibility: Order.status="payment_pending" AND PaymentGroup.status=
// "requires_payment" (succeeded groups NEVER match) AND expiresAt < now
// (the existing 30-minute TTL, unchanged).
//
// Worker model (mirrors the sandbox's /api/shipping/tick precedent): an
// unauthenticated POST with an in-process throttle — the DB-side claim is the
// source of truth, so timers are only a load valve, never the correctness
// mechanism. Scheduling:
//   • Sandbox / dev: lazy trigger from payment-status polling + direct
//     invocation from tests/harness.
//   • Production deployment (documented in performance/f3-inventory-audit.md):
//     * * * * * curl -fsS -X POST http://127.0.0.1:3000/api/orders/expiry/tick
//     (1-minute cron, or any interval within the business TTL tolerance).
const TICK_THROTTLE_MS = 1_500;

export const POST = handle(async () => {
  const g = globalThis as Record<string, unknown>;
  const last = typeof g.__expiryTickAt === "number" ? g.__expiryTickAt : 0;
  if (Date.now() - last < TICK_THROTTLE_MS) {
    return ok({ scanned: 0, released: 0, skipped: 0, errors: [], throttled: true });
  }
  g.__expiryTickAt = Date.now();
  return ok(await runExpirySweep());
});
