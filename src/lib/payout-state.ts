// ============================================================================
// FIN-2a — Payout state machine (single source of truth)
// Every payout transition in the system MUST be validated against this map.
// The `updateMany` conditional claim (see payout mutation routes) remains the
// ACTUAL concurrency guard — this module makes illegal transitions readable
// (409 STATE_INVALID with from → to) and keeps every route consistent.
//
// Transition rationale:
//   requested  → processing | rejected   (admin approve / reject of a seller request)
//   processing → paid | failed           (manual mark-paid / fail; future PSP webhook)
//   paid       → returned | reversed     (FUTURE, webhook-only — no route posts these yet)
//   failed     → processing              (bounded manual retry of a failed payout)
//   rejected / returned / reversed       (terminal)
// ============================================================================
import { ApiError } from "@/lib/api";

export const PAYOUT_STATUSES = ["requested", "processing", "paid", "failed", "rejected", "returned", "reversed"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const PAYOUT_TRANSITIONS: Record<PayoutStatus, PayoutStatus[]> = {
  requested: ["processing", "rejected"],
  processing: ["paid", "failed"],
  paid: ["returned", "reversed"],
  failed: ["processing"],
  rejected: [],
  returned: [],
  reversed: [],
};

/** Is `s` a known payout status? */
export function isPayoutStatus(s: string): s is PayoutStatus {
  return (PAYOUT_STATUSES as readonly string[]).includes(s);
}

/** Pure check — does the state machine allow from → to? Unknown statuses never transition. */
export function canTransition(from: string, to: string): boolean {
  if (!isPayoutStatus(from) || !isPayoutStatus(to)) return false;
  return PAYOUT_TRANSITIONS[from].includes(to);
}

/** Guard — throws 409 STATE_INVALID with a readable from → to message. */
export function assertTransition(from: string, to: string): void {
  if (canTransition(from, to)) return;
  const allowed = isPayoutStatus(from) ? PAYOUT_TRANSITIONS[from] : [];
  const hint = isPayoutStatus(from)
    ? allowed.length
      ? `allowed from "${from}": ${allowed.join(", ")}`
      : `"${from}" is terminal — no transitions allowed`
    : `unknown payout status "${from}"`;
  throw new ApiError(409, "STATE_INVALID", `Payout state transition ${from} → ${to} is not allowed (${hint})`);
}
