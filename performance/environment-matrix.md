# Environment Matrix — NOMOFEE

**Mission phase:** 1 (safe staging and production environments) · **Created:** 2026-10-27 (UTC)
**Status legend:** ✅ exists & verified · 🚧 partially exists · ❌ not provisioned (blocked)

---

## 1. Environments

| Dimension | **Development** | **Staging** | **Production** |
|---|---|---|---|
| Status | ✅ running (this sandbox) | ❌ **NOT PROVISIONED — BLOCKED** (needs Supabase project + hosting; no dashboard/account access in this environment) | ❌ **NOT PROVISIONED — BLOCKED** (hosting provider undecided; see deployment-preflight.md D-2) |
| Purpose | feature development, functional regression, safe scheduler/payment e2e (all dev-mode) | production builds, external load tests, scheduler durability tests, PSP sandbox integration, smoke tests before release | real traffic and real financial transactions **only** after all readiness requirements pass |
| Host | sandbox Next.js dev server `:3000` behind harness gateway `:81` (shared preview) | intended: production-mode build on the chosen host, separate domain (e.g. `staging.nomofee.com`) | intended: production-mode build on the chosen host, primary domain |
| Database | Supabase project `tujvscnonmupldrqkqen` (dev — currently SHARED by dev and all sandbox testing; contains demo + [LT] test data) | intended: **isolated Supabase project** (separate instance, not a schema in the dev/prod instance) with production-like settings | intended: dedicated Supabase project with own keys |
| Pool config | Supavisor session pooler `:5432`, `connection_limit=10`, `connect_timeout=10` | same mode/limits as production (see production-topology.md) | Supavisor session pooler, `connection_limit=10` (single instance — see topology doc) |
| Payment mode | mock PSP only (`simulate` endpoints, public fallback webhook secret) | mock PSP **or** the chosen provider's official sandbox — never real charges | real PSP only; mock endpoints refuse unless Setting `psp.mock.enabled` explicitly true |
| Scheduler | mini-service `expiry-scheduler` on `:3005` (30 s interval, dev-open auth) | platform cron or supervised scheduler service + `CRON_SECRET` set — must be verified end-to-end | same as staging; fail-closed without `CRON_SECRET` |
| `NODE_ENV` | development | production (production build) | production |
| Secrets in env | `.env` (untracked; auto-restored from `upload/.env.vault`); `CRON_SECRET`/`PSP_WEBHOOK_SECRET` intentionally absent | hosting secret manager: `SUPABASE_DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `PSP_WEBHOOK_SECRET` (or provider-specific equivalents) | same set as staging + real provider credentials; rotation procedure documented in scheduler-deployment.md |
| Data ownership | demo dataset + `[LT]`-prefixed test records (products titled `[LT] …`, shoppers `@lt.test`, idemKeys `lt-*`) | isolated staging dataset seeded by script; `[LT]` records for load tests | real customer/vendor data; **no test records ever** |

### Prohibited actions (binding)

- **Development:** no claims about capacity; no real charges (mock rails only); never expose sandbox preview as "production".
- **Staging:** heavy load tests allowed ONLY through the target-guarded runner (below); never real charges/refunds/payouts/shipping bookings/customer communications; never import real customer data or payment secrets; cleanup may only touch `[LT]`-owned records.
- **Production:** no heavy traffic tests, ever (only explicitly authorized, non-mutating smoke checks); no OOM/destructive chasing; no test records.

## 2. Fail-closed load-test target identification (VERIFIED 2026-10-27)

Implemented in `scripts/readiness/target-guard.ts`, wired as the first statement of `scripts/readiness/load-scenarios.ts`; app side is `/api/health` `deployment` block (`nodeEnv` + non-sensitive 16-hex `dbFingerprint` = sha256(poolerHost|databaseOid|maxConnections)).

Rules (all must hold before ANY load-test request is sent):

1. `LOADTEST_TARGET_CONFIRM` explicitly `dev-sandbox-local` or `staging` — anything else (unset, `production`, typo) refuses.
2. Target app's `/api/health` must answer and report `deployment.nodeEnv ≠ production`.
3. App's `deployment.dbFingerprint` must EQUAL the fingerprint the runner computes from its OWN database connection (proves runner + app exercise the same DB — the dataset cleanup will touch).
4. Staging runs additionally require `LOADTEST_DB_FINGERPRINT` pinned to the staging app's published fingerprint (second, independent confirmation that the DB is the isolated staging database).

**Evidence:** `performance/runs/2026-10-27-target-guard.json` — 7/7 PASS (unset → REFUSE · `production` → REFUSE · dev-sandbox-local → CONFIRM · staging-unpinned → REFUSE · staging-wrong-pin → REFUSE · staging-right-pin → CONFIRM · unreachable → REFUSE). Re-run: `bun scripts/readiness/target-guard-matrix.ts`.

**Cleanup ownership:** all harness fixtures are `[LT]`-scoped — products titled `[LT] …`, shoppers `lt-…@lt.test`, carts deleted only for those exact emails, variants restored to their own pre-test stock (see `scripts/readiness/lib.ts`). Cleanup queries can never match non-test rows.

## 3. Staging provisioning — exact remaining steps (BLOCKED on access)

None of the following have been performed (no Supabase dashboard access, no hosting credentials in this sandbox):

1. **Supabase:** create new project (suggested region `aws-0-ap-southeast-1` to match production intent); note its pooler URL; create its API keys; record its `/api/health`-style fingerprint once the staging app boots.
2. **Hosting:** choose provider (see deployment-preflight.md §5 options); create staging app + domain with TLS; configure env vars via the provider's secret manager; deploy the production build; start the platform scheduler (≤60 s cadence) with `CRON_SECRET`.
3. **Data:** run the seed (`bun prisma/seed.ts` pointed at the staging DB) → verify catalog/vendors/test shoppers; keep payment mode mock (or provider sandbox when available).
4. **Verification:** run the deployment smoke script (Phase 2), scheduler e2e (Phase 3), then the external load ladder (Phase 6) — all through the target guard with `LOADTEST_TARGET_CONFIRM=staging` + pinned fingerprint.

## 4. Known staging↔production differences to document at provisioning time

- Resource sizing (staging may use a smaller instance than production) — capacity numbers must be labeled with the staging tier and not silently extrapolated.
- PSP mode (mock/sandbox vs real provider) — refund/reconciliation behavior is provider-dependent.
- Data volume (seeded dataset vs real catalog) — affects DB plan and cache behavior.
- Scheduler implementation (platform cron vs supervised service) must be IDENTICAL in design (interval, endpoints, auth) even if the mechanism differs.
