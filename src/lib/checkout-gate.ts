// ============================================================================
// CHECKOUT ADMISSION GATE (mission: production-readiness remediation, F2)
// ----------------------------------------------------------------------------
// WHY THIS EXISTS — measured evidence, not speculation:
//   • At 20 concurrent checkouts every request succeeded (p50 4.21 s, p95
//     4.93 s). At 40 concurrent, 17/40 requests died as RAW 500s
//     (P2028 interactive-tx timeout ×13 in the remediation retest, P2034 ×14 earlier,
//     P2024 pool timeout ×4 across the ramp+rush windows) —
//     performance/REPORT.md §5.1–5.2. The system had NO clean overload path:
//     buyers saw infrastructure errors instead of "busy, retry in Ns".
//
// WHAT IT DOES:
//   • Bounds the number of checkout creations actually executing against the
//     DB (semaphore). Excess arrivals WAIT in a bounded FIFO queue (queue time
//     is measured separately from processing time and returned to the caller).
//   • When the queue is full or the bounded wait expires, the buyer gets a
//     CLEAN, retryable `503 CHECKOUT_BUSY` with a `Retry-After` header —
//     never a raw 500. Carts are untouched (the gate runs before any write),
//     and the client's Idempotency-Key survives retries so a replay after a
//     busy response converges on the same checkout.
//   • Retry-storm damping: shedding excess arrivals (instead of letting them
//     burn 5-second DB transactions that end in 500) removes the feedback loop
//     where every retry costs a full pool connection. The 503 + Retry-After
//     contract gives clients a bounded backoff target.
//
// SCOPE + HONEST LIMITS (do not remove this note):
//   • SINGLE-PROCESS. Like lib/ratelimit.ts, this semaphore coordinates one
//     Next.js server process only. Multi-instance deployments need a shared
//     admission control (DB advisory lock / Redis) BEFORE horizontal scaling —
//     the current intended topology is 1 instance × 1 process, where this is
//     exact. See performance/REPORT.md §4 (connection budget) — do not scale
//     horizontally until a cross-instance gate + connection budget exist.
//   • Thresholds are derived from THIS sandbox's measured behaviour (dev-mode,
//     combined environment, remote DB). Re-derive them in staging before
//     treating them as production numbers. All are env-overridable.
// ============================================================================
import { ApiError } from "./api";

const MAX_INFLIGHT = Number(process.env.CHECKOUT_ADMISSION_MAX_INFLIGHT ?? 8);
const MAX_WAITING = Number(process.env.CHECKOUT_ADMISSION_MAX_WAITING ?? 32);
const WAIT_MS = Number(process.env.CHECKOUT_ADMISSION_WAIT_MS ?? 5000);
const RETRY_AFTER_S = Number(process.env.CHECKOUT_ADMISSION_RETRY_AFTER_S ?? 2);

type Waiter = { resolve: () => void; enqueuedAt: number };

// Module-global so every route import in this process shares one semaphore.
const g = globalThis as unknown as {
  __checkoutGate?: { inflight: number; waiters: Waiter[] };
};
const state =
  g.__checkoutGate ?? (g.__checkoutGate = { inflight: 0, waiters: [] });

function busyError(msWaited: number) {
  return new ApiError(
    503,
    "CHECKOUT_BUSY",
    "Checkout is at capacity right now — your cart is safe, please retry shortly",
    { retriable: true, waitedMs: msWaited, maxInflight: MAX_INFLIGHT },
    { "Retry-After": String(RETRY_AFTER_S) }
  );
}

export type Admission = { queueMs: number; release: () => void };

/**
 * Acquire an admission slot, waiting in the bounded FIFO queue when the
 * semaphore is saturated. Throws 503 CHECKOUT_BUSY (+ Retry-After) when the
 * wait budget is exhausted or the queue is full — BEFORE any DB write.
 */
export async function acquireCheckoutAdmission(): Promise<Admission> {
  const t0 = performance.now();

  // Fast path — free slot.
  if (state.inflight < MAX_INFLIGHT && state.waiters.length === 0) {
    state.inflight++;
    return { queueMs: 0, release };
  }

  // Queue full → shed immediately (bounded memory; no unbounded in-process queue).
  if (state.waiters.length >= MAX_WAITING) throw busyError(0);

  // Bounded FIFO wait — the slot is TRANSFERRED by release() (inflight is not
  // decremented when a waiter is woken), so no faster arrival can steal it.
  const waited = await new Promise<number>((resolve, reject) => {
    const waiter: Waiter = { enqueuedAt: t0, resolve: () => resolve(0) };
    state.waiters.push(waiter);
    const timer = setTimeout(() => {
      const i = state.waiters.indexOf(waiter);
      if (i >= 0) state.waiters.splice(i, 1);
      reject(busyError(Math.round(performance.now() - t0)));
    }, WAIT_MS);
    waiter.resolve = () => {
      clearTimeout(timer);
      resolve(Math.round(performance.now() - t0));
    };
  });
  return { queueMs: waited, release };
}

/** Release a slot — handed directly to the next FIFO waiter when one waits. */
export function release(): void {
  const next = state.waiters.shift();
  if (next) {
    next.resolve(); // slot transfer: inflight count intentionally unchanged
    return;
  }
  state.inflight = Math.max(0, state.inflight - 1);
}

/** Run `fn` under admission control; returns [result, queueMs]. */
export async function withCheckoutAdmission<T>(fn: () => Promise<T>): Promise<{ result: T; queueMs: number }> {
  const adm = await acquireCheckoutAdmission();
  try {
    return { result: await fn(), queueMs: adm.queueMs };
  } finally {
    adm.release();
  }
}

/** Introspection for /api/health + tests (single-process numbers). */
export function checkoutGateStats() {
  return { inflight: state.inflight, waiting: state.waiters.length, maxInflight: MAX_INFLIGHT, maxWaiting: MAX_WAITING, waitMs: WAIT_MS };
}
