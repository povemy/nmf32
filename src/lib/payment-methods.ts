// ============================================================================
// CHECKOUT PAYMENT METHODS — single source of truth (F-14 remediation).
// ----------------------------------------------------------------------------
// Before this module the buyer-facing method list lived in TWO places that
// had already drifted apart: the server validated against
// KNOWN_PROVIDERS in app/api/checkout/create/route.ts (5 ids, incl.
// fpx_curlec) while the shopper checkout UI hardcoded 4 — a buyer could
// never select a method the server would have accepted, and neither list
// was the admin-visible one. This module is the ONE list both sides share.
//
// CLIENT-SAFE: no imports from lib/db, lib/api or any server module — this
// file may be imported from client components (same rule as the psp.ts
// adapter-contract block).
//
// NOTE: this is the CHECKOUT method list (PaymentGroup.provider values),
// NOT the PSP adapter registry (PSP_PROVIDERS in lib/psp.ts — the
// sandbox-mock / future-adapter layer). Keep the two concepts separate.
// ============================================================================

export type CheckoutPaymentMethodId =
  | "fpx_toyyibpay"
  | "fpx_curlec"
  | "tng"
  | "grabpay"
  | "card_stripe";

export type CheckoutPaymentMethod = {
  id: CheckoutPaymentMethodId;
  /** Buyer-facing label (pay-method radio on checkout). */
  label: string;
};

/** The buyer-selectable payment methods, in display order. */
export const CHECKOUT_PAYMENT_METHODS: CheckoutPaymentMethod[] = [
  { id: "fpx_toyyibpay", label: "FPX Online Banking" },
  { id: "fpx_curlec", label: "FPX Online Banking (Curlec)" },
  { id: "tng", label: "Touch 'n Go eWallet" },
  { id: "grabpay", label: "GrabPay" },
  { id: "card_stripe", label: "Card (Stripe MY)" },
];

/** Ids the checkout create route accepts (validation lives server-side). */
export const KNOWN_PAYMENT_METHODS: string[] = CHECKOUT_PAYMENT_METHODS.map((m) => m.id);

/** Resolve a buyer-facing label for a stored provider id (order status,
 *  payment screens). Unknown ids return undefined — callers fall back to
 *  the raw id so data is never hidden. */
export function paymentMethodLabel(id: string): string | undefined {
  return CHECKOUT_PAYMENT_METHODS.find((m) => m.id === id)?.label;
}
