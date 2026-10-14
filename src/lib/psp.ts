// ============================================================================
// PSP PROVIDER LAYER — OPTION B (approved by user)
// ============================================================================
// PAYMENT MODEL DECISION: SHOPMESH operates as a marketplace facilitator under
// a "licensed PSP split" model — NOT self-managed escrow:
//
//   Buyer pays ONCE per checkout → a licensed Payment Service Provider
//   (production candidates: Stripe Malaysia + Connect, Curlec, iPay88 — all
//   riding BNM-registered acquiring rails) collects the funds, deducts the
//   platform's application fee (commission) at payment time, and settles each
//   seller their share.
//
//   SHOPMESH NEVER TAKES CUSTODY OF BUYER FUNDS. This keeps the platform
//   outside BNM's Merchant Acquiring Services registration scope (FSA 2013
//   s.17), e-money issuance, and money-broking licensing.
//
// IN THIS SANDBOX the only provider is "mock" — it simulates the PSP rails:
//   • a PaymentGroup IS one PSP checkout session (one buyer charge covering
//     N per-seller orders)
//   • POST /api/checkout/payments/[ref]/simulate plays the PSP: it signs and
//     emits the exact webhook a real gateway would send
//   • the ledger T1 posting (lib/ledger.ts postOrderPaid) is the platform's
//     ACCOUNTING MIRROR of the PSP's per-seller balances — bookkeeping for
//     seller dashboards and the payout pipeline, not custody
//
// PRODUCTION PLUG-IN POINTS (scaffold — do not remove; swap is config-level):
//   1. implement `PspProvider` below for the chosen gateway and register it
//      in PSP_PROVIDERS
//   2. replace the simulate endpoint with the provider's hosted
//      checkout/redirect authorization flow
//   3. point /api/webhooks/payments/[provider] at the real gateway webhook
//      (per-provider signature verification in webhooks/payments/process.ts)
//   4. PaymentGroup.provider already stores the provider id per checkout, and
//      the commission rate (CommissionSetting) becomes the PSP application
//      fee — rate model discussion deferred per user decision
// ============================================================================

export type PspProviderId = string;

/** Minimal surface a production PSP adapter must satisfy. Kept as scaffold:
 *  the mock provider conforms today so the production swap is config-level. */
export interface PspProvider {
  id: PspProviderId;
  /** True when this provider may only be used outside production. */
  sandboxOnly: boolean;
  /** Human label shown on the pay screen. */
  label: string;
}

export const PSP_PROVIDERS: Record<PspProviderId, PspProvider> = {
  // SANDBOX mock PSP — simulates the licensed-gateway rails end-to-end.
  mock: { id: "mock", sandboxOnly: true, label: "MeshPay Checkout (sandbox)" },

  // PRODUCTION candidates (Option B) — adapters to be implemented once the
  // business is registered with SSM and a PSP contract is signed.
  // DO NOT REMOVE these notes:
  //   stripe_my — Stripe Malaysia + Connect (destination charges; commission
  //               via application_fee, deducted at payment time)
  //   curlec    — Curlec marketplace routing (strong FPX / DuitNow coverage)
  //   ipay88    — iPay88 marketplace product (largest local method coverage)
};

export function resolvePspProvider(id: string | null | undefined): PspProvider {
  return PSP_PROVIDERS[id ?? "mock"] ?? PSP_PROVIDERS.mock;
}
