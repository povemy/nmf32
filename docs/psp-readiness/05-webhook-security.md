# 05 — Webhook Security (current implementation)

**Core files:** `src/app/api/webhooks/payments/[provider]/route.ts` (ingress),
`src/app/api/webhooks/payments/process.ts` (verification + processing).
This document describes the **generic scheme implemented today for the mock rails** —
see §6 for what a real provider changes.

## 1. Signature scheme (exact formula)

```
MAC   = HMAC-SHA256( secret,  `${providerRef}.${eventType}.${amountMinor}.${ts}` )
hex-encoded; timing-safe comparison
secret = process.env.PSP_WEBHOOK_SECRET ?? "sm_webhook_secret_demo"
```

- `expectedSignature()` in `process.ts:56-58` is the single source for the formula
  (the sandbox simulate endpoints import it, so test rails and processor can never drift).
- The signature is accepted from the `X-SM-Signature` header **or** the body `sig`
  field (`process.ts:134`; ingress route reads the header).
- Comparison is timing-safe (`safeEqual` from `src/lib/secretbox.ts`; `process.ts:136`).
- The fallback secret `"sm_webhook_secret_demo"` is **intentionally public** so it can
  never be trusted to authenticate real money events; it exists only so the sandbox
  mock rails work without env setup (`process.ts:46-49`). Production MUST set
  `PSP_WEBHOOK_SECRET`.

## 2. Replay protection

- Freshness window: `|now − ts| ≤ 10 minutes` (`WEBHOOK_TS_WINDOW_MS`,
  `process.ts:54`) — a correctly-signed but out-of-window delivery is rejected with
  **400 `STALE_EVENT`** (`process.ts:170-172`).
- `signatureValid` in the log means "authenticated as a LIVE event": correct MAC
  **and** inside the replay window — replay protection is treated as part of webhook
  authentication semantics (`process.ts:129-133`).

## 3. Enforcement order (ingress → processing)

1. **Rate limit first, before any body parsing/processing** — 60 req/min per client
   IP+route; over-limit ⇒ 429 `RATE_LIMITED` with `retryAfterSec`
   (`[provider]/route.ts:15-19`, `src/lib/ratelimit.ts`). A webhook storm can neither
   reach the processor nor burn DB reads.
2. Raw body read BEFORE JSON parse (order preserved; `[provider]/route.ts:22-23`).
3. Provider registry check: `resolvePspProvider` falls back to `mock`, and `mock` is
   `sandboxOnly` ⇒ in production an unregistered provider id is refused with
   **403 `PROVIDER_SANDBOX_ONLY`** — fail closed (`process.ts:113-119`, `src/lib/psp.ts`).
4. Field validation: `providerRef` + `eventType` required (400 `BAD_REQUEST`).
5. **Log-then-verify:** the webhook row is ALWAYS persisted first — including
   invalid/stale deliveries — with `signatureValid` and `processed` flags
   (`process.ts:153-165`; `PaymentWebhookLog` in `prisma/schema.prisma`). Invalid
   deliveries stay in the log as audit evidence.
6. Signature check ⇒ 400 `BAD_SIGNATURE`.
7. Freshness check ⇒ 400 `STALE_EVENT`.
8. Event routing (`payout.*` vs payment), unknown-event ⇒ 400 `UNKNOWN_EVENT`,
   amount guard ⇒ 409 `AMOUNT_MISMATCH` — both BEFORE the claim, so a malformed
   delivery can never attempt a status flip (`process.ts:239-247`).
9. Claim-first Serializable processing (see `04-idempotency-design.md`).

## 4. Rate limiting + flood posture

- Webhook ingest: **60 req/min per IP+route** (`[provider]/route.ts:16`) — far above
  any legitimate provider retry cadence (comment in the route).
- Sandbox simulate endpoints: 10 req/min per IP (`simulate/route.ts:26`,
  `payout-simulate/route.ts:29`).
- Limiter is a fixed-window, **single-process** in-memory implementation
  (`src/lib/ratelimit.ts`) — a documented limitation: multi-instance deployment
  requires a shared store (Redis/Postgres counter or gateway-level limiting). The
  intended topology is single-instance (`performance/production-topology.md`).

## 5. Inbound payout events (same pipeline)

`payout.succeeded` / `payout.failed` events pass the same verification (rate limit,
HMAC, freshness, log-first), then resolve the payout by `Payout.referenceNo` with
`Payout.providerRef` fallback, enforce `assertTransition` (409 `STATE_INVALID`) and
the amount guard, and claim `processing → paid|failed` conditionally with T4/T4f
posting inside the same Serializable tx (`processPayoutEvent`, `process.ts:644-792`).

## 6. Production requirements & honest limits for a real provider

**Required at provider integration time — NOT provider-compliant today:**

- `PSP_WEBHOOK_SECRET` **must** be set via the hosting secret manager in
  staging/production (`performance/environment-matrix.md` §1; `performance/deployment-preflight.md`
  D-7). The public fallback must never authenticate real events.
- The generic HMAC-over-`"providerRef.eventType.amountMinor.ts"` formula is a
  **platform-internal scheme for the mock rails**. Real providers sign differently
  (headers, canonical strings, timestamp/nonce schemes, certificate pinning…).
  The provider-specific scheme **must supersede or augment** this generic one at the
  per-provider verification seam (`process.ts` — see the production plug-in points in
  `src/lib/psp.ts`). **Do not assume this generic scheme is compliant with any
  provider's official webhook specification — TO BE MAPPED FROM CHOSEN PROVIDER'S
  OFFICIAL DOCUMENTATION.**
- The ±10 min replay window and the 60/min/IP rate limit are platform policy values,
  not provider-derived ones; both must be reviewed against the provider's retry
  cadence and signing timestamp scheme at integration time (`12-provider-checklist.md`).
- Secret handling rules (never in code/logs/client; rotation outline) are in
  `09-environments-secrets.md`.

## 7. Verified behaviours (mock rails, archived evidence)

| Behaviour | Result | Evidence |
|---|---|---|
| Unsigned delivery ⇒ 400 `BAD_SIGNATURE` (still logged) | PASS | `performance/runs/2026-10-27-deployment-smoke.json` §C6 |
| Correctly-signed stale delivery (−20 min) ⇒ 400 `STALE_EVENT` | PASS | same, §C7 |
| Duplicate signed delivery ⇒ 200 `duplicate:true`, T1 exactly-once | PASS | same, §C5; `2026-10-25-load-webstorm.json` |
| Concurrent duplicate deliveries exactly-once | PASS (dev-mode) | `performance/runs/2026-10-25-load-webstorm.json` (15 duplicates, all 200, exactlyOnce true, 15/15 T1) |
| Rate-limited ingest refuses before parsing | design intent (limiter unit-visible; not separately archived) | `[provider]/route.ts:15-19` |

Everything above was produced by the sandbox mock PSP — **internal evidence only,
not provider certification** (see `README.md` honest boundary).
