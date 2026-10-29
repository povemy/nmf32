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

/** F-03 remediation (TS2305s): the adapter contract types the Stripe-MY
 *  scaffold (src/lib/psp-adapters/stripe-my.ts) was written against. They were
 *  referenced but never defined — now they live HERE (psp.ts) so the whole PSP
 *  layer shares one contract surface. NOTE: nothing in this block may import
 *  Prisma or lib/api — this module is importable from client surfaces. */

/** Error thrown by a PSP adapter on upstream/configuration failure. Deliberately
 *  NOT ApiError (lib/api imports Prisma + Next server machinery): routes catch
 *  it and map (status, code, message) onto the API envelope. */
export class PspAdapterError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "PspAdapterError";
    this.status = status;
    this.code = code;
  }
}

/** Input to a provider's hosted-checkout session creation (one PaymentGroup). */
export type PspCheckoutSessionInput = {
  /** Canonical internal ref (PaymentGroup.ref) — stamped onto the session. */
  groupRef: string;
  provider: PspProviderId;
  /** App origin for success/cancel redirects. */
  origin: string;
  successPath?: string;
  cancelPath?: string;
  currency: string;
  amountMinor: number;
  description: string;
  customerEmail?: string;
  /** Per-seller settlement targets (pspAccountId = connected account id). */
  sellers: { pspAccountId?: string | null }[];
  /** Platform commission deducted at payment time (Option B application fee). */
  commissionMinor: number;
};

/** Result of a provider's hosted-checkout session creation. */
export type PspCheckoutSession = {
  redirectUrl: string;
  providerRef: string;
};

/** Result of a provider's webhook-signature verification. valid:false ⇒ the
 *  delivery is unauthenticated and MUST be discarded (never throws). */
export type PspWebhookVerdict = {
  valid: boolean;
  eventId?: string;
  providerRef?: string;
  eventType?: string;
  amountMinor?: number;
  /** Authenticated event timestamp (epoch ms) for replay-window checks. */
  ts?: number;
};

/** Minimal surface a production PSP adapter must satisfy. Kept as scaffold:
 *  the mock provider conforms today so the production swap is config-level.
 *  The adapter capabilities are OPTIONAL — the sandbox mock provider needs
 *  none of them (simulate plays the PSP), while a production adapter
 *  registers all three. */
export interface PspProvider {
  id: PspProviderId;
  /** True when this provider may only be used outside production. */
  sandboxOnly: boolean;
  /** Human label shown on the pay screen. */
  label: string;
  /** True when the adapter's env keys are present (never selected otherwise). */
  isConfigured?: () => boolean;
  /** Create a hosted checkout session for one PaymentGroup. */
  createCheckoutSession?: (input: PspCheckoutSessionInput) => Promise<PspCheckoutSession>;
  /** Verify a provider webhook delivery (constant-time, replay-window aware). */
  verifyWebhookSignature?: (req: Request, rawBody: string) => Promise<PspWebhookVerdict>;
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
// PAYOUT LIFECYCLE (FIN-2b) — how a payout moves and what mirrors it:
//
//   requested ──approve──▶ processing ──provider confirms──▶ paid
//       │                                    │
//       └─reject──▶ rejected                 └─provider reports failure──▶ failed
//
//   • Status transitions are owned by lib/payout-state.ts (FIN-2-a) — admin
//     routes (approve/reject/mark-paid/fail) and the webhook processor share
//     the same assertTransition guard.
//   • Money: T3 posts at approve (seller payable → payout clearing), T4 at
//     "paid" (clearing → bank), T4f at "failed" (clearing → back to seller).
//   • Inbound PSP confirmation arrives as a SIGNED webhook event
//     (payout.succeeded / payout.failed on /api/webhooks/payments/[provider],
//     providerRef = Payout.referenceNo or Payout.providerRef). In the sandbox
//     the mock PSP's completion evidence is emitted by
//     POST /api/webhooks/payments/payout-simulate.
//   • The admin sync/sweep endpoints (FIN-2-a) are the RECONCILIATION surface:
//     read-only wallet-truth/statement verification + stuck-payout alerting —
//     they never flip status or move money by themselves.
// ---------------------------------------------------------------------------

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

/** Setting that gates the SANDBOX mock-PSP endpoints (payment simulate + payout
 *  simulate). FIN-2b contract: in production the simulate routes refuse (404)
 *  UNLESS an operator explicitly set Setting `psp.mock.enabled` = true — the
 *  default (absent setting) is TRUE so demo/preview deployments keep working,
 *  while real production deployments disable the mock rails with one setting.
 *  In production the simulate endpoint must be replaced by the provider's
 *  hosted checkout redirect (see PRODUCTION PLUG-IN POINTS above). */
export const PSP_MOCK_ENABLED_SETTING_KEY = "psp.mock.enabled";

/** Whether the sandbox mock-PSP surface may run. Sandbox (NODE_ENV !==
 *  "production"): always true. Production: ONLY when Setting
 *  psp.mock.enabled is EXPLICITLY true — F-13 remediation makes the default
 *  FAIL CLOSED: a missing or malformed Setting row now denies the mock rails
 *  in production (previously defaulted open). An operator must consciously
 *  opt a demo deployment back in by writing the row.
 *  NOTE: db is imported lazily (inside the function) so this module stays
 *  server-light and importable from client surfaces that only want the
 *  provider registry — Prisma must never enter the client bundle. */
export async function mockPspAllowed(): Promise<boolean> {
  if (process.env.NODE_ENV !== "production") return true;
  const { db } = await import("./db");
  const { parseJson } = await import("./json");
  const row = await db.setting.findUnique({ where: { key: PSP_MOCK_ENABLED_SETTING_KEY } });
  // Strict `=== true`: missing row → fallback false; malformed JSON → false;
  // truthy non-boolean (e.g. "1", `"true"` string) → false. Fail closed.
  return parseJson<boolean>(row?.valueJson, false) === true;
}
