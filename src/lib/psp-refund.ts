// ============================================================================
// PSP REFUND / LATE-PAYMENT RECONCILIATION (mission: final operational gaps,
// Phase 2).
// ----------------------------------------------------------------------------
// WHY THIS EXISTS: when a payment.succeeded webhook arrives AFTER the expiry
// sweep released a group's stock, the platform refuses it with 409
// GROUP_EXPIRED (process.ts) — no ledger posting, no order resurrection. For
// the SANDBOX mock PSP no real funds exist. For a REAL PSP (Stripe MY
// destination charges, Curlec, iPay88 — see lib/psp.ts Option B) the buyer's
// funds are ALREADY CAPTURED at the provider by the time that verified event
// arrives. The 409 protects the order/inventory transition — it does NOT
// return the captured funds. This module is the durable, idempotent bridge:
//
//   obligation     PaymentReconciliation row (DB) — recorded at refusal time
//   execution      RefundAdapter.executeRefund — OUTSIDE any DB transaction
//   confirmation   the provider's AUTHORITATIVE record (PspRefundRecord for the
//                  mock rails; the PSP's own API state in production) — never
//                  inferred from "an HTTP request was sent"
//
// STATUS MODEL (distinguishable outcomes per the mission):
//   requested  — obligation recorded; no completed provider attempt yet
//   processing — durable attempt intent written BEFORE the provider call
//   succeeded  — refund confirmed from the provider's authoritative record
//   failed     — provider REJECTED the refund (permanent; operator item)
//   unknown    — provider outcome pending / timed out; re-checked next tick
//
// PROVIDER IDEMPOTENCY: every execution carries a stable idempotencyKey
// (`recon:{caseId}`). The provider side keeps ONE refund per key — a retry
// with the same key returns the existing outcome instead of refunding twice.
// Crash-before-outcome-persistence recovers the same way on the next tick.
//
// HONEST LIMITS: only the sandbox `mock` adapter exists today. Real PSP
// adapters (stripe_my / curlec / ipay88) are registration-time work — until
// one exists, their cases stay `requested` and are surfaced to operators via
// /api/admin/payment-reconciliation + the scheduler's REFUND_STUCK alerts +
// docs/late-payment-refund-runbook.md. No successful refund is ever simulated
// for a provider without a real, confirmed execution path.
// ============================================================================
import { db } from "./db";
import { parseMaybeJson } from "@/app/api/admin/_helpers";
import { resolvePspProvider } from "./psp";

// ---------------------------------------------------------------------------
// Statuses + settings keys + knobs
// ---------------------------------------------------------------------------
export const RECON_STATUSES = ["requested", "processing", "succeeded", "failed", "unknown"] as const;
export type ReconStatus = (typeof RECON_STATUSES)[number];

/** Mock-PSP refund behaviour control (sandbox test rails; Setting surface is
 *  admin-gated). Values: "succeed" (default/absent) | "reject" | "timeout". */
export const MOCK_REFUND_BEHAVIOR_KEY = "psp.mock.refund.behavior";

/** One-shot fault flag consumed by the refund tick (sandbox test rails):
 *  "crash-after-provider" — after a successful provider call, before the
 *  outcome is persisted. Models "refund succeeded but the worker crashed
 *  before saving the outcome". */
export const RECON_FAULT_KEY = "recon.fault";
export const RECON_FAULT_CRASH_AFTER_PROVIDER = "crash-after-provider";

/** Stable per-case provider idempotency key. */
export function refundIdempotencyKey(caseId: string): string {
  return `recon:${caseId}`;
}

// ---------------------------------------------------------------------------
// Obligation recording (called from process.ts at BOTH GROUP_EXPIRED sites)
// ---------------------------------------------------------------------------

/**
 * Record the durable refund obligation for a late payment on an expired
 * group. Idempotent: duplicate webhooks converge on the unique
 * (provider, providerRef) row; an existing case is never regressed (update is
 * a no-op) so retries cannot duplicate the obligation or reset an in-flight
 * refund. `amountMinor` MUST be the VERIFIED webhook amount — that is what
 * the provider captured and must return — with any divergence from the group
 * total recorded for operator verification. Throws on DB failure so the
 * webhook answers 5xx and the PSP redelivery retries the recording.
 */
export async function recordLatePaymentObligation(input: {
  provider: string;
  providerRef: string;
  providerPaymentId?: string | null;
  amountMinor: number;
  groupTotalMinor: number;
  currency: string;
}): Promise<void> {
  await db.paymentReconciliation.upsert({
    where: { provider_providerRef: { provider: input.provider, providerRef: input.providerRef } },
    create: {
      provider: input.provider,
      providerRef: input.providerRef,
      providerPaymentId: input.providerPaymentId ?? null,
      amountMinor: input.amountMinor,
      currency: input.currency,
      reason: "late_payment_after_expiry",
      resolutionNote:
        input.amountMinor !== input.groupTotalMinor
          ? `Webhook amount ${input.amountMinor} differs from group total ${input.groupTotalMinor} — operator must verify the captured amount with the provider before refunding.`
          : null,
    },
    update: {}, // never regress an in-flight/completed case on redelivery
  });
}

// ---------------------------------------------------------------------------
// Refund adapter surface (production PSPs implement this; mock conforms today)
// ---------------------------------------------------------------------------
export type RefundExecution = {
  refundId: string;
  status: "succeeded" | "failed" | "pending";
  detail?: string;
};

export interface RefundAdapter {
  id: string;
  /** True when this adapter may only run outside production (sandbox rails). */
  sandboxOnly: boolean;
  /** Execute (or idempotently re-execute) the refund. Same idempotencyKey ⇒
   *  the provider returns the SAME refund's outcome, never a second refund. */
  executeRefund(input: {
    idempotencyKey: string;
    providerRef: string;
    providerPaymentId?: string | null;
    amountMinor: number;
    currency: string;
  }): Promise<RefundExecution>;
  /** The provider's AUTHORITATIVE status for a refund executed under this
   *  key (null when the provider has no record of one). Pure query — must
   *  never advance provider state. */
  getRefundStatus(input: { idempotencyKey: string }): Promise<RefundExecution | null>;
}

// ---------------------------------------------------------------------------
// Sandbox mock adapter — plays the provider-side refund rails. Its durable
// state (PspRefundRecord) is what "the provider's authoritative record" means
// in this sandbox: completion is read from it, never assumed from a sent call.
// ---------------------------------------------------------------------------
async function mockBehavior(): Promise<"succeed" | "reject" | "timeout"> {
  const row = await db.setting.findUnique({ where: { key: MOCK_REFUND_BEHAVIOR_KEY } });
  const v = parseMaybeJson<string | null>(row?.valueJson, null);
  return v === "reject" || v === "timeout" ? v : "succeed";
}

function newMockRefundId(): string {
  return `rfnd_mock_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const mockAdapter: RefundAdapter = {
  id: "mock",
  sandboxOnly: true,
  async executeRefund(input) {
    const behavior = await mockBehavior();
    const existing = await db.pspRefundRecord.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      // Provider idempotency: same key ⇒ same refund. A PENDING refund may
      // legitimately complete later — when the current behaviour says the
      // provider has progressed, the re-invocation returns its new state.
      if (existing.status === "pending" && behavior === "succeed") {
        const done = await db.pspRefundRecord.update({
          where: { id: existing.id },
          data: { status: "succeeded", detailJson: null },
        });
        return { refundId: done.refundId, status: "succeeded" };
      }
      return { refundId: existing.refundId, status: existing.status as RefundExecution["status"], detail: existing.detailJson ?? undefined };
    }
    const status: RefundExecution["status"] =
      behavior === "reject" ? "failed" : behavior === "timeout" ? "pending" : "succeeded";
    const rec = await db.pspRefundRecord.create({
      data: {
        provider: "mock",
        idempotencyKey: input.idempotencyKey,
        providerRef: input.providerRef,
        refundId: newMockRefundId(),
        amountMinor: input.amountMinor,
        currency: input.currency,
        status,
        detailJson: status === "failed" ? "refund rejected by provider (sandbox behaviour=reject)" : null,
      },
    });
    return { refundId: rec.refundId, status, detail: rec.detailJson ?? undefined };
  },
  async getRefundStatus({ idempotencyKey }) {
    const rec = await db.pspRefundRecord.findUnique({ where: { idempotencyKey } });
    if (!rec) return null;
    return { refundId: rec.refundId, status: rec.status as RefundExecution["status"], detail: rec.detailJson ?? undefined };
  },
};

/** Registry — production adapters register here at integration time. */
export const REFUND_ADAPTERS: Record<string, RefundAdapter> = {
  mock: mockAdapter,
};

/** Resolve the refund adapter for a provider id, mirroring the PAYMENT-side
 *  provider resolution (lib/psp.ts): alias/unknown ids resolve to the sandbox
 *  mock — the same rails that processed the payment process its refund. The
 *  production guard (sandboxOnly + NODE_ENV + psp.mock.enabled) still applies
 *  at execution time, so an unregistered id can never refund real money in
 *  production. Returns null only when no adapter exists at all. */
export function resolveRefundAdapter(providerId: string): RefundAdapter | null {
  const direct = REFUND_ADAPTERS[providerId];
  if (direct) return direct;
  const resolved = resolvePspProvider(providerId);
  return REFUND_ADAPTERS[resolved.id] ?? null;
}

// ---------------------------------------------------------------------------
// One-shot fault flag (sandbox test rails) — see RECON_FAULT_KEY above.
// ---------------------------------------------------------------------------

/** Read + CLEAR the one-shot fault flag (returns null when unset). */
export async function consumeReconFault(): Promise<string | null> {
  const row = await db.setting.findUnique({ where: { key: RECON_FAULT_KEY } });
  const v = parseMaybeJson<string | null>(row?.valueJson, null);
  if (v) {
    await db.setting.delete({ where: { key: RECON_FAULT_KEY } }).catch(() => undefined);
  }
  return v;
}
