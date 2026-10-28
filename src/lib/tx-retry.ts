// ============================================================================
// Bounded retry for transient Serializable-transaction conflicts (F1 fix).
//
// WHY THIS EXISTS (evidence: performance/f1-audit.md + performance/f1/before.json):
//   The payment-confirmation success paths run at PG SERIALIZABLE. Under
//   concurrent confirmations the loser of the claim race (or any SSI
//   read-write cycle — e.g. two buyers paying the same store contending on
//   the seller wallet row) is aborted by Postgres with 40001, which Prisma 6
//   surfaces as PrismaClientKnownRequestError code **P2034** ("Transaction
//   failed due to a write conflict or a deadlock"). Before F1, that error
//   escaped as a raw HTTP 500 and the PSP had to redeliver to converge —
//   measured: 3×500 in a same-ref storm, 12/12 payments failed in a 12-way
//   cross-ref storm.
//
// RETRY CONTRACT (F1 task rules):
//   • ONLY P2034 is retried — it is the single "transient transaction
//     conflict" code for this driver/Prisma version (maps PG 40001 + 40P01).
//     P2024 (pool-fetch timeout) and P2028 (interactive-tx timeout) are NOT
//     conflicts — they are resource-saturation signals (F2) and are allowed
//     to fail immediately so they stay visible in evidence instead of being
//     masked by retries.
//   • The ENTIRE transaction is retried from its beginning (a fresh
//     $transaction re-runs the callback). It is the caller's responsibility
//     to keep the callback retry-safe: claim-first conditional writes,
//     in-tx business writes, dedupKey-backed idempotency outside the tx
//     (audited for process.ts in performance/f1-audit.md §5).
//   • Validation/business errors (ApiError) and every other error class pass
//     through untouched — never retried.
//   • Bounded: max attempts (default 3, clamp 1–5) then the conflict is
//     rethrown as ApiError 503 PAYMENT_TX_RETRY_EXHAUSTED — an explicit
//     failure, NEVER disguised as success. For webhooks, 503 is the correct
//     "retry later" contract for the provider; the delivery stays
//     processed=false in payment_webhook_logs for the FIN-1 sweep.
//   • Backoff: exponential with jitter, bounded (base 25 ms, cap 400 ms, env
//     tunable). The Prisma connection is RELEASED between attempts
//     ($transaction ended), so waiting does not hold pool capacity.
//   • Config is clamped (not fail-closed) on misconfiguration: a payment rail
//     must not die from a bad env var; the clamp is warned once. No secrets
//     or customer/payment data are ever logged — only counts and codes.
// ============================================================================

import { Prisma } from "@prisma/client";
import { db } from "./db";
import { ApiError } from "./api";

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? fallback : Math.round(Number(raw));
  if (!Number.isFinite(n) || n < min || n > max) {
    console.warn(`[tx-retry] env ${name}=${String(raw)} out of range [${min}, ${max}] — clamped to ${fallback}`);
    return fallback;
  }
  return n;
}

/** Max attempts INCLUDING the first try. Default 3 — matches the existing
 *  bounded-retry precedents (admin/payout-batches, store/payouts). */
const MAX_ATTEMPTS = envInt("PAYMENT_TX_MAX_ATTEMPTS", 3, 1, 5);
/** Exponential backoff: base * 2^(attempt-1) + jitter, capped. */
const BACKOFF_BASE_MS = envInt("PAYMENT_TX_BACKOFF_BASE_MS", 25, 0, 1000);
const BACKOFF_MAX_MS = envInt("PAYMENT_TX_BACKOFF_MAX_MS", 400, 10, 5000);
/** Interactive-tx budget (F1 evidence: performance/f1-audit.md §9). Prisma
 *  defaults (maxWait 2s / timeout 5s) fire mid-convoy under concurrent
 *  confirmations: P2028/P2024 leave the caller-side tx dead while the
 *  server-side transaction may still be running — holding row locks that
 *  block the SAME ref's redelivery waves (measured: 2/12 payments needed a
 *  second convergence wave and 2 stayed stuck for all 3 waves). Giving the
 *  SAME bounded transaction a longer wait budget converts those
 *  timeout-zombies into slow-but-successful confirmations. This does NOT
 *  change isolation, pool size, or any other flow — only the transactions
 *  this wrapper owns. */
const TX_TIMEOUT_MS = envInt("PAYMENT_TX_TIMEOUT_MS", 10_000, 5_000, 30_000);
const TX_MAX_WAIT_MS = envInt("PAYMENT_TX_MAX_WAIT_MS", 10_000, 5_000, 30_000);

/** True ONLY for the transient transaction-conflict code of this driver. */
export function isTransientTxConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034";
}

/** Bounded exponential backoff with ±jitter. attempt is 1-based (the failed
 *  attempt just observed); wait happens BEFORE the next attempt. */
export function conflictBackoffMs(attempt: number): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  const jitter = Math.round(exp * 0.5 * Math.random());
  return Math.min(BACKOFF_MAX_MS, exp + jitter - Math.round(jitter / 2));
}

type TxRunner = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;

/**
 * Run `fn` inside a Serializable transaction, retrying the WHOLE transaction
 * on transient conflicts (P2034) within a bounded attempt budget.
 *
 * `runner` is injectable ONLY so tests can script conflict sequences without
 * touching the database; production callers use the default (db.$transaction).
 */
export async function withSerializableTxRetry<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  runner: TxRunner = (cb) =>
    db.$transaction(cb, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: TX_TIMEOUT_MS,
      maxWait: TX_MAX_WAIT_MS,
    })
): Promise<T> {
  let conflictAttempts = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await runner(fn);
    } catch (e) {
      if (!isTransientTxConflict(e)) throw e; // validation/business/unknown — never retried
      conflictAttempts++;
      if (attempt >= MAX_ATTEMPTS) {
        console.error(
          `[tx-retry] serialization conflict (P2034) exhausted after ${attempt} attempt(s) — failing with PAYMENT_TX_RETRY_EXHAUSTED`
        );
        throw new ApiError(
          503,
          "PAYMENT_TX_RETRY_EXHAUSTED",
          "The payment could not be confirmed due to sustained concurrent activity — the provider should retry this delivery",
          { attempts: attempt }
        );
      }
      const ms = conflictBackoffMs(attempt);
      console.warn(`[tx-retry] transient serialization conflict (P2034) — attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying whole transaction in ${ms}ms`);
      await new Promise((r) => setTimeout(r, ms));
    }
  }
  throw new Error("unreachable: retry loop must return or throw");
}
