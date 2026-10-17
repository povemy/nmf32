// ============================================================================
// PSP PROVIDER LAYER — OPTION B (approved by user)
// ============================================================================
// PAYMENT MODEL DECISION: NOMOFEE operates as a marketplace facilitator under
// a "licensed PSP split" model — NOT self-managed escrow:
//
//   Buyer pays ONCE per checkout → a licensed Payment Service Provider
//   (production candidates: Stripe Malaysia + Connect, Curlec, iPay88 — all
//   riding BNM-registered acquiring rails) collects the funds, deducts the
//   platform's application fee (commission) at payment time, and settles each
//   seller their share.
//
//   NOMOFEE NEVER TAKES CUSTODY OF BUYER FUNDS. This keeps the platform
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
  mock: { id: "mock", sandboxOnly: true, label: "NomoPay Checkout (sandbox)" },

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

// ---------------------------------------------------------------------------
// SPLIT-SETTLEMENT SCAFFOLD (Task 17-③, dormant)
// ---------------------------------------------------------------------------
// When a production PSP is contracted, its adapter implements PspProvider and
// the split flow becomes: buyer pays → PSP deducts the application fee
// (commission) at payment time → PSP settles each seller sub-account → the
// gateway webhook fires → the platform mirrors the settlement in the ledger
// (postGatewaySettlement today; per-seller split confirmations later) and
// refreshes wallet caches, so wallet/payout numbers auto-update on release.
// Until then auto_settle stays FALSE and nothing subscribes to the webhook.

export type PspSplitCandidate = {
  id: PspProviderId;
  label: string;
  /** Short capability note for the admin scaffold card. */
  note: string;
  /** true while no adapter exists yet. */
  awaitingAdapter: boolean;
};

export const PSP_SPLIT_CANDIDATES: PspSplitCandidate[] = [
  { id: "mock", label: "NomoPay Checkout (sandbox)", note: "Sandbox rails — simulate endpoint plays the PSP and emits the real webhook shape", awaitingAdapter: false },
  { id: "stripe_my", label: "Stripe Malaysia + Connect", note: "Destination charges; commission via application_fee deducted at payment time", awaitingAdapter: true },
  { id: "curlec", label: "Curlec Marketplace", note: "Strong FPX / DuitNow coverage; marketplace routing with split settlements", awaitingAdapter: true },
  { id: "ipay88", label: "iPay88 Marketplace", note: "Largest local method coverage (FPX, e-wallets, cards)", awaitingAdapter: true },
];

/** Settings keys backing the dormant auto-settle toggle (admin Commission → Reports tab). */
export const PSP_SPLIT_SETTING_KEYS = {
  autoSettle: "psp.split.auto_settle",
  provider: "psp.split.provider",
} as const;
