# NOMOFEE — FINAL SECURITY CLOSURE REPORT
## Guest Order Ownership, Email Verification & Database Safety

**Date: 2026-11-01 (final session) · Scope: targeted follow-up to Phase 2.1 —
no Phase 1/2/2.1 work was restarted or reverted; every prior successful
implementation is preserved.**

**Evidence base:** `tsc --noEmit` → **0 errors in `src/`**; **180/180 unit
tests** (164 prior + 16 new, `bun test`); ESLint → **44 errors, byte-identical
pre-existing baseline** (zero new); live read-only HTTP verification of every
changed route against the running dev server (below); Agent Browser control
experiment for the SPA boot limitation. **Zero new database connections, zero
migrations applied, zero cleanup/financial operations executed.** One new
migration **created, not applied** (now six outstanding). No commits created.

---

## 1. Confirmed vulnerabilities and changes

| # | Confirmed vulnerability (verified in code before changing anything) | Fix shipped |
|---|---|---|
| V1 | **Knowledge-pair authorization bypass.** `GET /api/orders/lookup` and `/api/orders/receipt` released order data (receipt incl. NAME/EMAIL/PHONE) to anyone holding the customer's email + NM- order number — the rejected Phase 2.1 draft kept this path alive by accepting "pair OR grant". | Knowledge pair removed as an authorization factor on both routes. It can now only REQUEST an OTP challenge (`POST /api/orders/otp/request`). Data requires a verified grant or an owning session (§2). **Live-verified:** pair → 401 for a REAL order (NM-100036/681 era fixtures), ghost order → byte-identical 401. |
| V2 | **Unverified guest-order claiming at registration/login.** `claimGuestStateForShopper` transferred legacy guest orders (full PII) into any account whose EMAIL STRING matched — registration performs no email verification, so an attacker registering a victim's email absorbed the victim's guest orders. | The ownership gate now lives INSIDE `claimGuestStateForShopper` (no call site can bypass): claiming requires a verified email-ownership proof (`EmailOtpChallenge`, purpose `shopper-email`). Registration no longer claims at all (§3). **Live-verified:** demo login returns `claimed { ordersClaimed: 0, skipped: "email-unverified" }, emailVerified: false` — login itself fully functional. |
| V3 | **Robustness defect found during live verification:** with a stale Prisma client (dev server predating `prisma generate`), the storage probe and the claiming gate threw bare TypeErrors (500s; login breakage risk). | Missing-model guard added (`emailOtpModel()`): a client without the model fails closed exactly like a missing table — 503 on OTP routes, unverified on the gate. **Live-verified:** OTP verify now answers uniform 503 `EMAIL_OTP_UNAVAILABLE`; login works. |

**Preserved (verified, not regressed):** guest checkout pathways and NM- order
numbers; shopper registration; claiming after successful verification;
existing orders/identifiers/shopper data; chat authorization (strictly
`order.shopperId === me.id`, no email fallback); all Phase 1/2/2.1 hardening
(session hashing, MFA model, import-cap budget, cache invalidation,
search normalization — untouched files).

## 2. Revised OTP authorization model (mandate §1)

```
email + NM- number  ──►  POST /api/orders/otp/request      (REQUEST ONLY)
                             │ uniform 200 — no existence oracle;
                             │ 503 pre-flights run BEFORE any lookup
                             ▼ 6-digit code → the email ON the order
                        POST /api/orders/otp/verify          (CAS consume)
                             │ uniform 401 for every failure mode
                             ▼ 15-min order-specific HMAC grant
lookup/receipt authorized by EXACTLY ONE OF:
  (a) Authorization: Bearer <grant>   (b) owning shopper session
everyone else → uniform 401 ORDER_VERIFICATION_REQUIRED (order table untouched)
```

Grant properties (all unit-tested + live-tested): order-specific (orderId in
HMAC + orderNumber cross-check), purpose-specific (`oag:v1:` domain + dedicated
`ORDER_ACCESS_SECRET` — not an import cap, not a session), 15-min absolute TTL,
no refresh, constant-time MAC, never logged, **never in client-side persistent
storage** (module-memory Map only — reload drops it). Receipt keeps its
independent payment gate (409 while unpaid) — live-verified: unauthenticated →
401 *before* the gate (never 409), grant-holder on an unpaid order → 409.

**Live evidence matrix (read-only, this sandbox):**

| Probe | Result |
|---|---|
| Knowledge-pair lookup, existing order | 401 `ORDER_VERIFICATION_REQUIRED` |
| Knowledge-pair lookup, ghost order | byte-identical 401 |
| Forged / tampered grant on lookup + receipt | 401 |
| Valid grant (dev-secret mint) + matching orderNumber | 200 + order data |
| Valid grant + wrong orderNumber | 401 (order-specific) |
| Receipt via valid grant (paid order) | 200 `application/pdf` |
| Receipt unauthenticated (unpaid order) | 401 — gate never leaks |
| Owning session lookup + receipt | 200 + PDF |
| OTP request without provider | uniform 503 `EMAIL_PROVIDER_NOT_CONFIGURED` (pre-lookup) |
| OTP verify before migration | uniform 503 `EMAIL_OTP_UNAVAILABLE` (pre-lookup) |
| Login with gate active | 200, `emailVerified:false`, nothing claimed |
| Session-purge cron with table missing | 200, sweeps 0 (P2021-tolerant) |

## 3. Guest registration and claiming protections (mandate §2)

- **Registration:** creates the account + session as before (never blocked by
  email delivery), best-effort sends a verification code when a provider
  exists, and **claims nothing**. Response adds `emailVerified:false` +
  `emailVerificationSent`.
- **Gate (defense in depth):** inside `claimGuestStateForShopper` — login,
  unified-login and the verify route all flow through it; future callers
  cannot bypass it. P2021/stale-client tolerant (→ unverified → claiming
  disabled — fail-closed, login unaffected).
- **Verification flow:** Me → Profile card (shown while unverified; displays
  NO unclaimed-order counts — an unverified account holder must not learn how
  many guest orders exist for the address) → code to the account's own email
  → `POST /api/auth/shopper/email-verification/verify` → CAS-set `verifiedAt`
  → exactly ONE winner claims; re-verify answers `alreadyVerified` +
  `ordersClaimed: 0`; re-login claims nothing new (idempotent null-filter).
- **Attack scenario (staging script §8, prepared):** guest order → register
  with the victim's email → login claims NOTHING, order stays
  `shopperId = null`, account cannot even READ it (401) → verification →
  both orders claimed exactly once.

## 4. Email-provider requirements (mandate §4)

No real delivery exists and **nothing was simulated**: `src/lib/email-provider.ts`
ships the `TransactionalEmailChannel` interface + fail-closed selection seam
only (`getEmailChannel()` → null today; naming `EMAIL_PROVIDER` without an
adapter logs loudly). All OTP security logic depends solely on the interface —
the provider decision (Resend / Postmark / SES / Supabase-Auth-mailer) lands
later as one ~40-line adapter + the selection switch, with zero security-logic
changes. Registration verification already rides the same channel.

Operational prerequisites (documented in
`docs/security/guest-order-otp-design.md` §6): sending domain + SPF/DKIM/DMARC;
provider API credentials in the deployment secret store (never the repo);
bounce/complaint handling (hard bounce → issuance disabled for the address via
provider webhook; delivery failures audited `email.otp.delivery_failed` —
already wired); provider rate ceilings above the route limits; email
templates; ids-only audit logging. **No real email is sent until an authorized
provider is configured.**

## 5. Database provenance and test residue (mandate §5 — no DB access)

**Method:** existing metadata only — the Phase 2.1 retrospective audit
(`docs/security/phase21-implementation-report.md` §A), both prior
implementation reports, `tool-results/` artifacts, `dev.log`, and the
scheduler `state.json`. **No database connection was opened by this closure.**

**Known (from Phase 2.1 §A, unchanged by this session):**
- Exactly ONE `SUPABASE_DATABASE_URL` exists in this sandbox (Supavisor session
  pooler, aws-0-ap-southeast-1); the app, all scripts and all prior phases
  used it. It is consistently referred to as "the dev database", seeded with
  demo data.
- **UNVERIFIABLE from this sandbox: whether that same project is also the
  owner's deployed production application.** No production/staging URL, secret
  or config exists here; nothing else could ever have been connected to.
- Extensive TEST financial activity exists in that database and is **balanced
  and audited** (ledger invariants PASS via `/api/health` — re-confirmed
  read-only this session): test orders, T1/T3/T4/T5/T6 postings, payouts,
  refunds, wallet top-ups, documented residue rows (NM-100036/037/038/039/040,
  NM-103658/59, FIN-4 idempotency-keyed orders).
- The only bulk DELETE ever executed in project history was 483 EXPIRED
  `Session` rows; no ledger row was ever edited or deleted.

**Explicit warning:** **a balanced ledger can still contain test financial
activity — the invariants passing must NOT be mistaken for genuine business
activity.** Every number in that database must be treated as test/dev data
until provenance is established by its owner.

**No deletion, reset, reversal or modification of any test financial record
was performed by this session, and none is authorized for future sessions
without owner sign-off.** No cleanup or migration was executed.

**Recommendation (standing):** if the current dev project is — or might be —
shared with the owner's production deployment, provision a **separate staging
project** before any further staging work, and gate the deployment runbook's
step 0 on confirming the target project ref against the deployment ticket.

## 6. Test results (executed vs staging-only — mandate §7)

**EXECUTED (this sandbox, no DB writes):**
- Unit: `src/lib/__tests__/guest-otp.test.ts` — 16 new tests (code CSPRNG
  uniformity/padding; input normalization; day-bucket math; **UTC-midnight
  rollover** (pinned 2026-11-04T23:55Z → 2026-11-05T00:05Z); challenge binding
  (purpose/subject/code/bucket); HMAC construction; grant round-trip / exact
  TTL / order-specificity / tamper / forged / malformed / session-token
  non-collision). Suite total: **180/180**.
- Live route probes: the full matrix in §2 (all read-only).
- `tsc` 0 errors in `src/`; ESLint 44 pre-existing errors only (baseline
  unchanged); dev server healthy (all six cron jobs ticking; session-purge
  P2021-tolerant).

**STAGING-ONLY (prepared, NOT executed — require authorized staging with
migration 20261104000000 applied + configured provider or Mailpit):**
`scripts/readiness/guest-order-otp-e2e.ts` — the full mandate §7 matrix:
knowledge-pair denial + uniformity; OTP request uniformity; brute-force
lockout (5 wrong → correct code still rejected while unexpired); grant
issuance; replay prevention; grant expiry/wrong-order/forgery; receipt
authorization ordering (401-before-409); **the registration attack scenario**;
exactly-once claiming; concurrent-claim CAS (inherent in 9c); authenticated
ownership + foreign-session denial. Honest code retrieval only: Mailpit REST
inbox (a real local provider) or operator-supplied code — no simulated
delivery. Zero financial writes (test orders stay `payment_pending`).

**Browser verification:** the SPA does not finish hydrating in this sandbox's
headless browser. **Control experiment (this session): with ALL final-closure
changes stashed, the pristine tree hangs identically** ("Loading NOMOFEE…",
zero API calls) — i.e. the pre-existing, documented WS/HMR sandbox limitation
(Phase 2 §G.2 / Phase 2.1 blocker #6), **not a regression**. Changes were
restored and re-verified afterwards (tsc/tests/live routes green). SPA-level
acceptance remains a staging-day item (test pack §7 + runbook §4.6).

## 7. Remaining migration and staging requirements

- **Six migrations now sit unapplied** (five from Phase 2.1 + NEW
  `20261104000000_final_email_otp` — additive `EmailOtpChallenge` table;
  created NOT applied; no column added to any existing table, so pre-migration
  operation is fail-closed-inert). Apply order = numeric; session-token
  hashing first (hard rule). Runbook updated for six + the new verification
  steps.
- **Session-token migration SQL re-confirmed:** `encode(sha256(convert_to(
  "token",'UTF8')),'hex')` is byte-exact with Node's
  `createHash("sha256").update(token).digest("hex")` (UTF-8 + lowercase hex;
  app tokens are 64-hex ASCII). Core pg_catalog functions — no extension.
- **Rollback instructions corrected/clarified:** the runbook now states the
  HARD RULE — never redeploy a pre-Phase-1 build against hashed session
  tokens; the PITR restore MUST precede any old-code redeploy (the previous
  text was order-correct but implicit; it is now explicit with the failure
  mode spelled out, incl. the raw-token re-write hazard). A controlled
  maintenance window / traffic drain is required for the session migration.
- **Prerequisites for the OTP features on staging/prod:** `EMAIL_OTP_SECRET` +
  `ORDER_ACCESS_SECRET` (fail-closed, boot-loud); migration 6 applied; the
  email provider decision (may land later — routes stay fail-closed 503 and
  lookup/receipt degrade to owning-sessions-only, which is safe).
- **Pre-migration runtime contract (current dev sandbox):** OTP/email-
  verification routes 503 uniformly; claiming disabled; lookup/receipt accept
  grants (verified live) and owning sessions only.

## 8. Updated public-launch blockers (explicit)

Public production readiness is **NOT declared.** Current blockers:

1. **Email provider decision + adapter** — the single external dependency for
   guest-order OTP and registration verification (fail-closed until landed).
2. **Database authorization** — apply the six migrations and execute the
   staging test pack (incl. the new `guest-order-otp-e2e.ts`) in an authorized
   environment; decide the migration-4 hot-table path (CONCURRENTLY vs
   in-transaction) at deployment time by row counts.
3. **Provenance decision** — confirm whether the sandbox's Supabase project is
   shared with production; if so (or if unknown), provision a separate staging
   project (§5) — a balanced test ledger must never be promoted as production
   data.
4. **Privileged admins MFA-enrolled** (rollout list, Phase 1 §F) before the
   enrollment gate stops answering 403.
5. **Staging load ladder** with measured capacity numbers; cache/invalidation
   re-validated on staging topology; browser/SPA acceptance on a normal
   browser (sandbox limitation documented above).
6. **PSP reality** — all rails remain sandbox-mock; the 12-case provider plan
   is unexecuted; no real-money claim is made anywhere.
7. Tracked dependency advisories (accepted, LOW practical severity — Phase 2.1
   §G-D) fold into the next scheduled dependency pass.

**Readiness verdict (five stages, evidence-based):** Internal testing **READY**
(180/180 unit, tsc 0, lint baseline, live route matrix, fail-closed contracts
proven). Invite-only pilot **READY after the runbook executes** in authorized
staging. Public marketplace launch **CONDITIONAL** — now additionally gated on
the email-provider decision landing and the guest-order OTP + claiming matrix
passing on staging (this closure removed the knowledge-pair and
unverified-claiming authorization gaps that previously blocked it outright).
Influencer campaign and marketplace-scale expansion **NOT READY** (unchanged
Phase 2.1 gates: campaign-grade concurrency unmeasured; single-process
rate-limiter/challenge architectures with documented swap paths, deliberately
not implemented yet).

---

### Implementation inventory (every file touched this session)

| File | Change |
|---|---|
| `prisma/schema.prisma` | NEW model `EmailOtpChallenge` (no existing-table columns) |
| `prisma/migrations/20261104000000_final_email_otp/migration.sql` | NEW (created, NOT applied) |
| `src/lib/guest-otp.ts` | NEW — OTP + grant core (issue/verify/CAS/day-bucket/grants/ownership proof/model guard) |
| `src/lib/email-provider.ts` | NEW — provider interface + fail-closed seam (no adapter) |
| `src/app/api/orders/otp/request/route.ts` | NEW — uniform 200, 4 throttle axes, pre-lookup fail-closed |
| `src/app/api/orders/otp/verify/route.ts` | NEW — uniform 401, CAS consume, grant mint |
| `src/app/api/auth/shopper/email-verification/{request,verify}/route.ts` | NEW — session-gated verification + exactly-once claiming |
| `src/app/api/orders/lookup/route.ts` | REWRITTEN authorization (grant or owning session only) |
| `src/app/api/orders/receipt/route.ts` | Same + payment gate retained |
| `src/lib/shopper-merge.ts` | Ownership gate inside `claimGuestStateForShopper` |
| `src/app/api/auth/shopper/register/route.ts` | No auto-claim; best-effort code send; `emailVerified`/`emailVerificationSent` |
| `src/app/api/auth/shopper/{login,unified-login}/route.ts` | Claiming via gate; `emailVerified` in response |
| `src/app/api/me/profile/route.ts` | `emailVerified` for the Me-hub card |
| `src/app/api/cron/session-purge/route.ts` | Sweeps expired challenges (verified rows kept; P2021-tolerant) |
| `src/components/shopper/guest-order-access.ts` | NEW — in-memory-only grant store |
| `src/components/shopper/checkout.tsx` | LookupView two-step OTP flow; OrderStatusView/OrdersView grant+session paths; verify CTA; receipt via grant/session |
| `src/components/shopper/me-hub.tsx` | EmailVerificationCard (no count disclosure) |
| `src/components/shopper/shopper-shell.tsx` | Register toast (verification sent / claiming note) |
| `src/components/auth/unified-auth-panel.tsx` | Response type `emailVerified` |
| `src/lib/me-hub-cache.ts` | `MeProfile.emailVerified` |
| `src/instrumentation-node.ts` + `.env.example` | New secrets surfaced (boot-loud / documented) |
| `src/lib/__tests__/guest-otp.test.ts` | NEW — 16 executed unit tests |
| `scripts/readiness/guest-order-otp-e2e.ts` | NEW — staging-only E2E (prepared) |
| `docs/security/guest-order-otp-design.md` | REWRITTEN — corrected model (supersedes rejected draft) |
| `docs/ops/phase21-deployment-runbook.md` | Six migrations; secrets; rollback hard rule; new verification steps |
| `docs/staging/phase21-staging-test-pack.md` | §7 guest-order OTP matrix + execution order |
| `docs/security/final-closure-report.md` | THIS report |
