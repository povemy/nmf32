# Blueprint Support 08 — Integrations, Performance & Reliability (Parts L, M, N)

## PART L — Integrations and external services

| Service | Purpose | Integration points | Config (names only) | Status |
|---|---|---|---|---|
| **Mock PSP ("NomoPay Checkout (sandbox)")** | Simulates licensed-PSP split rails: PaymentGroup = one charge; `simulate` endpoint signs & emits the exact production webhook; ledger T1 is the accounting mirror | `src/lib/psp.ts` (registry, `PspProvider` interface, 4 production plug-in points), `checkout/payments/[ref]/simulate`, `webhooks/payments/[provider]` + `process.ts` | HMAC secret env-driven with demo fallback (`process.ts`); candidates stripe_my/curlec/ipay88 documented — **R5: `stripe_my` adapter scaffold now exists** (see addendum below), lazily registered, unconfigured in sandbox | **Mocked by design**; R5 adapter surface added, mock path byte-identical [V] |
| **Shopee OpenPlatform** | Seller catalogue import + OAuth connection | `src/lib/marketplaces/shopee.ts` (real network client: sandbox/live host by env, OAuth begin/exchange/refresh, token sealing via secretbox) | `SHOPEE_ENV`, `SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY`, `SHOPEE_REDIRECT_URI`, `PUBLIC_APP_ORIGIN` | **Inactive without env** — `authStatus()` reports unconfigured; imports park `awaiting_authorisation`; fixture connector is the working demo [V] |
| **TikTok Shop API** | Same as Shopee | `src/lib/marketplaces/tiktok.ts` | `TIKTOK_SHOP_APP_KEY/SECRET/SERVICE_ID`, `TIKTOK_SHOP_REDIRECT_URI` | Same posture [V] |
| **Fixture connector** | Local demo marketplace source (`demo.shopmesh.fixture`) | `src/lib/marketplaces/fixture.ts` | none | Fully working demo path [V] |
| **socket.io chat hub** | Realtime relay | `mini-services/chat-service` (:3003 socket + :3103 internal relay); Next persists then broadcasts (`lib/chat.ts:7-20`, 1.5s timeout, non-fatal failure) | none (no auth) | Operational in sandbox [V] |
| **z-ai-web-dev-sdk** | AI features (search/image-gen/LLM) | **zero imports anywhere** [V] | — | Installed-but-unused |
| Email / SMS / push | Notifications | **None** — `notify()` writes NotificationLog rows only (`lib/api.ts:113-124`) | — | **Missing** (by sandbox design) [M] |
| Cloud storage (S3/OSS) | Uploads | **None** — local `public/uploads/{storeId}/` via SSRF-guarded copier | — | Missing [M] |
| pdf-lib | Receipt PDF generation | `orders/receipt/route.ts` | — | Used [V] |
| Error reporting / APM | Observability | None | — | Missing [M] |

**Webhook posture summary** [V]: inbound payment webhook = HMAC demo secret, log-first, status-idempotent, amount-guarded, no replay window; outbound store webhooks = **simulated** (`dispatchStoreWebhooks` writes success rows, no HTTP — `lib/api.ts:127-144`); admin replay = simulated success bump, audited. Rate limits: none external. Retries: none (no queue). Fallbacks: chat broadcast failure non-fatal; connector failures recorded on ImportJob.

## PART M — Performance and scalability

| Area | Implementation | Assessment |
|---|---|---|
| Indexing | @@index on hot filters: `[storeId,status]` products, `[shopperId]`+`[paymentGroupId]` orders, `[status]` shipments, `[isPublished,startAt,endAt]` campaigns | Reasonable for scale; no EXPLAIN QUERY PLAN evidence [P] |
| N+1 risks | `resolveRate` queries per item (product→category chain→seller→holidays) inside checkout create; category ancestor chain is sequential awaits | Bounded by cart size; acceptable at demo scale, measurable at scale [I] |
| Pagination | `getPagination(maxSize=100)` everywhere paged; cursor pagination on ledger transactions | [V] |
| Caching | Campaign 60s memo; wallet cache on-write; per-process summary Map; device token memo; `/api/img` 1y immutable | [V] |
| Search/filter | DB `contains` queries (SQLite LIKE) — no full-text/Meili (worklog: intentionally omitted) | Fine at demo scale [V] |
| SSR/CSR | Single SSR shell; **100% client-fetch data**; 92 `'use client'` files; large client bundles (checkout 2,569 ln, me-hub 2,241 ln) | Bundle weight unmeasured [U] |
| Background work | None; everything synchronous in-request except simulated workers | Checkout create does pricing+commission+tx in-request (acceptable); webhook success does T1+notifications+webhook-sim synchronously [V] |
| Connection management | Prisma singleton (global-cached in dev); SQLite single-writer (journal_mode=delete) | **Concurrency ceiling = SQLite**; multi-vendor write contention untested; Postgres migration path noted in worklog [V/I] |
| Reporting | Aggregation queries on read (analytics, reports, dashboards); export snapshotting avoids recompute | [V] |
| Image delivery | Deterministic SVG service, immutable cache; plain `<img>` (no next/image optimization) | [V] |

**No benchmark/throughput evidence exists** — no claims about capacity are made. [M]

## PART N — Reliability, observability & recovery

- **Logging**: Next dev output tee'd to `dev.log` (prod: `server.log`); 11 `console.*` calls; no structured logger, no tracing, no metrics. [V]
- **Health**: `GET /api/health` (public; counts + `runLedgerInvariants()` incl. every-txn balance + wallet-cache drift) and `GET /api/admin/system/health` (admin; + last audit rows; 30s UI poller). **No scheduler invokes the invariants** despite the "nightly" comment (`ledger.ts:302`) — who runs them in production is an open question. [V]
- **Audit/recovery records**: AdminAuditLog+ActivityLog (every mutating admin op), PaymentWebhookLog (every delivery incl. rejected), OrderStatusHistory (every transition), FinMigrationBackup (schema migration audit). [V]
- **Backup/DR**: none configured in-repo (SQLite file only; sandbox harness copies `db/custom.db` into build artifacts — `.zscripts/database-runtime-build.sh`). **No backup schedule, no restore runbook** [M].
- **Failure behaviour of key dependencies**:
  - *Mock PSP down*: N/A (in-process).
  - *Chat hub down*: broadcasts fail non-fatally after 1.5s; clients fall back to polling/next load. [V]
  - *DB down*: all routes 500 via `handle` (raw message leaked — minor info disclosure). [V]
  - *Crash windows*: webhook success (status→T1 gap ⇒ paid order uncredited, FIN-02); payout batch loop (partial T3s, FIN-08); refund process sequence (T5 without status flip etc.); mark-paid (ledger/status desync). All non-transactional, no compensation/retry workers. [V]
- **Idempotency inventory**: checkout create = `Idempotency-Key` + unique idemKey (DB-enforced); webhook = status check (no DB key — FIN-02); voucher redemption = guarded updateMany; claim token = hashed single-use; payout referenceNo = counter (unique); **refund process & mark-paid = check-then-act only**. [V]
- **UI/DB/PSP/ledger disagreement scenarios**: (1) crash between webhook status flip and T1 ⇒ PSP/DB paid, ledger missing; (2) TOCTOU double-T1 ⇒ ledger double-credit; (3) partial refund after payout ⇒ negative payable, platform out-of-pocket (FIN-04); (4) simulated outbound webhook rows always "success" ⇒ delivery logs overstate reality (by design, labelled). [V]
- **Retry safety**: replaying checkout create is safe (idemKey); replaying webhook is status-idempotent single-threaded but racy concurrent; replaying `shipping/tick` is throttled & idempotent-ish (advances state); replaying refund-process is blocked by status guard (racy). [V/I]

## R5 ADDENDUM — real-PSP adapter scaffold (Task 22-c)

Additive, env-gated scaffold so a licensed gateway can be dropped in without touching the mock
or `webhooks/payments/process.ts`. With no `STRIPE_*` env keys the sandbox behaviour is
byte-identical to pre-R5 (fin-tests green, mock simulate/webhook/live E2E unchanged).

**Adapter interface extension** (`src/lib/psp.ts`):

- `PspProvider` gains a REQUIRED `isConfigured(): boolean` (env gate, read at call time, secrets
  never hardcoded; mock ⇒ `true`) and two OPTIONAL capabilities with documented contracts:
  - `createCheckoutSession?(input): Promise<{redirectUrl, providerRef}>` — hosted checkout
    (toggle point 2). CONTRACT: use only server-computed numbers; stamp the canonical internal
    ref (`input.groupRef` = `PaymentGroup.ref`) onto the remote session (metadata) and ECHO it
    back as `providerRef` so the adapter's own webhook verifier reports a resolvable ref; be
    idempotent per groupRef; throw typed `PspAdapterError("PSP_NOT_CONFIGURED")` instead of
    calling the network unconfigured. Input carries the Option B split (group amount, currency,
    `commissionMinor` application-fee total, per-seller `{sellerId, amountMinor,
    commissionMinor, pspAccountId?}` lines).
  - `verifyWebhookSignature?(req, rawBody): Promise<PspWebhookVerdict>` — native verification
    (toggle point 3). CONTRACT: constant-time compare only; NEVER trust unverified body fields
    (parse only after the compare); enforce a replay window; return `{valid, providerRef?,
    eventId?}` plus OPTIONAL normalized fields (`eventType` in the internal
    `payment.succeeded|payment.failed` vocabulary, `amountMinor`, `ts`) so the dispatch route
    can run the unchanged pipeline.
- New typed error `PspAdapterError(status, code, message)`; routes convert it to the standard
  error envelope.

**Lazy registry** (`src/lib/psp.ts` — the static `PSP_PROVIDERS` + `PSP_SPLIT_CANDIDATES` + the 4
plug-in-point notes stay intact): `getPspProvider(id)` returns the adapter from
`PSP_LAZY_ADAPTERS` ONLY while `isConfigured()`, else falls back to the static map (mock for
unknown ids). `getPspProviderForMethod(method)` maps the checkout payment METHOD
(`card_stripe → stripe_my`; Curlec/iPay88 pending) to its adapter. The static-only
`resolvePspProvider` (used by the `/simulate` gate) is deliberately untouched.

**`src/lib/psp-adapters/stripe-my.ts`** — Stripe Malaysia + Connect skeleton (NO SDK, raw
fetch; never executes in this sandbox):

- Env: `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (both required; `sandboxOnly` getter is
  `false` exactly when both are present, `true` otherwise).
- `createCheckoutSession`: `POST /v1/checkout/sessions` form-encoded — `mode=payment`, one line
  item for the whole group, `payment_intent_data[transfer_group]` = canonical group ref,
  `metadata[nomo_ref]` + `client_reference_id` stamping, Stripe `Idempotency-Key:
  checkout:<groupRef>`; when exactly ONE seller with a known `pspAccountId` → destination
  charge with `payment_intent_data[application_fee_amount]` = commission (the Option B note
  verbatim); otherwise separate-charges-and-transfers (platform retains commission, per-seller
  Transfers issued on webhook confirmation — production follow-up: `Seller.pspAccountId`
  column + Transfer issuance). `PSP_NOT_CONFIGURED` guard before any fetch.
- `verifyWebhookSignature`: the real Stripe scheme — `stripe-signature: t=…,v1=…` header,
  HMAC-SHA256 over `` `${t}.${rawBody}` ``, every v1 candidate compared constant-time
  (reuses `safeEqualHex` → `timingSafeEqual`), 5-minute replay tolerance, body parsed only
  after the compare; maps `checkout.session.completed`/`async_payment_succeeded`/
  `payment_intent.succeeded` → `payment.succeeded` and
  `checkout.session.expired`/`payment_intent.payment_failed`/`charge.failed` →
  `payment.failed`; returns `providerRef` from `metadata[nomo_ref]` →
  `client_reference_id` → object id, `amountMinor` from `amount_total`/`amount`, `ts` from the
  authenticated signing timestamp. Proven offline (Task 22-c: 16/16 cases — valid, uppercase
  hex, tampered, stale 6 min, fresh 4 min, wrong secret, missing header, body-swap,
  unconfigured throws, registry/sandboxOnly gating).

**Per-provider webhook dispatch** (`webhooks/payments/[provider]/route.ts`, additive branch at
the top; the mock branch below it is byte-identical — only the import line and header comment
grew): if `[provider]` resolves to an adapter with `verifyWebhookSignature`, the adapter
verifies first; invalid → log-first (`PaymentWebhookLog signatureValid=0`, unverified body
fields NOT parsed out) then 400 `BAD_SIGNATURE`; valid-but-unmapped event types → 200
`{ignored:true}` (no PSP retry storm); valid + normalized → the route re-signs the normalized
internal event with the platform's `PAYMENT_WEBHOOK_SECRET` (never leaves the server) and calls
the UNCHANGED `processPaymentWebhook` with the RAW PSP body preserved as the log payload — so
the 15-min replay window, atomic T1, DB-enforced idempotency and fan-out apply to real gateways
exactly as to the mock.

**Checkout hook** (`checkout/create/route.ts`, single additive branch where the payment ref is
built): when the method's adapter exposes `createCheckoutSession` and is configured, the
adapter's `redirectUrl`/`providerRef` replace the mock `/pay/{ref}` default; adapter errors
surface as `PSP_NOT_CONFIGURED` / `PSP_UPSTREAM_ERROR` / `PSP_SESSION_FAILED`. Unconfigured →
byte-identical mock flow. Note: the SPA still navigates by `orderPaymentRef` (client-side pay
surface) — wiring the hosted redirect into the shopper UI is a frontend follow-up.

**Residual (flagged)**: with a lazily-registered adapter, `/simulate`'s mock-only gate still
resolves to the mock for payment-METHOD ids (by design — `resolvePspProvider` is static-only),
so once real keys are set, prod must deregister the mock / env-gate `/simulate` (runbook §d.3
control stands). `PSP_SIMULATE_DISABLED` never fires for method ids today.
