import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { toJson } from "@/lib/json";
import { assertCronAuth } from "@/lib/cron-auth";
import { mockPspAllowed } from "@/lib/psp";
import {
  resolveRefundAdapter,
  refundIdempotencyKey,
  consumeReconFault,
  RECON_FAULT_CRASH_AFTER_PROVIDER,
  RECON_STATUSES,
} from "@/lib/psp-refund";

export const dynamic = "force-dynamic";

// ============================================================================
// REFUND-RECONCILE SWEEP (cron tick) — late-payment refund execution.
// ----------------------------------------------------------------------------
// Processes PaymentReconciliation cases (obligations recorded when a
// payment.succeeded arrived for an already-expired group — see
// lib/psp-refund.ts). Follows the same durable-tick pattern as the F3 expiry
// sweep: this route is the worker TICK (the recurring invocation is
// mini-services/expiry-scheduler, port 3005); every run records its outcome
// in Setting `cron.refund_reconcile.last`.
//
// CONTRACT (mission: final operational gaps, Phase 2 step 3):
//   • Provider calls happen OUTSIDE any DB transaction; the only writes are
//     the case's own state transitions.
//   • A durable attempt intent (`processing` + attempts+1 + lastAttemptAt) is
//     written BEFORE the provider call — a crash mid-flight can never lose
//     the obligation or double-refund (the provider idempotencyKey is stable
//     per case: `recon:{caseId}`).
//   • Completion is confirmed ONLY from the provider's authoritative record
//     (adapter.getRefundStatus / the idempotent executeRefund result) — never
//     inferred from a request having been sent.
//   • Transient failures retry with bounded backoff and a bounded attempt
//     cap; after the cap the case stays visible as exhausted (operator item).
//   • Permanent provider rejection → status `failed`, stays visible for
//     operator action (runbook: docs/late-payment-refund-runbook.md).
//   • Providers WITHOUT an adapter (real PSPs not yet integrated) are skipped
//     untouched and reported as awaitingOperator — no simulated refunds.
//   • Bounded: batch of 25 cases per tick; per-case failures never abort the
//     run; the route itself is cron-auth guarded (fail-closed in production).
// ============================================================================

const BATCH = 25;
const MAX_ATTEMPTS = 8;
const BACKOFF_MS = Number(process.env.REFUND_BACKOFF_MS ?? 15_000);
const LAST_RUN_KEY = "cron.refund_reconcile.last";
const OPEN_STATUSES = ["requested", "processing", "unknown"] as const;

export const POST = handle(async (req: Request) => {
  const auth = assertCronAuth(req);
  const t0 = performance.now();
  const stats = {
    examined: 0,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    unknown: 0,
    skippedNoAdapter: 0,
    skippedSandboxDisabled: 0,
    skippedBackoff: 0,
    skippedExhausted: 0,
    transientErrors: 0,
    faultsApplied: 0,
  };

  const dueBefore = new Date(Date.now() - BACKOFF_MS);
  const candidates = await db.paymentReconciliation.findMany({
    where: {
      status: { in: [...OPEN_STATUSES] },
      OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: dueBefore } }],
    },
    orderBy: { updatedAt: "asc" },
    take: BATCH,
  });
  stats.examined = candidates.length;

  for (const c of candidates) {
    const adapter = resolveRefundAdapter(c.provider);
    if (!adapter) {
      stats.skippedNoAdapter++;
      continue; // obligation stays `requested` — surfaced via GET/admin as awaitingOperator
    }
    if (adapter.sandboxOnly && process.env.NODE_ENV === "production" && !(await mockPspAllowed())) {
      stats.skippedSandboxDisabled++;
      continue; // mock rails disabled in production — operator runbook applies
    }
    if (c.attempts >= MAX_ATTEMPTS) {
      stats.skippedExhausted++;
      continue; // bounded retries exhausted — visible operator item, never silently dropped
    }
    try {
      // 1) Durable attempt intent BEFORE the provider call.
      await db.paymentReconciliation.update({
        where: { id: c.id },
        data: { status: "processing", attempts: { increment: 1 }, lastAttemptAt: new Date(), lastError: null },
      });
      stats.attempted++;

      // 2) Provider interaction — OUTSIDE any transaction, idempotent by key.
      const key = refundIdempotencyKey(c.id);
      let outcome;
      if (c.providerRefundId) {
        // A previous attempt reached the provider — read the AUTHORITATIVE
        // status instead of assuming anything about the earlier request.
        outcome = await adapter.getRefundStatus({ idempotencyKey: key });
      }
      if (!outcome || outcome.status === "pending") {
        // No provider record, or the provider is STILL PENDING (timeout /
        // unknown outcome) — (re-)execute idempotently: the same key means
        // the provider returns the SAME refund's current outcome, never a
        // second refund. This is also the recovery path for a crash between
        // provider execution and outcome persistence.
        outcome = await adapter.executeRefund({
          idempotencyKey: key,
          providerRef: c.providerRef,
          providerPaymentId: c.providerPaymentId,
          amountMinor: c.amountMinor,
          currency: c.currency,
        });
      }

      // 3) One-shot injected fault: crash AFTER the provider call, BEFORE the
      //    outcome is persisted (sandbox test rails — models a worker crash).
      const fault = await consumeReconFault();
      if (fault === RECON_FAULT_CRASH_AFTER_PROVIDER) {
        stats.faultsApplied++;
        throw new Error("simulated crash after provider call, before outcome persistence (fault injection)");
      }

      // 4) Persist the outcome FROM the provider's authoritative answer.
      if (outcome.status === "succeeded") {
        await db.paymentReconciliation.update({
          where: { id: c.id },
          data: {
            status: "succeeded",
            providerRefundId: outcome.refundId,
            lastError: null,
            resolutionNote: `Refunded via provider (refund ${outcome.refundId}) — confirmed from the provider's authoritative record`,
          },
        });
        stats.succeeded++;
      } else if (outcome.status === "failed") {
        await db.paymentReconciliation.update({
          where: { id: c.id },
          data: {
            status: "failed",
            providerRefundId: outcome.refundId,
            lastError: outcome.detail ?? "provider rejected the refund",
            resolutionNote: "Provider REJECTED the refund — permanent; operator action required (docs/late-payment-refund-runbook.md)",
          },
        });
        stats.failed++;
      } else {
        await db.paymentReconciliation.update({
          where: { id: c.id },
          data: {
            status: "unknown",
            providerRefundId: outcome.refundId,
            resolutionNote: "Provider outcome pending/unknown (timeout) — re-checked from the provider's authoritative status on a later tick",
          },
        });
        stats.unknown++;
      }
    } catch (e) {
      // Transient (adapter/network/DB fault or the injected crash): the
      // obligation survives; back to the open set, retried after backoff.
      stats.transientErrors++;
      const msg = e instanceof Error ? e.message : String(e);
      await db.paymentReconciliation
        .update({
          where: { id: c.id },
          data: { status: c.providerRefundId ? "unknown" : "requested", lastError: msg },
        })
        .catch(() => undefined);
    }
  }

  const outcome = {
    ...stats,
    at: new Date().toISOString(),
    durationMs: Math.round(performance.now() - t0),
    backoffMs: BACKOFF_MS,
    maxAttempts: MAX_ATTEMPTS,
    batchLimit: BATCH,
    auth: auth.mode,
  };
  await db.setting.upsert({
    where: { key: LAST_RUN_KEY },
    create: { key: LAST_RUN_KEY, valueJson: toJson(outcome), description: "Last refund-reconcile tick outcome (late-payment recovery)" },
    update: { valueJson: toJson(outcome) },
  });
  return ok(outcome);
});

// GET — operator observability without triggering a tick (cron-auth guarded).
export const GET = handle(async (req: Request) => {
  const auth = assertCronAuth(req);
  const [byStatus, lastSetting, oldestOpen, openRequested] = await Promise.all([
    db.paymentReconciliation.groupBy({ by: ["status"], _count: { _all: true } }),
    db.setting.findUnique({ where: { key: LAST_RUN_KEY } }),
    db.paymentReconciliation.findFirst({
      where: { status: { in: [...OPEN_STATUSES] } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true, provider: true },
    }),
    db.paymentReconciliation.findMany({
      where: { status: "requested" },
      select: { provider: true },
    }),
  ]);
  // Provider-alias aware: an id is only "awaiting operator" when NO adapter
  // resolves for it (incl. the mock fallback — same rails as the payment side).
  const awaitingOperator = openRequested.filter((c) => !resolveRefundAdapter(c.provider)).length;
  const counts = Object.fromEntries(RECON_STATUSES.map((s) => [s, 0])) as Record<string, number>;
  for (const row of byStatus) counts[row.status] = row._count._all;
  return ok({
    counts,
    oldestOpenCase: oldestOpen ? { createdAt: oldestOpen.createdAt.toISOString(), provider: oldestOpen.provider } : null,
    awaitingOperator, // providers with no refund adapter at all — runbook applies
    lastRun: lastSetting ? JSON.parse(lastSetting.valueJson) : null,
    auth: auth.mode,
    statuses: RECON_STATUSES,
  });
});
