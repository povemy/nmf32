# Deployment Preflight — NOMOFEE

**Mission:** Production Deployment, Staging Capacity Validation, and PSP Integration Readiness (Phase 0)
**Verified:** 2026-10-27 (UTC) · verifier: Z.ai Code orchestrator
**Repo state at verification:** `main @ 78ee258` (2026-10-27 01:44:47 UTC); worktree clean except runtime file `mini-services/expiry-scheduler/state.json` (scheduler heartbeat — expected).
**Method:** every claim below was re-measured today by direct command execution or file read in this sandbox. Nothing is inferred from report text alone.

---

## 1. Repository state

| Item | Value | Evidence |
|---|---|---|
| Branch | `main` | `git branch --show-current` |
| HEAD commit | `78ee258` (2026-10-27 01:44:47 UTC) | `git log -1` |
| Worktree | clean (only scheduler `state.json` modified — runtime state) | `git status --short` |
| Remote | `origin = https://github.com/povemy/nomofee` (fetch/push configured) | `git remote -v` |
| Remote state | `origin/main @ da11b68 "first commit"` — **local is 19 commits ahead; current code NOT pushed** | `git rev-list --count origin/main..main` = 19 |
| Secrets in git | `.env` removed from index at `78ee258` (was tracked with live secrets through `f8674c5`; history retains old values — repo was never pushed, exposure contained) | `git show --stat 78ee258` |

**Finding D-1 (blocker class: source control):** the remote repository exists but does not contain the application. A production deployment pipeline cannot build from `origin/main` today. Pushing requires GitHub credentials not present in this sandbox → **BLOCKED** (operator action: `git push origin main`, then protect branch + require CI).

## 2. Toolchain and runtime versions (measured today)

| Component | Version | Note |
|---|---|---|
| Next.js | **16.1.3** | App Router, Turbopack dev |
| Bun | **1.3.14** | runtime + package manager (`bun.lock`, 337,563 B, Oct 20) |
| Prisma CLI | **6.19.2** | `@prisma/client` declared `^6.11.1` (lockfile-pinned) |
| Node | v24.21.0 | available but not the app runtime |
| TypeScript | ^5 (5.x installed) | `next.config.ts` sets `typescript.ignoreBuildErrors: true` — see D-3 |
| PostgreSQL | **17.11 (Supabase, aarch64)** | measured via `select version()` |

## 3. package.json scripts (verbatim)

```
dev          bun run scripts/ensure-env.ts && next dev -p 3000
build        next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/
start        NODE_ENV=production bun .next/standalone/server.js
lint         eslint .
db:push      ensure-env → prisma db push --accept-data-loss
db:generate  ensure-env → prisma generate
db:migrate   ensure-env → prisma migrate dev
db:reset     ensure-env → prisma migrate reset
verify:finance  bun scripts/verify-finance-hardening.ts
```

- `output: "standalone"` is configured in `next.config.ts` → the build script's standalone copy steps are coherent with a container/VPS deployment.
- **No migration history is in use**: schema is managed with `prisma db push` (dev-style). For production, `prisma migrate` baselining is required (see D-4).
- Dependency install is reproducible via `bun.lock`; no second package manager is in play.

## 4. Deployment-artifact inventory (complete)

| Artifact | Present? | Detail |
|---|---|---|
| Dockerfile | **NO** | none anywhere in tree |
| docker-compose / compose.yml | **NO** | — |
| `.github/workflows` (CI) | **NO** | no CI of any kind |
| Platform manifests (vercel.json, fly.toml, railway.json, render.yaml, netlify.toml) | **NO** | — |
| Caddyfile | YES — **sandbox harness gateway, not a production proxy** | listens `:81`, forwards to `localhost:3000` + `XTransformPort` query routing; environment-provided, not operator-managed |
| Reverse proxy / TLS of our own | **NO** | no certificates, no domain config in repo |
| Scheduler service | YES — `mini-services/expiry-scheduler` (port 3005, `bun --hot`, durable `state.json`) | sandbox-local process; dies with the session (documented incident: dead for 35.5 h until restarted 2026-10-27 01:35 UTC) |

## 5. Hosting provider determination — **NOT ESTABLISHED (BLOCKED)**

The mission forbids assuming a provider from the presence of Docker (there is no Docker here anyway). Facts:

- No deployment CLI is installed/configured in the sandbox (no `vercel`, `flyctl`, `railway`, `render`, `doctl`, `gcloud`, `aws` authenticated contexts were found; no tokens in env).
- No platform manifests, no CI, no infrastructure-as-code.
- The only externally reachable surface is the sandbox preview URL served by the harness Caddy gateway on port 81 → localhost:3000. This is a **shared development preview, not a production host**, and it cannot be treated as one (no custom domain, no guaranteed uptime, session resets).
- The Supabase project (`tujvscnonmupldrqkqen`, ap-southeast-1) is the only provisioned external service, and only its database is used by the app (REST keys are validated and stored but the app data plane is Prisma→Postgres).

**Precise blocker:** choosing and authenticating a production hosting platform requires an account + credentials held by the business owner. None are available in this environment.

**Provider-specific steps that remain (do NOT skip to "deployed" without them):**

1. **Any provider (common first steps):** push current `main` to `origin` (`git push origin main`), enable branch protection, add CI (install with `bun install --frozen-lockfile`, `bunx prisma generate`, `bun run lint`, type-check, `next build`).
2. **VPS / container route (matches the standalone output already configured):** write a Dockerfile (multi-stage: `oven/bun` install+build → copy `.next/standalone`, `.next/static`, `public` → run `server.js`); run behind Caddy/nginx with automatic TLS; run `mini-services/expiry-scheduler` (or platform cron) as a supervised service (systemd unit / compose service with `restart: unless-stopped`).
3. **Vercel route:** set `SUPABASE_DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `PSP_WEBHOOK_SECRET` (and later provider secrets) in Project Settings → Environment Variables; replace the in-process scheduler with Vercel Cron hitting `POST /api/cron/expiry-sweep` and `POST /api/cron/refund-reconcile` at ≤60 s-equivalent cadence (Vercel Cron's minimum is 1×/min on most plans — acceptable: objective is ~60 s; verify with the provider's current docs); confirm the process-local checkout admission gate semantics under serverless (single-warm-instance assumption breaks — see production-topology.md §4).
4. **Supabase dashboard actions (blocked, no access):** create the **staging project** (isolated from production data), create separate API keys per environment, and later rotate keys.

Nothing in this phase invented a URL, host, credential, or successful deployment.

## 6. URLs and domains

| Item | Status |
|---|---|
| Current application URL | sandbox preview URL via harness gateway `:81` (internal; user-visible through the Preview Panel). Not a production URL. |
| Intended production domain | **not configured** (none declared in repo, env, or docs) |
| Staging domain | **not configured** (blocked on hosting provider) |

## 7. Scheduler, cron endpoints, CRON_SECRET (verified in code + live)

- `POST/GET /api/cron/expiry-sweep` — claim-first batch sweep (50/tick, throttle 1.5 s), per-group transaction, conditional `requires_payment → expired` claim, per-order `payment_pending → payment_expired` guard, stock increment + `InventoryLog` (`expiry:{ref}`), floor-guarded `salesCount` decrement, durable outcome in Setting `cron.expiry_sweep.last`.
- `POST/GET /api/cron/refund-reconcile` — PaymentReconciliation processor (batch 25, backoff 15 s, max 8 attempts, intent-before-call, provider calls outside tx, completion only from provider-authoritative record, no-adapter cases → `awaitingOperator`), durable outcome in Setting `cron.refund_reconcile.last`.
- Auth: `src/lib/cron-auth.ts` — **fail-closed in production when `CRON_SECRET` missing (503 CRON_NOT_CONFIGURED)**; timing-safe compare (sha256-digest + `timingSafeEqual`) when set; identical error for missing/wrong secret; secret never logged/echoed; `CRON_REQUIRE_SECRET=1` exists to exercise fail-closed in dev.
- **Live state today:** `CRON_SECRET` is **NOT set** in this sandbox `.env` (dev-open mode — intended for sandbox testing only). Scheduler mini-service RUNNING on :3005 (state.json: 212+ ticks, 0 consecutive failures, backlog 0, catch-up verified after the 2026-10-27 01:35 UTC restart).
- Production installation of the recurring invocation (platform cron / supervised service) is **BLOCKED** on the hosting decision (see §5 and scheduler-deployment.md).

## 8. Webhook routes, verification, idempotency, payment states (code-verified)

- `POST /api/webhooks/payments/[provider]` — rate limit 60 req/min/IP before parsing; raw body read before parse; HMAC-SHA256 over `"{providerRef}.{eventType}.{amountMinor}.{ts}"` via `X-SM-Signature` header or `body.sig`; **timing-safe compare**; **±10 min replay window** (stale → 400 STALE_EVENT); every delivery logged (`payment_webhook_logs.signatureValid`) **before** processing; unsigned/mismatched → 400 BAD_SIGNATURE, never processed.
- Success path: provider sandboxOnly enforcement (403 in production) → amount-must-equal-group-total (409 AMOUNT_MISMATCH) → claim-first **Serializable** tx (conditional `updateMany` status flip) → ledger T1 with dedupKeys → post-commit fan-out (notifications/webhooks/wallet-cache refresh moved out of tx, F1 remediation) → P2034 retry ≤3 with jitter.
- Duplicates: claim-loss returns `duplicate:true` (HTTP 200) so provider retries converge; ledger dedupKeys backstop double-posting.
- Late payment after expiry: 409 GROUP_EXPIRED + durable `PaymentReconciliation` obligation recorded BEFORE the refusal (both code sites verified); refund executed only by `/api/cron/refund-reconcile` via a `RefundAdapter` (mock-only today).
- Payout events (`payout.succeeded/failed`) share the claim pattern + `assertTransition` state machine.
- Mock PSP: `POST /api/checkout/payments/[ref]/simulate` (plays the PSP, signs the real webhook shape) + `POST /api/webhooks/payments/payout-simulate`; in production both refuse unless Setting `psp.mock.enabled=true` is explicitly set.
- **`PSP_WEBHOOK_SECRET` is NOT set** in this environment → documented public fallback secret `sm_webhook_secret_demo` is active (sandbox-only posture; production MUST set a real secret — and the chosen provider's actual signing scheme will supersede this generic HMAC, see psp-readiness docs).

## 9. Database / connection mode / pool (re-measured today)

- Supabase Postgres 17.11, project `tujvscnonmupldrqkqen`, region `aws-0-ap-southeast-1`.
- Connection: **Supavisor session pooler**, IPv4, `:5432`, `sslmode=require`, `connection_limit=10`, `connect_timeout=10` (from `SUPABASE_DATABASE_URL`; datasource deliberately keyed to this name — see schema comment).
- Measured now: `max_connections = 60`; current `pg_stat_activity` (client backends): 11 idle + 1 active (app pool + verification script).
- Full budget accounting: `performance/production-topology.md` (updated this mission, Phase 5).
- Supavisor client ceiling for this setup measured at 15 (EMAXCONNSESSION, worklog evidence 2026-10-25) — treated as an observation for this project tier, not a universal limit.

## 10. Environment validation & startup behavior (verified)

- `scripts/ensure-env.ts` runs before every `dev`/`db:*` script: validates the 4 Supabase keys, restores `.env` from `upload/.env.vault` when the harness resets it, refreshes `/tmp` snapshots; prints key names only, never values.
- `src/instrumentation.ts` → `instrumentation-node.ts` injects the same vars into `process.env` at server boot (Edge-safe split; never overrides explicit env; never logs values).
- `.env.example` documents all keys with placeholders (no secrets).
- Current `.env` (untracked) holds 5 keys: `SUPABASE_DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` (new-style publishable), `SUPABASE_SERVICE_ROLE_KEY` (new-style secret), `CHECKOUT_TIMING=1`. **`CRON_SECRET` and `PSP_WEBHOOK_SECRET` are absent (correct for dev; both required for production — fail-closed / unverified-webhook posture respectively).**
- Secrets-management platform (hosting provider secret store): **not accessible from this sandbox → BLOCKED**; values must be entered by the operator at deploy time.

## 11. Cross-check: reports vs code

- `performance/current-state-verification.md` and `performance/REPORT.md` §R/§O/§P were reconciled against the tree at `f8674c5`/`78ee258` in the previous session (addendum #3) and spot-verified again now: cron-auth, checkout-gate (default 8 inflight / 32 queue / 5 s admit), expiry-sweep, refund-reconcile, psp-refund, `PaymentReconciliation`/`PspRefundRecord` models, both `recordLatePaymentObligation` call sites, F1 fixes (P2034 retry, `SET LOCAL statement_timeout='10s'`, 15 s tx bound, post-commit wallet refresh) — **all present in code**.
- `git diff 6646301..HEAD` touches only env/boot-guard/docs files → the 2026-10-25 archived test evidence in `performance/runs/*.json` corresponds to the current business code.
- Live today: `/api/health` 200, `/api/market/home` 200, scheduler tick endpoints 200 (dev-open), DB reachable (version + counts above).

## 12. Findings & blockers (summary)

| ID | Finding | Class |
|---|---|---|
| D-1 | Current code never pushed; `origin/main` = initial commit only | BLOCKED (credentials) |
| D-2 | No hosting provider selected/authenticated; no production or staging domain | BLOCKED (decision + credentials) |
| D-3 | `typescript.ignoreBuildErrors: true` in next.config — production builds would skip type safety (lint/tsc must gate in CI instead; consider removing after a clean CI type-check) | Config risk (no code change made this mission) |
| D-4 | Schema managed by `db push`, no migration baseline — production needs `prisma migrate` baselining + reviewed migrations | Process gap |
| D-5 | No Dockerfile/CI/deployment manifests of any kind | Missing artifact (steps provided §5) |
| D-6 | Sandbox scheduler is process-local; production needs platform cron or supervised service | BLOCKED (hosting) |
| D-7 | `CRON_SECRET`/`PSP_WEBHOOK_SECRET` unconfigured (expected in dev; must be set via hosting secret manager in staging/prod) | BLOCKED (secret manager access) |
| D-8 | Production build **cannot be executed in this sandbox** (environment policy forbids `bun run build` here) → build validation is NOT TESTED locally; CI/staging must run it | NOT TESTED |

**No heavy load tests or destructive actions were performed in this phase.**

---

## Phase 2 verification results (2026-10-27, sandbox-bounded)

| Check | Result | Evidence |
|---|---|---|
| Dependency install reproducible | PASS (lockfile intact; `bun.lock` Oct 20 unchanged) | `bun.lock` 337,563 B |
| Prisma Client generation | PASS | `bun run db:generate` clean |
| ESLint | PASS (0 errors) | `bun run lint` exit 0 |
| TypeScript `tsc --noEmit` | **60 pre-existing error lines across ~20 files** (compensating check for `ignoreBuildErrors: true`); files added this mission are clean | `bunx tsc --noEmit` 2026-10-27 |
| Production build execution | **NOT TESTED — sandbox policy forbids `bun run build` here** (D-8). CI/staging must run: `bun install --frozen-lockfile` → `bunx prisma generate` → `bun run lint` → `bunx tsc --noEmit` (after fixing the 60 errors or gating them) → `bun run build` → `bun run start` (standalone server, `NODE_ENV=production`) | — |
| Env validation at boot | PASS (verify: ensure-env restores stale `.env` from vault; instrumentation injects at boot even for direct `next dev`; re-proven today by the manual dev-server restart) | worklog 2026-10-27 + today's restart |
| Public/authenticated routes | PASS (22/22 deployment smoke: root page, market, images, auth, order history) | `performance/runs/2026-10-27-deployment-smoke.json` |
| Checkout → mock payment → webhook → wallet/inventory behavior | PASS (smoke C1–C9: idempotent checkout, stock reserve/sell, T1 exactly-once, duplicate convergence, unsigned/stale rejection, buyer history) | same |
| Graceful startup/shutdown/restart | PASS (dev-mode): full restart cycle today (kill → boot → health 200 → scheduler ticks resume; catch-up behavior per scheduler-e2e E1–E3) | dev.log + `runs/2026-10-27-scheduler-e2e.json` |
| Docker production image | N/A — no Dockerfile exists (D-5); steps provided §5 | — |

**Reverse-proxy/TLS items (Phase 2.2)** — all BLOCKED on the hosting decision; requirements checklist for provisioning: TLS + auto-renewal; correct `X-Forwarded-*` (sandbox Caddyfile already forwards Host/Proto/For — reference implementation); body-size limits ≥ webhook payloads; request timeouts > webhook tx bound (15 s) + sweep duration; webhook route reachable + signature verified (verified in dev); secure cookies (session cookie `sm_session` httpOnly — verify `Secure` flag once HTTPS exists); CORS/trusted origins (single-origin SPA today); request IDs + structured error logs (current: console + payment_webhook_logs + orderStatusHistory); `/api/cron/*` authenticated (verified fail-closed design; set CRON_SECRET in staging); no admin/metrics/debug endpoints public (admin routes behind `requireAdmin` — re-verify via staging smoke D-section).
