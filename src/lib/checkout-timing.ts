// ============================================================================
// checkout-timing.ts — checkout latency-anatomy instrumentation (Phase 4 of
// performance/checkout-capacity-review.md).
//
// OBSERVATION ONLY: zero behavior change, zero extra DB queries. Wall-clock
// marks around the EXISTING awaits produce one stdout JSON line per checkout
// request when CHECKOUT_TIMING=1 (visible in dev.log; parsed per concurrency
// level by scripts/loadtest/sweep.ts into latency breakdowns).
//
// What each phase separates (the review's required split):
//   auth        session + shopper-user reads (pre-gate)
//   idem        idempotency replay lookups (pre-gate)
//   gate        admission-gate queue wait (measured by checkout-gate itself)
//   body        request parse + validation
//   pricing     computeGroupPricing (+ shipping availability assert)
//   vouchers    buildVoucherOutcomes (0 when unused)
//   commission  batched loadRateContext + in-memory resolution
//   cart        cart token read
//   counter     order-number upsert(s)
//   txAcquire   $transaction call → callback entry = Prisma pool wait for the
//               tx connection (the P2028 window) + connection setup
//   txExec      statements inside the interactive tx (+ count)
//   postTx      orders re-read + notify/logActivity batch
//   loopLagMs   latest 1 s event-loop drift sample (server-side, coarse;
//               combined-environment caveat applies)
//
// Timing lines are emitted on success AND on error paths (status 0 on error —
// the real HTTP status is only known to the client; failure-path anatomy is
// still recorded). No secrets, no customer data — idemKey is the [LT]-scoped
// test key or the shopper's own key, which the request already carries.
// ============================================================================

const ENABLED = process.env.CHECKOUT_TIMING === "1";

export type CheckoutTimingRecord = {
  idemKey: string;
  status: number; // HTTP status of the produced response; 0 on error path
  totalMs: number;
  gateWaitMs: number;
  authMs: number;
  idemMs: number;
  bodyMs: number;
  pricingMs: number;
  voucherMs: number;
  commissionMs: number;
  cartMs: number;
  counterMs: number;
  txAcquireMs: number;
  txExecMs: number;
  txStatements: number;
  postTxMs: number;
  gateActive: number;
  gateQueued: number;
  loopLagMs: number;
};

// --- coarse server-side event-loop drift sampler (1 s interval) ------------
let loopLagMs = 0;
if (ENABLED) {
  const INTERVAL = 1000;
  let expected = Date.now() + INTERVAL;
  const tick = () => {
    loopLagMs = Math.max(0, Math.round(Date.now() - expected));
    expected = Date.now() + INTERVAL;
    const t = setTimeout(tick, INTERVAL);
    if (typeof t.unref === "function") t.unref();
  };
  const t = setTimeout(tick, INTERVAL);
  if (typeof t.unref === "function") t.unref();
}

export function timingEnabled(): boolean {
  return ENABLED;
}

export type CheckoutTiming = {
  /** Close the currently open phase under `name` and open the next one. */
  mark: (name: string) => void;
  /** Emit the record; `extra` overrides computed marks (gate wait, tx anatomy). */
  emit: (status: number, extra?: Partial<CheckoutTimingRecord>) => void;
};

const PHASE_KEYS: (keyof CheckoutTimingRecord)[] = [
  "authMs", "idemMs", "bodyMs", "pricingMs", "voucherMs", "commissionMs",
  "cartMs", "counterMs", "postTxMs",
];

/** Create a recorder for one request. No-op overhead when CHECKOUT_TIMING≠1
 *  (marks become microseconds-scale no-ops; emit is a guard clause). */
export function startCheckoutTiming(idemKey: string): CheckoutTiming {
  if (!ENABLED) {
    return { mark: () => {}, emit: () => {} };
  }
  const t0 = performance.now();
  let prev = t0;
  const marks: Record<string, number> = {};
  return {
    mark(name) {
      const now = performance.now();
      marks[name] = (marks[name] ?? 0) + (now - prev);
      prev = now;
    },
    emit(status, extra) {
      const r: CheckoutTimingRecord = {
        idemKey,
        status,
        totalMs: Math.round(performance.now() - t0),
        gateWaitMs: 0,
        authMs: 0,
        idemMs: 0,
        bodyMs: 0,
        pricingMs: 0,
        voucherMs: 0,
        commissionMs: 0,
        cartMs: 0,
        counterMs: 0,
        txAcquireMs: 0,
        txExecMs: 0,
        txStatements: 0,
        postTxMs: 0,
        gateActive: -1,
        gateQueued: -1,
        loopLagMs,
      };
      for (const k of PHASE_KEYS) {
        (r[k] as number) = Math.round((marks[String(k).replace(/Ms$/, "")] ?? 0) * 10) / 10;
      }
      console.log("[CHECKOUT_TIMING] " + JSON.stringify({ ...r, ...extra }));
    },
  };
}
