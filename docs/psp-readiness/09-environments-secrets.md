# 09 — Environments & Secrets

**Sources:** `performance/environment-matrix.md` (authoritative matrix, verified
2026-10-27), `performance/deployment-preflight.md` (blockers), `src/lib/cron-auth.ts`
(fail-closed auth), `src/app/api/webhooks/payments/process.ts` (webhook secret),
`.env.example` (placeholder inventory), `scripts/ensure-env.ts` +
`src/instrumentation-node.ts` (dev boot guard).

## 1. Environment matrix (status)

| Dimension | Development (this sandbox) | Staging | Production |
|---|---|---|---|
| Status | ✅ running | ❌ **NOT PROVISIONED — BLOCKED** (isolated Supabase project + hosting needed; no dashboard/account access in this environment) | ❌ **NOT PROVISIONED — BLOCKED** (hosting provider undecided; deployment-preflight D-2) |
| `NODE_ENV` | development | production (production build) | production |
| Payment mode | mock PSP only (simulate endpoints, public fallback webhook secret) | mock PSP **or** the chosen provider's official sandbox — never real charges | real PSP only; mock endpoints refuse unless Setting `psp.mock.enabled` explicitly true |
| Scheduler | mini-service `:3005`, 30 s interval, dev-open auth | platform cron / supervised service + `CRON_SECRET`, verified end-to-end | same as staging; fail-closed without `CRON_SECRET` |
| Data | demo dataset + `[LT]` test records | isolated seeded dataset + `[LT]` records | real data; **no test records ever** |
| Capacity claims | none permitted (dev-mode, combined env) | via target-guarded external generator only | none (no heavy tests, ever) |

Prohibited-actions table (binding) is in `performance/environment-matrix.md` §1 —
e.g. staging may never run real charges/refunds/payouts or import real customer data;
cleanup may only touch `[LT]`-owned records.

## 2. Secret inventory

| Secret | Dev status (2026-10-27) | Staging/production requirement |
|---|---|---|
| `SUPABASE_DATABASE_URL` | set (Supavisor session pooler, `connection_limit=10`) | per-environment value via hosting secret manager |
| `SUPABASE_URL` | set | same |
| `SUPABASE_ANON_KEY` | set (new-style publishable key, REST-validated) | same |
| `SUPABASE_SERVICE_ROLE_KEY` | set (new-style secret key, REST-validated) | same |
| `CRON_SECRET` | **NOT SET** (dev-open mode) | set via hosting secret manager; scheduler endpoints fail closed (503) without it |
| `PSP_WEBHOOK_SECRET` | **NOT SET** (public fallback active — sandbox only) | set via hosting secret manager; a real provider's signing scheme will supersede the generic HMAC (`05-webhook-security.md` §6) |
| (future) provider credentials | n/a | provider sandbox + production credentials at integration time — TO BE MAPPED FROM CHOSEN PROVIDER'S OFFICIAL DOCUMENTATION |

Verified status from `performance/psp-readiness/preflight.md` §3. No secret values
are printed by any endpoint, script, or audited log path (cron-auth and the webhook
processor are deliberately echo-free; the scheduler status surface exposes only
`secretConfigured: boolean` — preflight §3, `mini-services/expiry-scheduler/README.md`).

## 3. Handling rules (enforced in code)

- **Never in code:** secrets are read from env only (`process.env.*`); `.env` is
  git-ignored with a placeholder-only `.env.example` committed instead (hygiene fix
  recorded in the 2026-10-27 doc-sync worklog entry).
- **Never in logs/responses:** `assertCronAuth` refuses with identical messages for
  missing/wrong secrets and never echoes the presented value (`src/lib/cron-auth.ts`);
  the webhook secret is never logged; `ensure-env.ts` prints key NAMES only.
- **Never client-side:** all payment/webhook/cron surfaces are server-only routes;
  the mock gate and provider registry keep Prisma out of client bundles
  (`src/lib/psp.ts` lazy-db note).
- **Fail closed:** in production, cron endpoints without `CRON_SECRET` return
  **503 `CRON_NOT_CONFIGURED`** rather than becoming publicly callable; with the
  secret set, the `x-cron-secret` header is compared **timing-safely**
  (sha256-digest-normalised `timingSafeEqual` — no length leak, no early exit)
  (`src/lib/cron-auth.ts`). `CRON_REQUIRE_SECRET=1` makes the fail-closed branch
  testable in dev (`scheduler-e2e` scenario F2 verified 503 on both methods,
  `performance/runs/2026-10-25-scheduler-e2e.json`).
- **Webhook auth modes:** `PSP_WEBHOOK_SECRET` unset ⇒ the public fallback secret
  authenticates mock rails (sandbox only); production must set the real value
  (`process.ts:46-49`). The sandboxOnly provider check (403 in production) is an
  independent fail-closed layer (`process.ts:113-119`).

## 4. Rotation procedure outline (design intent — run at provisioning time)

`CRON_SECRET` (no downtime):

1. Generate the new secret; add it to the hosting secret manager.
2. Because the scheduler sends the header from its own env, update the scheduler's
   env first (or platform cron's stored header), then the app's `CRON_SECRET`.
   During the window the app still accepts the OLD value only — to avoid a gap,
   rotate at a quiet moment and verify with `GET /api/cron/expiry-sweep` (403 ⇒ new
   secret active for that caller).
3. Verify the scheduler's next tick succeeds (status surface on `:3005` —
   `consecutiveFailures` resets) and no `TICK_UNREACHABLE`/`403` alerts appear.

`PSP_WEBHOOK_SECRET`:

1. Coordinate with the provider's own secret/endpoint rotation procedure —
   TO BE MAPPED FROM CHOSEN PROVIDER'S OFFICIAL DOCUMENTATION (providers commonly
   support dual-active signing secrets for overlap windows; the platform's single
   active secret must be confirmed against the provider's scheme).
2. Swap the env value in the secret manager; invalid-signature deliveries during
   the gap are **logged with `signatureValid:false` and rejected 400** — audit trail
   intact; the provider's retries converge once the new secret is active.
3. Post-rotation, verify with a known signed test delivery (sandbox/provider test
   event) and review `PaymentWebhookLog` for the gap window.

Supabase keys: rotate in the Supabase dashboard, then update the hosting secret
manager (dev's self-healing vault is a dev-only convenience — `upload/.env.vault` —
and must NOT be replicated in production).

Detailed deployment steps for staging provisioning are in
`performance/environment-matrix.md` §3 (blocked on access); deployment blockers
D-1/D-2/D-5/D-6/D-7 in `performance/deployment-preflight.md`.
