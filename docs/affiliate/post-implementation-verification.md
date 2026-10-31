# Affiliate System — Post-Implementation Verification

**Date:** 2026-10-31 · **Environment:** dev sandbox (`bun run dev`, port 3000) against the live Supabase Postgres dev database · **Companion:** `post-implementation-audit.md` (findings) · This document records WHAT WAS RUN and WHAT PASSED, separating evidence classes.

---

## 1. Evidence classification used in this report

| Class | Meaning |
|---|---|
| **Implemented** | Code exists at the cited path (code-review evidence only) |
| **Runtime tested** | Exercised via HTTP/DB against the running dev server (curl/scripts) |
| **Browser tested** | Exercised through the rendered UI (agent-browser + screenshots + VLM verification) |
| **Production-build tested** | NOT performed (`bun run build` is forbidden in this sandbox) — nothing in this report claims it |
| **Staging tested** | NOT performed — no staging environment exists |
| **Disposable-DB tested** | Executed against a purpose-created, then destroyed, database |

---

## 2. Runtime test results (all on 2026-10-31, post-fix)

### 2.1 Rounding edge-case suite — `scripts/test-affiliate-rounding.ts` (NEW)
- 140+ assertions: 8 mandated amounts (RM0.01/0.05/0.09/0.10/0.99/1.00/10.01/99.99) × 8 rates (0.5%–25%) on the REAL production functions (`affiliatePoolMinor`, `splitAffiliatePool`), plus reversal-step and entry-split cases and two floor-vs-half-up divergence detectors.
- **Result: ALL PASS** (`bun scripts/test-affiliate-rounding.ts`).

### 2.2 Affiliate E2E chain (existing harness, re-run post-fix)

| Stage | Script | Result |
|---|---|---|
| 1 — setup → chain → enrol → links → attribution → multi-store checkout → payment | `tool-results/e2e-affiliate.sh` | **P=14 F=0** ✔ (checkout+payment pass with the new snapshot column write) |
| 2 — exact math, ledger, idempotency, lifecycle | `tool-results/e2e-affiliate-2.sh` | **P=7 F=0** (duplicate webhook no-op; entries matured; M1 math re-verified directly: pool=1990, D=1791, S=199, D+S=P; no-sponsor D=890=P) |
| 3 — payout → refund → reconciliation → kill switch | `tool-results/e2e-affiliate-3.sh` | Payout machine ✔ (request→approve T-A3→mark-paid w/ E2E-BANK-001, entries paid, statement built); reversal ✔ (affiliateReversalMinor=995); reconciliation `invariantOk=true` ✔; kill switch ✔. Residual ✘ marks are stale assertions in this superseded variant (see 3b) |
| 3b — corrected assertions | `tool-results/e2e-affiliate-3b.sh` | **REVERSAL-OK: 896(direct, live)+99(sponsor, paid→recovery)=995 — spec §11 exact** ✔; kill switch: no attribution touch while disabled (5→5), resumes on re-enable (5→6) ✔ |

Known harness artifacts (not app defects): stage-3's payout-state inspection used an invalid Prisma include (fixed in `-3b` which queries by `payoutId`); stage-3's overview assertion reads a retired response key; `-3b`'s `all commissionStatuses == 'paid'` is over-strict for multi-beneficiary commissions (a commission whose other-beneficiary entry is unclaimed correctly stays `available`).

### 2.3 P3 policy-freeze E2E — `tool-results/e2e-p3-policy-freeze.sh` (NEW)
**The mandated test #8 ("Policy setting changed between checkout and payment"). Result: P=16 F=0.**
1. Sponsor override ON at checkout → `OrderItem.affiliateSponsorEnabled=true` frozen (NM-103672, pool 890 sen).
2. Admin flips `affiliate.sponsor_enabled=false` BEFORE payment.
3. Payment lands → commission posts the FROZEN 90/10: direct=801, sponsor=89 (S=floor(890/10)), D+S=P ✔.
4. New checkout AFTER the flip → snapshot `false`; its payment posts D=P=890 with NO sponsor entry ✔.
5. Sandbox setting restored.

### 2.4 Financial platform suites (regression)

| Suite | Result |
|---|---|
| `scripts/verify-ledger.ts` (ledger double-entry + wallet truth vs cache) | **FINANCIAL-GATE: ALL PASS** — 431 txns / 1,303 lines, every wallet consistent |
| `scripts/readiness/finance-regression.ts` (wallet/ledger, fault injection, dedup backstop) | **ALL PASS** — injected fault fails first attempt; retry posts EXACTLY ONE transaction; fixture reconciled; ledger balanced |
| `scripts/readiness/deployment-smoke.ts` (with `LOADTEST_TARGET_CONFIRM=dev-sandbox-local`) | **ALL PASS** — duplicate webhook converges + T1 exactly-once; unsigned webhook 400 BAD_SIGNATURE; stale replay 400 STALE_EVENT; stock never double-released; cron observability; scheduler liveness (ticks=3308) |

### 2.5 Collections/showcase gating (curl smoke)
- `POST /api/affiliate/collections` (active affiliate) → **403 COLLECTIONS_DISABLED** ✔
- `GET /api/affiliate/pub/showcase/alpha-promotes` → **`{found:false}`** (fail closed, no data leak) ✔
- Kill-switch family already covered by E2E §2.2.

### 2.6 Unified login API (curl)
- admin@nomofee.io → 200 `userType:"admin"` + superadmin payload ✔
- lumina@nomofee.io → 200 `userType:"seller"` + store payload ✔
- aff-alpha@verify.nomofee.io → 200 `userType:"shopper"` + `isAffiliate:true` ✔
- wrong password → uniform **401 INVALID_CREDENTIALS** ✔
- `GET /api/auth/dev-accounts` with the dual gate ON → 200 with verified accounts list ✔ (gate OFF → 404, indistinguishable from a missing route)

### 2.7 Scale probe — `scripts/perftest-affiliate-scale.ts` + `scripts/perftest-measure.ts` (NEW)
Disposable-DB class. 2,001 shoppers/profiles (one sponsor, 2,000 referrals) + 400 entries seeded in 1.88 s; code lookups ~39 ms (RTT-bound); network pages 39–77 ms with deep page (skip 2,980) = 39.6 ms; earnings groupBy 85.6 ms; **EXPLAIN: Index Scan on `AffiliateProfile_sponsorId_idx`**. Database dropped after the run (verified). NOT production capacity evidence.

### 2.8 TypeScript / lint
- `bunx tsc --noEmit`: **0 errors in src/**·(pre-existing drift confined to `scripts/fin-*.ts` and `tool-results/`, unchanged).
- `bun run lint`: **0 errors** (20 pre-existing warnings, unchanged count).
- Dev log during all testing: no runtime errors attributable to the changes.

---

## 3. Browser verification (agent-browser, Chromium)

| Flow | Result |
|---|---|
| Marketplace home renders | ✔ (full interactive tree) |
| Unified sign-in dialog (shopper surface): email/password, show/hide toggle, NO portal selector | ✔ |
| Dev-credentials panel: exact "Development Test Accounts — Sandbox Only" collapsible; 12 accounts (4 admin / 5 seller / 2 buyer / 1 affiliate) with per-field copy buttons; copy → "copied" state verified | ✔ |
| Buyer login via unified panel (aisyah@nomofee.test) | ✔ "Welcome back!" → signed-in header |
| Admin surface: buyer credentials on the admin card | ✔ toast "This account is not an administrator — opening the marketplace instead"; NO console access (server-side gates intact) |
| Admin login via unified card (admin@nomofee.io) | ✔ Admin Console renders (Dashboard/Sellers/Orders/…) |
| Admin → Affiliate → Commissions: server-side order-number search | ✔ typing "NM-103672" narrows scope "12 commissions" → "1 commission · Pool RM 8.90 · Base RM 89.00" (the freeze-test order) |
| Commissions filters: store Select ("All stores"), status, from/to date inputs, scope totals line | ✔ (visual + DOM verified) |
| Affiliate Hub tabs | ✔ exactly 6: Overview · Discover · Links · Network · Earnings · Payouts — **Collections & Showcase removed** |
| Links → New link dialog | ✔ type options Product/Store ONLY; channel defaults "Other" (optional); label optional; participating product feed with rates |
| Mobile 390 px login dialog | ✔ fits viewport, full-width 44px-touch fields, dev panel visible |
| Console errors / page errors during the session | ✔ none |

---

## 4. Demo-account verification (P12 source-of-truth)

`bun scripts/ensure-demo-accounts.ts` (NEW, idempotent): shopper-side accounts verified/created/reset (aisyah@nomofee.test password had drifted → reset to the documented `NOMOFEE123!`); affiliate demo profile ensured; 9 seed-managed accounts verified — **3 verified + 1 reset + 9 seed-verified, 0 drift** at run time. The dev-accounts API re-verifies every password per request and omits drifted accounts rather than guessing.

**Displayed credentials (exact list):**
Admin: `admin@nomofee.io`/`Admin123!` (superadmin) · `ops@nomofee.io`/`Ops12345!` · `finance@nomofee.io`/`Finance123!` · `moderator@nomofee.io`/`Mod12345!` — Seller: `lumina@nomofee.io`, `byte@nomofee.io`, `glow@nomofee.io`, `warung@nomofee.io`, `trail@nomofee.io` (all `Seller123!`) — Buyer: `aisyah@nomofee.test`/`NOMOFEE123!` · `qa.shopper@nomofee.test`/`Shopper123!` — Affiliate: `aff-alpha@verify.nomofee.io`/`Verify123!`

**Exact display condition:** `NODE_ENV === "development"` **AND** `NOMOFEE_SHOW_DEV_LOGIN_CREDENTIALS === "true"` (server-side dual gate on the API; the component renders nothing unless the API returns 200). Production build: no flag in `.env.example` default, no bundled data — see §7.

---

## 5. Migration reproducibility evidence (P8)

Chain: `0_init` → `20261030000000_affiliate_system_baseline` (affiliate DDL drift, 430 lines, captured via `prisma migrate diff --from-migrations --to-schema-datamodel` with a shadow DB) → `20261031000000_orderitem_affiliate_sponsor_policy_snapshot` → `20261031000001_affiliate_collection_profile_fk`.

| Verification | Result |
|---|---|
| Clean-room deploy ×3 (disposable DBs `nomofee_migtest`, `nomofee_migtest2`, `nomofee_perftest`) | All migrations apply from empty ✔ |
| Idempotent re-run | `No pending migrations to apply` ✔ |
| Schema parity after deploy | `migrate diff --from-url --to-schema-datamodel` = EMPTY ✔ (×3) |
| Destructive statements | none in any generated DDL ✔ |
| Live DB deployment | baseline `migrate resolve --applied` (no re-run of already-pushed DDL) + additive deploys; affiliate records/business data intact afterwards ✔ |
| Disposable DB cleanup | all dropped & verified (initially masked by pooler sessions; terminated + dropped via raw SQL) ✔ |

**Production deployment sequence (documented, not executed):**
1. Backup: `bun scripts/backup-db.ts` (or Supabase PITR point noted).
2. `SUPABASE_DATABASE_URL=<prod> bunx prisma migrate deploy` — applies `20261030000000` (if the prod schema was only `db push`-ed, FIRST `bunx prisma migrate resolve --applied 20261030000000_affiliate_system_baseline` exactly as done in the dev DB), then the two additive migrations.
3. Verify: `bunx prisma migrate diff --from-url $URL --to-schema-datamodel prisma/schema.prisma` must print an empty migration.
4. Verify data: affiliate row counts + `bun scripts/verify-ledger.ts` equivalent.
5. Confirm settings baseline: `affiliate.enabled` deliberate, `affiliate.sponsor_enabled=false`, `affiliate.collections_enabled=false`, `affiliate.showcase_enabled=false`.
6. Never run `prisma migrate reset` or `db push --accept-data-loss` against production.

---

## 6. What was NOT tested (honest boundaries)

- **Production build** (`bun run build` / standalone start) — forbidden in this sandbox; the dual-gated dev-credential endpoint is server-side gated (404 without the flag) and carries no bundled data, but a production-build smoke remains a pre-deploy step.
- **Staging** — no staging environment exists; all E2E here is dev-sandbox class.
- **10,000-affiliate load test** — deliberately not executed (shared-database guardrail); 2,000-referral structural probe + index verification instead.
- **Legacy `scripts/fin-tests.ts`** — unrunnable (pre-existing API drift, documented).
- Chargeback webhook shape, COD rails — out of scope (no COD rails exist; chargebacks ride the refund family).
- Multi-instance rate-limit store in staging (Redis unproven — pre-existing launch gate).

## 7. Dev-credential cleanup procedure (when development finishes)

1. Remove `NOMOFEE_SHOW_DEV_LOGIN_CREDENTIALS` from `.env` / the vault (panel + API 404 immediately).
2. Optionally delete `src/components/auth/dev-accounts-panel.tsx` + the `DevAccountsPanel` render + `GET /api/auth/dev-accounts` when no longer needed.
3. Rotate sandbox demo passwords: re-run `bun scripts/ensure-demo-accounts.ts` after editing its documented values, or edit the seed fallbacks (`SEED_*_PASSWORD` env overrides for admins/sellers).
4. Pre-deploy check: `grep -r "NOMOFEE123!\|Verify123!\|Admin123!" .next/` (build output) — expect zero hits (credentials live only in DB/seed, never in client bundles).
5. Genuine accounts are never touched by any of the above.
