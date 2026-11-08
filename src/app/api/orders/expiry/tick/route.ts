import { handle, ok } from "@/lib/api";
import { assertCronAuth } from "@/lib/cron-auth";
import { runExpirySweep } from "@/lib/expiry-sweep";
import type { ExpiryTickData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/orders/expiry/tick — the durable reservation-expiry runner (F3).
//
// Sweeps UNPAID, EXPIRED reservations and releases their stock exactly once
// via the shared atomic primitives (CAS claims on the group + order rows —
// overlapping runs and concurrent payment confirmations are safe by
// construction; a paid or already-released order can never be restocked).
//
// C1.1 (Phase 2.2): the sweep now runs the SAME group-coordinated core as
// /api/cron/expiry-sweep (lib/expiry-sweep.ts):
//   • PaymentGroups past expiry are claimed `requires_payment|failed →
//     expired` FIRST, with their orders transitioned + restocked + voucher/
//     coupon redemptions restored in the same transaction.
//   • Legacy single-intent orders go through releaseOrderReservation, which
//     performs identical group coordination.
// An order-level release can therefore never leave a PaymentGroup claimable
// for a late webhook — the stock-resurrection race is closed on every rail.
//
// AUTH (Phase 2.2, C1.1 req 8): this was previously an UNAUTHENTICATED
// privileged maintenance surface (documented in
// performance/f3-inventory-audit.md as a curl crontab). It now requires the
// established cron authentication (lib/cron-auth.ts): timing-safe
// `x-cron-secret` when CRON_SECRET is configured; 503 fail-closed in
// production without it; dev-open only outside production so sandbox tests
// keep working. Production crontab must send the header, e.g.
//   * * * * * curl -fsS -X POST -H "x-cron-secret: $CRON_SECRET" \
//       http://127.0.0.1:3000/api/orders/expiry/tick
const TICK_THROTTLE_MS = 1_500;

export const POST = handle(async (req: Request) => {
  const auth = assertCronAuth(req);
  const g = globalThis as Record<string, unknown>;
  const last = typeof g.__expiryTickAt === "number" ? g.__expiryTickAt : 0;
  if (Date.now() - last < TICK_THROTTLE_MS) {
    const throttled: ExpiryTickData = { scanned: 0, released: 0, skipped: 0, errors: [], throttled: true, auth: auth.mode };
    return ok(throttled);
  }
  g.__expiryTickAt = Date.now();
  const result = await runExpirySweep();
  const payload: ExpiryTickData = { ...result, auth: auth.mode };
  return ok(payload);
});
