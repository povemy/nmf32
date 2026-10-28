# Production-Readiness Runbook — NOMOFEE

> Ops doc P1 round. Companion doc: [`docs/ops/postgresql-migration-plan.md`](./postgresql-migration-plan.md)
> (SQLite → PostgreSQL strategy, type mapping, cutover checklist).
> Also relevant: `docs/blueprint/09-testing-config-admin.md` (§P.1 runtime/deployment) and
> `docs/blueprint/10-unwired-techdebt-openquestions.md` (§R.1 sandbox infrastructure, §W open
> questions).

Status: runbook for taking the current sandbox build toward production. The items in §e are the
gate; sections a–d are the reference material behind them.

---

## a) Environments

**Current state:** staging/prod distinction is `NODE_ENV` only (blueprint §P.1). There is no
separate staging deployment yet; the sandbox/preview IS the de-facto staging. The table below is
the complete environment-variable inventory to provision per environment.

### Environment variable inventory

Found by `rg -o "process\.env\.[A-Z_]+" src/ | sort -u` → **11 unique names in `src/`**, plus
`DATABASE_URL` (consumed by Prisma via `prisma/schema.prisma`), plus **2 variables read
dynamically** (not catchable by the static pattern) in `src/lib/marketplaces/callback.ts:19`,
plus **2 Stripe PSP variables** (R5, Task 22-c — read at call time in
`src/lib/psp-adapters/stripe-my.ts`) → **16 total**.

| # | Variable | Purpose | Where used | Current fallback / dev behaviour | Production action |
|---|---|---|---|---|---|
| 1 | `DATABASE_URL` | Database connection (SQLite `file:` URL today; PG URL after migration) | `prisma/schema.prisma:7` (env), all Prisma clients (`src/lib/db.ts`, scripts, seed) | `.env` (git-untracked): `file:/home/z/my-project/db/custom.db` | Set to PostgreSQL URL per migration plan. **Never commit `.env`.** |
| 2 | `PAYMENT_WEBHOOK_SECRET` | HMAC-SHA256 secret verifying payment webhook signatures | `src/app/api/webhooks/payments/process.ts:45` | ⚠️ **Demo fallback `"sm_webhook_secret_demo"`** | **MUST be overridden** with a long random secret (32+ bytes). With the demo fallback anyone can forge a signed `payment.succeeded` webhook and mark orders paid (F-01). Give the SAME value to the PSP adapter configuration. Rotate on any suspicion of leak. |
| 3 | `PUBLIC_APP_ORIGIN` | Canonical origin: CSRF host allowlist, sitemap, SEO/canonical, OAuth redirect base | `src/lib/api.ts:54` (CSRF origin gate), `src/app/sitemap.ts:9`, `src/lib/seo.ts:7`, `src/app/api/store/connections/[platform]/begin/route.ts:29`, `src/app/api/auth/callback/[platform]/route.ts:13` | Request `Host` header; `http://localhost:3000` | Set to the exact public origin (e.g. `https://nomofee.io`). A wrong/missing value weakens the CSRF origin gate (it allow-lists the request's own Host) and produces wrong sitemap/canonical URLs. |
| 4 | `IMPORT_TOKEN_ENC_KEY` | AES-256-GCM key encrypting marketplace (Shopee/TikTok) tokens at rest | `src/lib/secretbox.ts:12` | ⚠️ Dev fallback key derived from `HOSTNAME` + cwd (F-16) | Set a random 32-byte key per environment. Losing it makes stored marketplace tokens undecryptable (re-auth needed). Key-rotation procedure = decrypt+re-encrypt `marketplace_tokens` during a maintenance window. |
| 5 | `SHOPEE_ENV` | Shopee OpenPlatform host selection | `src/lib/marketplaces/shopee.ts:14` | unset → sandbox host | `live` only after Shopee partner approval. |
| 6 | `SHOPEE_PARTNER_ID` | Shopee partner identity / OAuth | `shopee.ts:18,101`; `store/connections/route.ts:33`; `store/imports/route.ts:50` | unset → connector reports not-configured (parked) | Set when Shopee integration ships. |
| 7 | `SHOPEE_PARTNER_KEY` | Shopee signing key | `shopee.ts:19,102`; same call sites as #6 | unset → connector parked | Set; treat as a secret. |
| 8 | `TIKTOK_SHOP_APP_KEY` | TikTok Shop app identity / OAuth | `tiktok.ts:20,115`; `store/connections/route.ts:34`; `store/imports/route.ts:51` | unset → connector parked | Set when TikTok integration ships. |
| 9 | `TIKTOK_SHOP_APP_SECRET` | TikTok Shop signing secret | `tiktok.ts:21,116`; same call sites | unset → connector parked | Set; treat as a secret. |
| 10 | `TIKTOK_SHOP_SERVICE_ID` | TikTok Shop service id (auth URL param) | `tiktok.ts:123,132` | unset → omitted from auth URL | Set if the TikTok app requires it. |
| 11 | `SHOPEE_REDIRECT_URI` *(dynamic)* | Shopee OAuth callback URL read via `process.env[envName]` | `src/lib/marketplaces/callback.ts:19` | unset → callback falls back to request origin | Set to `https://<origin>/api/auth/callback/shopee`; must match the Shopee developer console exactly. |
| 12 | `TIKTOK_SHOP_REDIRECT_URI` *(dynamic)* | TikTok OAuth callback URL, same mechanism | `src/lib/marketplaces/callback.ts:19` | unset → fallback as above | Set to `https://<origin>/api/auth/callback/tiktok`. |
| 13 | `NODE_ENV` | Runtime mode (also gates the dev Prisma-client singleton) | `src/lib/db.ts:13`; Next.js runtime | `development` in sandbox | `production`. |
| 14 | `HOSTNAME` | Entropy component of the DEV fallback key in secretbox | `src/lib/secretbox.ts:25` | harness-set | Irrelevant once #4 is set — verify #4 is set precisely so this fallback can never engage. |
| 15 | `STRIPE_SECRET_KEY` *(R5)* | Stripe REST auth for the `stripe_my` adapter (Checkout Sessions; later Transfers) | `src/lib/psp-adapters/stripe-my.ts` (read at call time) | unset → adapter reports `isConfigured() === false`, lazy registry falls back to the sandbox mock; `createCheckoutSession` throws `PSP_NOT_CONFIGURED` before any network call | Set (live `sk_…`) only after the Stripe Malaysia + Connect contract is signed. **Treat as a secret**; never commit. |
| 16 | `STRIPE_WEBHOOK_SECRET` *(R5)* | Signing secret for Stripe webhook verification (`t=/v1=` HMAC, constant-time, 5-min replay window) | `src/lib/psp-adapters/stripe-my.ts`; `POST /api/webhooks/payments/stripe_my` is the endpoint to register in the Stripe dashboard | unset → adapter never selected (mock fallback) | Set the `whsec_…` value Stripe shows per webhook endpoint. Distinct from `PAYMENT_WEBHOOK_SECRET` (#2) — that one protects the platform's internal mock/HMAC path. |

Not env-driven but config-like (hardcoded today, blueprint §T "Hardcoded operational values"):
admin notify email `admin@nomofee.io` (≥3 routes), RM100 payout threshold, `MY_STATES`,
`SESSION_TTL_MS = 7d` (`src/lib/auth.ts:11`), rate-limit windows. Acceptable for go-live;
track for a config pass.

### Staging vs production inventory

| Item | Staging (new) | Production |
|---|---|---|
| Database | Own PG instance (or SQLite if §PG plan not executed) — **never** the prod DB | PostgreSQL per migration plan |
| `PAYMENT_WEBHOOK_SECRET` | Dedicated staging value (NOT the demo fallback, NOT prod's) | Dedicated strong secret |
| PSP | Sandbox/mock adapter (`sandboxOnly: true`) | Real adapter: `stripe_my` adapter exists as an R5 scaffold (lazy-registered; activates only when BOTH `STRIPE_*` keys are set) / `curlec` / `ipay88` (plug-in points documented in `src/lib/psp.ts`); register `POST /api/webhooks/payments/stripe_my` in the Stripe dashboard |
| Seed | `bun prisma/seed.ts` allowed (demo data) | **Never run the seed** (demo credentials are rendered in client bundles) |
| `PUBLIC_APP_ORIGIN` | Staging domain | Production domain |
| Marketplace connectors | Shopee/TikTok sandbox credentials | Live credentials + `SHOPEE_ENV=live` |
| Monitoring | Same probes as prod (cheap) | §c below |

## b) Backups

**Script:** `bun run db:backup [label]` → `scripts/backup-db.ts`
(added to `package.json` this round). Behaviour:

- Target: `db/backup/custom.db.<label>-<UTC timestamp>` (label default `manual`, sanitized).
- Prefers the **SQLite backup API** via the `sqlite3` CLI (`.backup '<target>'`) — a consistent
  snapshot even while the app runs.
- Falls back to `fs.copyFileSync` with a printed **WARNING** if `sqlite3` is unavailable — a
  plain copy of a live DB can catch it mid-write (header comment in the script explains); stop
  the app for a guaranteed-consistent fallback copy.
- Refuses to overwrite an existing target (exit 1); prints the resulting path; exit 1 on failure.
- Verified this round: success path (fallback mode, exit 0, file created) and overwrite refusal
  (exit 1) both exercised; proof backup `db/backup/custom.db.ci-proof-20261018T134119Z`.

**Retention suggestion** (start simple, automate later):

- Keep **7 daily** + **4 weekly** + **every pre-migration / pre-cutover** backup (label them,
  e.g. `pre-p0-…`, `pre-pg-cutover`, and never prune those).
- Run the script from cron/systemd timer with a `scheduled-YYYYMMDD` label; alert when the
  newest backup is older than 24 h.
- `db/backup/` is git-ignored (`db/backup/` in `.gitignore` — backups must never enter git);
  copy off-host (object storage) for real durability — same-host copies survive app crashes,
  not host loss.
- After the PostgreSQL migration (§ migration plan), replace this with managed snapshots/PITR;
  keep the pre-cutover SQLite backups per that plan's §7.

**Restore drill** (rehearse before go-live; target ≤ 15 min):

1. Stop the app (or the route that writes).
2. Move the current DB aside: `mv db/custom.db db/custom.db.broken-<ts>` (keep it — do not delete).
3. Copy the chosen backup over `db/custom.db` (`cp db/backup/custom.db.<label>-<ts> db/custom.db`).
4. Start the app; `curl /api/health` → `ledgerInvariants.ok: true`.
5. Gate: `bun scripts/fin-reconcile.ts` → **25/25** (read-only) before reopening writes.
6. Post-mortem: note what was lost (writes since the backup) and how the restore was triggered.

## c) Monitoring

| Signal | Where | What to watch / alert on |
|---|---|---|
| **`/api/health`** | `GET /api/health` (`src/app/api/health/route.ts`) | `status:"healthy"`, `db:"up"`, and — critically — `ledgerInvariants.ok` with `problems[]`. This endpoint exposes real ledger reconcile problems. ⚠️ **It is currently UNAUTHENTICATED and reveals store/product/order counts + invariant problems — auth-gate it (or IP-restrict / split into a shallow liveness probe + authed depth probe) before prod.** |
| **Webhook signature failures** | `PaymentWebhookLog.signatureValid = 0` counts (`src/app/api/webhooks/payments/process.ts` persists every attempt) | Any sustained non-zero rate = forgery attempts OR a PSP secret mismatch after rotation. Alert on >0 over a rolling window; investigate immediately (this is the money entry point). |
| **P2002 idempotency collisions** | App logs (Prisma `P2002` caught → `duplicate:true` in webhook processing) | Expected **only** under true webhook replays (PSP retry delivering an already-processed event). A burst outside a known PSP-retry incident = someone probing the webhook with replayed payloads. Frequent *unexpected* collisions also hint at clock/replay-window issues (15-minute `STALE_TIMESTAMP` window). |
| **Ledger balance invariant job** | `bun scripts/fin-reconcile.ts` (read-only, exit-coded) scheduled via cron — **no scheduler exists in the repo yet (blueprint W4): decide cron/systemd/worker and wire it** | 25/25 checks. Also nightly `runLedgerInvariants()` (already behind `/api/health` and `/api/admin/system/health`) — same decision. Alert on any failure; a ledger that stops reconciling is a stop-the-world event for payouts. |
| **Rate-limit 429 rates** | 429 `RATE_LIMITED` responses from the in-memory limiter (`src/lib/rate-limit.ts`, 60 s fixed windows; buckets: auth 20, order-lookup 15, public-write 30, import 20, webhook-payment 120, simulate 30) | Rising 429s on `auth/*` = credential stuffing; on `webhook-payment` = PSP retry storms or probing. Track per-bucket counters (export them — currently log-only). |
| **Disk growth** | `db/custom.db` size + `-journal` sidecars (until PG migration) | SQLite grows monotonically; watch for the DB outgrowing disk or slowing (no autovacuum). Budget: schedule `VACUUM` in a maintenance window; after PG migration, watch table bloat instead. Also watch `db/backup/` retention pruning actually happening (§b). |
| **Prisma log stream** | `db.ts` configures `log: ['error','warn']` | Prisma warn/error spikes = data-integrity or connection issues. |

## d) Known limitations carried into prod (if shipped as-is)

1. **In-memory rate limiter is single-instance.** `src/lib/rate-limit.ts` keeps buckets in a
   process-local `Map` (header comment says exactly this). Behind >1 app instance each instance
   limits independently → effective limit = N × configured. **Swap to Redis/Upstash before
   multi-instance prod** — call sites (`rateLimit(req, bucket, limit)`) stay identical.
2. **localStorage session token exposure (F-09, documented).** The client-side auth helpers
   (`src/components/admin/use-api.ts` et al.) persist a Bearer session token in `localStorage`
   for cookieless contexts — readable by any XSS on the origin. Compensating controls: DB-backed
   revocable sessions, CSRF origin gate, rate limiting. Track the hardening item separately.
3. **Simulated PSP only.** `src/lib/psp.ts` registers only the sandbox `mock` adapter statically
   ("NomoPay Checkout (sandbox)"); the R5 `stripe_my` adapter (`src/lib/psp-adapters/stripe-my.ts`)
   exists as a lazily-registered scaffold that activates ONLY with both `STRIPE_*` env keys;
   `curlec` / `ipay88` remain documented candidates. The `/simulate` endpoint is rate-limited and
   gated to sandbox-only adapters, but the mock is the **fallback** for unknown providers — in
   prod, deregister the mock (or add an env gate) so no payment can be settled via simulation
   (F-01 residual). Note: with the lazy registry, `/simulate`'s static `resolvePspProvider` gate
   still resolves the mock for payment-METHOD ids — the deregistration/env-gate is the control.
4. **Admin session TTL = 7 days** (`SESSION_TTL_MS`, `src/lib/auth.ts:11`) with no re-auth step
   for sensitive ops. Reduce for prod (e.g. 24 h) or add step-up auth for `payouts.manage` /
   `settings.manage` RBAC caps.
5. **Sandbox infrastructure also shipping-shaped** (blueprint §R.1): mock courier network
   (SVG AWB labels), notifications = DB rows only (no email/SMS), simulated outbound store
   webhooks, deterministic SVG image service, demo credentials rendered in client bundles
   (**never run the seed in prod**; create real accounts instead).

## e) Go-live checklist

Secrets & environment
- [ ] All 16 env vars from §a provisioned per environment; `PAYMENT_WEBHOOK_SECRET` overridden (no demo fallback), `IMPORT_TOKEN_ENC_KEY` set, `PUBLIC_APP_ORIGIN` exact.
- [ ] `.env` and `db/*.db` confirmed git-untracked (done in P0-3, commit `4440b89`); secrets manager adopted.
- [ ] Staging environment separated (own DB, own secrets) per §a table.

Payments & ledger
- [ ] Real PSP adapter implemented and registered (`src/lib/psp.ts` plug-in points 1–4); `PAYMENT_WEBHOOK_SECRET` shared with PSP. R5: `stripe_my` scaffold in place — provide `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`, then verify the lazy registry selects it (`isConfigured()`), the Stripe dashboard webhook points at `POST /api/webhooks/payments/stripe_my`, and a Stripe-signed event produces exactly ONE `order_paid` T1 via the unchanged pipeline.
- [ ] Mock adapter deregistered/env-gated in prod; `/simulate` cannot settle payments (409 `PSP_SIMULATE_DISABLED` verified with a signed request).
- [ ] Replay drill: valid webhook twice → second returns `duplicate:true`, still exactly ONE `order_paid` ledger transaction.
- [ ] `bun scripts/fin-tests.ts` (78/78 as of Task 22-c — count grows with the suite) and `bun scripts/fin-reconcile.ts` 25/25 against production data snapshot.

Database & backups
- [ ] PostgreSQL migration executed per [`postgresql-migration-plan.md`](./postgresql-migration-plan.md) (or: SQLite accepted consciously with §b backup cadence).
- [ ] `db:backup` scheduled (cron), off-host copies enabled, retention pruning verified.
- [ ] Restore drill (§b) performed and timed on staging.

App hardening
- [ ] `/api/health` auth-gated or IP-restricted (§c).
- [ ] Rate limiter swapped to Redis (only if multi-instance; single-instance = document the limit).
- [ ] Seed/demo credentials never created in prod; first real admin created manually; `Session` rows auditable.
- [ ] Session TTL decision applied (§d.4).
- [ ] F-06/F-07/F-08/F-09 residual security items re-checked against blueprint 07 before launch.

Monitoring & ops
- [ ] `/api/health` probe wired to uptime monitor (after gating).
- [ ] `PaymentWebhookLog.signatureValid=0` alert live (§c).
- [ ] fin-reconcile scheduled job + failure alert live (§c; resolves blueprint W4).
- [ ] Log rotation for `dev.log`/`server.log` (harness `tee`s forever).

CI
- [ ] `.github/workflows/ci.yml` green on the main branch (lint + fin-tests + fin-reconcile gated; tsc informational baseline tracked).
