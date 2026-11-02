// ============================================================================
// PaymentIntent claimable-state whitelist (V-F1 regression seam).
//
// The EXACT set of PaymentIntent statuses from which a webhook "success" event
// may CLAIM the intent into "succeeded" (and, symmetrically, from which a
// "failed" event may write "failed"). Introduced after the stage-gate
// verification found the legacy claim used `status: { not: "succeeded" }`,
// which ADMITTED "refunded" intents: a recovery re-feed (admin payouts sweep
// with recovery:true) or a re-simulate of a fully-refunded legacy order could
// re-claim the intent and flip the ORDER from `refunded` back to `paid`
// (status-history corruption + a false success envelope — no double money,
// the T1 ledger dedupKey replays instead of posting).
//
// Rules encoded here:
//   • "requires_payment" / "failed"        → claimable (the normal lifecycle).
//   • "succeeded"                          → NOT claimable (idempotent duplicate).
//   • "refunded" (full refund, see
//     admin/refunds/[id]/process)           → NOT claimable — money already
//     returned; the order must stay `refunded` FOREVER for that payment.
//   • anything else (future/sweep states)  → NOT claimable (fail closed).
//
// The PaymentGroup path already enforces the equivalent whitelist on member
// ORDER rows (all must still be `payment_pending` inside the Serializable
// claim tx); this constant gives the legacy single-intent path the same
// strictness at the INTENT level.
// ============================================================================
export const INTENT_SUCCESS_CLAIMABLE_STATUSES = ["requires_payment", "failed"] as const;

export type IntentSuccessClaimableStatus = (typeof INTENT_SUCCESS_CLAIMABLE_STATUSES)[number];

/** Is a PaymentIntent in a state from which a success event may claim it?
 *  Fail-closed: only the explicit whitelist above returns true. */
export function isIntentSuccessClaimable(status: string): boolean {
  return (INTENT_SUCCESS_CLAIMABLE_STATUSES as readonly string[]).includes(status);
}
