// ============================================================================
// STRIPE MALAYSIA + CONNECT ADAPTER — R5 SCAFFOLD (Task 22-c)
// ============================================================================
// Production plug-in point 1 of src/lib/psp.ts: a real PspProvider for Stripe
// Malaysia + Connect under the Option B licensed-PSP split:
//   buyer pays ONCE (one Checkout Session = one PaymentGroup covering N
//   per-seller orders) → Stripe deducts the platform commission as the
//   application fee at payment time → each seller is settled their share →
//   Stripe's webhook confirms → the platform mirrors it in the ledger
//   (postOrderPaid T1) via the UNCHANGED webhook pipeline.
//
// SANDBOX RULES HONOURED HERE:
//   • NO Stripe SDK — raw REST over fetch only (no new dependencies).
//   • Secrets come from process.env at call time; NEVER hardcoded:
//       STRIPE_SECRET_KEY      — REST auth (sk_live_… / sk_test_…)
//       STRIPE_WEBHOOK_SECRET  — webhook signing secret (whsec_…)
//   • The adapter is registered LAZILY (PSP_LAZY_ADAPTERS in psp.ts) and is
//     selected only when isConfigured() is true. With no env keys (this
//     sandbox) it is never selected, and createCheckoutSession additionally
//     refuses to call fetch (typed PSP_NOT_CONFIGURED) — so nothing in this
//     file can execute against the network half-configured.
//   • sandboxOnly mirrors configuration: false once BOTH keys are present,
//     true while unconfigured.
//
// SPLIT MODEL (per the Option B notes on psp.ts — "destination charges;
// commission via application_fee, deducted at payment time"):
//   • transfer_group  — ALWAYS set to the canonical group ref so per-seller
//     Transfers can be reconciled under one umbrella (separate charges &
//     transfers).
//   • application_fee_amount — the commission deducted at payment time. It is
//     only valid on a DESTINATION charge, i.e. when exactly one seller with a
//     known connected account (pspAccountId) is present: then the seller's
//     account is the destination and the platform's commission is deducted
//     from their share at payment time.
//   • Multi-seller groups (or unknown connected accounts): platform-side
//     charge with transfer_group only — the commission stays on the platform
//     balance and per-seller Transfers (minus commission) are issued when the
//     webhook confirms. (Production follow-up: wire the Transfer issuance +
//     Seller.pspAccountId column; the input type already carries the hook.)
//
// WEBHOOK SCHEME (verifyWebhookSignature) — Stripe's official construction,
// implementable and testable fully offline (no network):
//   header  stripe-signature: t=<unixSeconds>,v1=<hexHmac>[,v1=…]
//   signed  payload = `${t}.${rawBody}`  (raw body EXACTLY as received)
//   expected = HMAC-SHA256(STRIPE_WEBHOOK_SECRET, signedPayload) hex
//   • every v1 candidate is compared CONSTANT-TIME (timingSafeEqual)
//   • replay window: |now − t| ≤ 5 minutes (Stripe default tolerance 300s);
//     stale deliveries report valid:false
//   • the body is parsed ONLY AFTER the compare succeeds — unverified body
//     fields are never trusted (interface contract, see psp.ts).
// ============================================================================

import { createHmac } from "node:crypto";
import {
  PspAdapterError,
  type PspCheckoutSession,
  type PspCheckoutSessionInput,
  type PspProvider,
  type PspWebhookVerdict,
} from "@/lib/psp";
import { safeEqualHex } from "@/lib/password";

const STRIPE_API_BASE = "https://api.stripe.com/v1";
/** Stripe's default webhook tolerance is 5 minutes (300 s). */
const STRIPE_REPLAY_TOLERANCE_MS = 5 * 60_000;

function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}

// ---------------------------------------------------------------------------
// REST plumbing (fetch only — no SDK)
// ---------------------------------------------------------------------------

/** Minimal shape of the Stripe responses this adapter consumes. */
type StripeErrorEnvelope = { error?: { message?: string; type?: string; code?: string } };
type StripeCheckoutSession = { id: string; url: string | null } & StripeErrorEnvelope;

/** POST a form-encoded payload to the Stripe REST API. Caller must have
 *  checked isStripeConfigured() — this re-guards defensively anyway. */
async function stripePost<T extends StripeErrorEnvelope>(
  path: string,
  params: Record<string, string>,
  idempotencyKey: string
): Promise<T> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    // Defence in depth: never hit the network half-configured.
    throw new PspAdapterError(503, "PSP_NOT_CONFIGURED", "STRIPE_SECRET_KEY is not set");
  }
  let res: Response;
  try {
    res = await fetch(`${STRIPE_API_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        // Stripe-side idempotency: one session per canonical group ref, so a
        // platform retry can never create a second charge for the checkout.
        "Idempotency-Key": idempotencyKey,
      },
      body: new URLSearchParams(params).toString(),
    });
  } catch (e) {
    throw new PspAdapterError(
      502,
      "PSP_UPSTREAM_ERROR",
      `Stripe ${path} unreachable: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  const json = (await res.json().catch(() => ({}))) as T & StripeErrorEnvelope;
  if (!res.ok || json.error) {
    throw new PspAdapterError(
      502,
      "PSP_UPSTREAM_ERROR",
      `Stripe ${path} failed (${res.status}): ${json.error?.message ?? res.statusText}`
    );
  }
  return json;
}

// ---------------------------------------------------------------------------
// Capability 1 — hosted checkout session (toggle point 2)
// ---------------------------------------------------------------------------

/** Create a Stripe Checkout Session for one PaymentGroup.
 *
 *  CONTRACT (see PspProvider.createCheckoutSession in psp.ts): the canonical
 *  internal ref (input.groupRef) is stamped onto the session in THREE places
 *  — `client_reference_id`, `metadata[nomo_ref]` and
 *  `payment_intent_data[metadata][nomo_ref]` — and echoed back as
 *  `providerRef`. PaymentGroup.ref therefore STAYS the internal ref and the
 *  webhook verifier resolves the group without any extra lookup column (the
 *  Stripe session id itself is recoverable from Stripe via that metadata).
 *
 *  Throws PspAdapterError("PSP_NOT_CONFIGURED") when the env keys are absent
 *  — it NEVER calls fetch unconfigured. */
async function createCheckoutSession(input: PspCheckoutSessionInput): Promise<PspCheckoutSession> {
  if (!isStripeConfigured()) {
    throw new PspAdapterError(
      503,
      "PSP_NOT_CONFIGURED",
      "Stripe adapter requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET"
    );
  }

  const successPath = input.successPath ?? "/";
  const cancelPath = input.cancelPath ?? "/";
  const params: Record<string, string> = {
    mode: "payment",
    // Post-payment redirects (SPA: paths on the platform origin).
    success_url: `${input.origin}${successPath}${successPath.includes("?") ? "&" : "?"}ref=${encodeURIComponent(input.groupRef)}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${input.origin}${cancelPath}${cancelPath.includes("?") ? "&" : "?"}ref=${encodeURIComponent(input.groupRef)}`,
    // Canonical-ref stamping (see contract above).
    client_reference_id: input.groupRef,
    "metadata[nomo_ref]": input.groupRef,
    "metadata[provider]": input.provider,
    // ONE line item: the whole group is a single buyer charge (Option B).
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": input.currency.toLowerCase(),
    "line_items[0][price_data][unit_amount]": String(input.amountMinor),
    "line_items[0][price_data][product_data][name]": input.description,
    // Split scaffolding — see the SPLIT MODEL note in the file header.
    "payment_intent_data[transfer_group]": input.groupRef,
    "payment_intent_data[metadata][nomo_ref]": input.groupRef,
  };
  if (input.customerEmail) params["customer_email"] = input.customerEmail;

  const destinations = input.sellers.filter((s) => typeof s.pspAccountId === "string" && s.pspAccountId);
  if (input.sellers.length === 1 && destinations.length === 1) {
    // Destination charge — the Option B note verbatim: commission via
    // application_fee, deducted at payment time from the seller's share.
    params["payment_intent_data[application_fee_amount]"] = String(input.commissionMinor);
    params["payment_intent_data[transfer_data][destination]"] = destinations[0].pspAccountId!;
  }
  // else: separate charges + transfers — commission retained on the platform
  // balance; per-seller Transfers issued on webhook confirmation (header note).

  const session = await stripePost<StripeCheckoutSession>("/checkout/sessions", params, `checkout:${input.groupRef}`);
  if (!session.url) {
    throw new PspAdapterError(502, "PSP_UPSTREAM_ERROR", "Stripe Checkout Session returned no redirect URL");
  }
  return { redirectUrl: session.url, providerRef: input.groupRef };
}

// ---------------------------------------------------------------------------
// Capability 2 — webhook signature verification (toggle point 3)
// ---------------------------------------------------------------------------

/** Stripe event envelope (only the fields this adapter consumes). */
type StripeEvent = {
  id?: string;
  type?: string;
  created?: number;
  data?: { object?: Record<string, unknown> } & StripeErrorEnvelope;
};

/** Stripe event type → the platform's internal webhook vocabulary (process.ts
 *  contract). Unmapped events return undefined (route acknowledges 200). */
function mapStripeEventType(type: string | undefined): string | undefined {
  switch (type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "payment_intent.succeeded":
      return "payment.succeeded";
    case "checkout.session.expired":
    case "payment_intent.payment_failed":
    case "charge.failed":
      return "payment.failed";
    default:
      return undefined;
  }
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Verify a Stripe webhook signature (OFFLINE-TESTABLE — no network).
 *
 *  Scheme: see the file header. Guarantees per the interface contract:
 *    • constant-time compare of every v1 candidate (safeEqualHex →
 *      timingSafeEqual);
 *    • replay window 5 minutes on the signing timestamp (valid:false when
 *      stale);
 *    • the body is parsed ONLY after the compare succeeds — every returned
 *      field is derived from authenticated material;
 *    • never throws for verification outcomes (returns { valid:false }).
 *
 *  Normalization (only when valid): providerRef = the canonical internal ref
 *  stamped at session creation (metadata[nomo_ref] → client_reference_id →
 *  object id fallback), eventType mapped into the internal vocabulary,
 *  amountMinor from amount_total (session) / amount (intent/charge), ts from
 *  the authenticated signing timestamp (epoch ms). */
async function verifyWebhookSignature(req: Request, rawBody: string): Promise<PspWebhookVerdict> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return { valid: false }; // unconfigured → nothing can verify

  // --- parse the signature HEADER (authenticated material, not the body) ---
  const header = req.headers.get("stripe-signature") ?? "";
  let tsStr: string | null = null;
  const v1Candidates: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") tsStr = value;
    else if (key === "v1" && value) v1Candidates.push(value);
  }
  if (!tsStr || v1Candidates.length === 0) return { valid: false };
  const tsSec = Number(tsStr);
  if (!Number.isFinite(tsSec) || tsSec <= 0) return { valid: false };

  // --- constant-time HMAC compare over `${t}.${rawBody}` ---
  const expected = createHmac("sha256", secret).update(`${tsStr}.${rawBody}`).digest("hex");
  let signatureOk = false;
  for (const candidate of v1Candidates) {
    // safeEqualHex: length-guarded timingSafeEqual (no timing oracle). The
    // candidate is lowercased — hex digests are case-insensitive.
    if (safeEqualHex(candidate.toLowerCase(), expected)) {
      signatureOk = true;
      break;
    }
  }
  if (!signatureOk) return { valid: false };

  // --- replay window (AFTER the signature gate: only authenticated senders
  //     can probe freshness) — stale deliveries are treated as invalid ---
  const tsMs = tsSec * 1000;
  if (Math.abs(Date.now() - tsMs) > STRIPE_REPLAY_TOLERANCE_MS) return { valid: false };

  // --- NOW the body may be trusted (authenticated by the compare above) ---
  let evt: StripeEvent;
  try {
    evt = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return { valid: false };
  }
  if (!evt || typeof evt !== "object") return { valid: false };

  const object = evt.data?.object ?? {};
  const metadata = object.metadata;
  const nomoRef =
    metadata && typeof metadata === "object" && "nomo_ref" in (metadata as Record<string, unknown>)
      ? (metadata as Record<string, unknown>)["nomo_ref"]
      : undefined;
  const providerRef =
    (typeof nomoRef === "string" && nomoRef) ||
    (typeof object.client_reference_id === "string" && object.client_reference_id) ||
    (typeof object.id === "string" ? object.id : undefined);
  const eventType = mapStripeEventType(evt.type);
  const amountMinor = numberOrNull(object.amount_total) ?? numberOrNull(object.amount);

  return {
    valid: true,
    eventId: typeof evt.id === "string" ? evt.id : undefined,
    providerRef: providerRef || undefined,
    ...(eventType ? { eventType } : {}),
    ...(amountMinor != null ? { amountMinor } : {}),
    ts: tsMs,
  };
}

// ---------------------------------------------------------------------------
// Adapter registration object (consumed by the lazy registry in psp.ts)
// ---------------------------------------------------------------------------

export const stripeMyAdapter: PspProvider = {
  id: "stripe_my",
  // false once BOTH env keys are present, true while unconfigured — a real
  // PSP may never be treated as a sandbox-only rail.
  get sandboxOnly() {
    return !isStripeConfigured();
  },
  label: "Stripe Malaysia + Connect",
  isConfigured: isStripeConfigured,
  createCheckoutSession,
  verifyWebhookSignature,
};
