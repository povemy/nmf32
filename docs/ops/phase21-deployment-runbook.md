# NOMOFEE — Phase 2.1 + FINAL CLOSURE Deployment & Migration Runbook

**Status: PREPARED — NOT EXECUTED.** Every step below requires an authorized
staging/production environment. This sandbox performed zero DB operations.

Scope: applying the SIX migrations now sitting unapplied
(`20261101000000` … `20261104000000`), deploying the Phase 1 + 2 + 2.1 +
FINAL CLOSURE code, and verifying the result — with exact rollback procedures.

---

## 0. Migration inventory (all reviewed in Phase 2.1 §D + FINAL CLOSURE §6)

| # | Migration | Nature | Risk notes |
|---|---|---|---|
| 1 | `20261101000000_phase1_session_token_hashing` | DATA-only UPDATE of `Session.token` | **Order-critical** (see §2). SQL corrected in Phase 2.1 (`convert_to`/`sha256` — core PG, no extension). Idempotence impossible by design (hash-of-hash indistinguishable) → relies on Prisma exactly-once ledger. |
| 2 | `20261101000001_phase1_review_verified_purchase` | Additive columns + unique index + FKs + default | Legacy rows unaffected (NULLs distinct in the unique index; default applies to new inserts only). |
| 3 | `20261101000002_phase1_admin_mfa_enrollment` | New table + unique + FK cascade | Empty table = no enforcement until admins enroll. |
| 4 | `20261102000000_phase2_performance_indexes` | 7 CREATE INDEX + 1 DROP INDEX | Plain CREATE INDEX takes a SHARE lock (blocks writes per-table for the build). Fine below ~1M rows; otherwise use §3b (CONCURRENTLY escape hatch). |
| 5 | `20261103000000_phase21_mfa_totp_replay` | Additive nullable column | None — safe at any time. |
| 6 | `20261104000000_final_email_otp` | New table `EmailOtpChallenge` + unique index | Empty on creation → zero enforcement impact until flows write to it. Additive; safe at any point in the sequence. **Interaction:** until it is applied AND a transactional email provider is configured, guest-order OTP/email-verification routes fail closed (503), lookup/receipt accept only OWNING sessions, and guest-order claiming is disabled — the safe direction. |

**Apply order = numeric order (1→6).** Session-token hashing FIRST is a hard rule.

---

## 1. Pre-flight (all environments)

1. Confirm the target database is the intended one: compare the Supabase
   project ref in the deployment secret store against the runbook ticket.
   (Phase 2.1 audit established the dev sandbox only ever held ONE database
   URL; production secrets live only in the deployment environment.)
2. Backup: `bun scripts/backup-db.ts` (existing script) **plus** a Supabase
   point-in-time-recovery snapshot; verify restore on a scratch project.
3. Env secrets present (all fail-closed in prod):
   `CRON_SECRET`, `PSP_WEBHOOK_SECRET`, `MFA_ENCRYPTION_KEY`,
   `IMPORT_CAP_SECRET`, and — FINAL CLOSURE — `EMAIL_OTP_SECRET` +
   `ORDER_ACCESS_SECRET` (openssl rand -hex 32 each). `MFA_ENCRYPTION_KEY`
   is a HARD prerequisite for privileged admin operation (enrollment gate).
   The two FINAL CLOSURE secrets are prerequisites for guest-order OTP:
   without them the OTP routes 503 and order lookup/receipt accept only
   OWNING sessions (guest tracking degrades to sign-in — safe, but plan it).
   The transactional EMAIL PROVIDER decision (Resend/Postmark/SES) may land
   AFTER this deploy: the code is provider-ready but fails closed until
   `EMAIL_PROVIDER` + the adapter are configured (see
   docs/security/guest-order-otp-design.md §6).
4. Freeze deploys; announce the window. A **controlled maintenance window or
   full traffic drain is REQUIRED for the session-token migration** (§2) —
   it is a one-way, order-sensitive data transformation.

---

## 2. Session-token migration — the sensitive step

**Invariant: migration 1 must run while OLD application code is still stopped
and BEFORE new code starts.** Both wrong orders have the same benign outcome
(all sessions invalidate once → everyone re-logs-in) but the correct order has
ZERO disruption:

- Old code stopped + migration runs + new code starts → existing cookies keep
  working (raw cookie → sha256 → matches the transformed row).
- New code running while the migration runs (or before it) → sessions minted
  by the new code store sha256 already; the migration then double-hashes those
  rows → those users re-login. Not dangerous, but avoid it: **traffic-drain
  first.**

The chat-service hub-auth and the expiry-scheduler hold **no DB sessions**, but
both must be restarted as part of the deploy so their code is also the
hashed-token build (the hub validates tokens against the SAME hashed store).

**Rollback for step 2 alone:** if the migration fails mid-way (it is a single
UPDATE — Postgres makes it atomic), the transaction aborts and NO rows change:
just fix and re-run `prisma migrate deploy`. If it succeeded and you must
roll BACK the app, old code cannot read hashed tokens → users re-login;
there is no reverse migration (hashing is one-way) and none is needed.

---

## 3. Ordered execution

```bash
# 0. Drain: stop public traffic at Caddy (or return 503 page), stop the
#    expiry-scheduler, stop the chat-service, stop the Next app.
systemctl stop nomofee-scheduler nomofee-chat nomofee-web   # (adjust to real units)

# 1. Apply migrations 1-6 in order (Prisma refuses to skip).
bunx prisma migrate deploy

# 2. Verify schema state (read-only):
bunx prisma migrate status        # expects: "6 migrations found … all applied"
# Spot-checks (psql, read-only):
#   SELECT count(*) FROM "Session" WHERE length("token") <> 64;       → 0
#   SELECT count(*) FROM "AdminMfaEnrollment";                        → 0 (pre-enrollment)
#   SELECT indexname FROM pg_indexes WHERE tablename = 'PaymentGroup';→ …_status_expiresAt_idx present
#   SELECT column_name FROM information_schema.columns
#     WHERE table_name='AdminMfaEnrollment' AND column_name='lastUsedTotpCounter'; → present
#   SELECT count(*) FROM "EmailOtpChallenge";                         → 0 (pre-provider)

# 3. Deploy new code (Next standalone build + chat-service + scheduler).
#    ENV check: MFA_ENCRYPTION_KEY / IMPORT_CAP_SECRET / CRON_SECRET /
#    PSP_WEBHOOK_SECRET / EMAIL_OTP_SECRET / ORDER_ACCESS_SECRET set.
#    (EMAIL_PROVIDER + provider keys optional at this point — fail-closed.)

# 4. Restart order: web first, then chat-service, then scheduler.

# 5. Verification sequence (§4 below), then re-open traffic at Caddy.
```

### 3b. CONCURRENTLY escape hatch (ONLY if Order/InventoryLog > ~1M rows)

Prisma wraps each migration in a transaction and `CREATE INDEX CONCURRENTLY`
cannot run inside one — so migration 4 must be applied OUT-OF-BAND in that
case, using the OFFICIAL Prisma escape hatch (not a hand-crafted
`_prisma_migrations` INSERT):

```bash
# a) Run the statements out-of-band, one session each (psql):
#    CREATE INDEX CONCURRENTLY IF NOT EXISTS "PaymentGroup_status_expiresAt_idx" ON "PaymentGroup"("status","expiresAt");
#    CREATE INDEX CONCURRENTLY IF NOT EXISTS "Order_storeId_status_idx"          ON "Order"("storeId","status");
#    CREATE INDEX CONCURRENTLY IF NOT EXISTS "Order_status_deliveredAt_idx"      ON "Order"("status","deliveredAt");
#    CREATE INDEX CONCURRENTLY IF NOT EXISTS "PaymentWebhookLog_processed_createdAt_idx" ON "PaymentWebhookLog"("processed","createdAt");
#    DROP INDEX CONCURRENTLY IF EXISTS "PaymentWebhookLog_processed_idx";
#    CREATE INDEX CONCURRENTLY IF NOT EXISTS "InventoryLog_variantId_idx"        ON "InventoryLog"("variantId");
#    CREATE INDEX CONCURRENTLY IF NOT EXISTS "WebhookDelivery_status_createdAt_idx" ON "WebhookDelivery"("status","createdAt");
#    CREATE INDEX CONCURRENTLY IF NOT EXISTS "WebhookDelivery_endpointId_idx"    ON "WebhookDelivery"("endpointId");
#    NOTE the DROP INDEX also becomes CONCURRENTLY (plain DROP INDEX takes an
#    ACCESS EXCLUSIVE lock on the table — the very thing we are avoiding).
#
# b) Verify all seven exist with correct definitions (pg_indexes).
#
# c) Mark the migration applied WITHOUT executing it (official command —
#    records the ledger row with the correct checksum):
bunx prisma migrate resolve --applied 20261102000000_phase2_performance_indexes
#
# d) prisma migrate status must now report all migrations applied.
# e) The migration FILE stays in the repo untouched — future environments run
#    the in-transaction version automatically.
```

**Never** mark a migration applied without either executing its statements or
verifying the equivalent objects exist (the `resolve --applied` command trusts
the operator). The verification query in (b) is the evidence.

---

## 4. Post-deploy verification sequence

1. `GET /api/health?fresh=1` — `db: up`, ledger invariants OK, gate stats sane.
2. All six cron routes return 200 on the next scheduler tick
   (`GET :3005` state: `expiry`, `refund`, `analytics`, `sessions`,
   `orders`, `affiliate` — all `consecutiveFailures: 0`). The sessions tick
   now also sweeps expired OTP challenge rows (`otpChallengesPurged` field).
3. **Auth smoke:** one existing session cookie from BEFORE the window still
   authenticates (`GET /api/auth/me` 200) — proves migration-order correctness.
   One fresh login round-trip. One logout.
4. **MFA bootstrap:** sign in as superadmin → admin shell shows the
   amber "Two-factor authentication is required for your role" banner →
   Settings → Security → enroll (password) → confirm (TOTP) → recovery codes
   shown once → all sessions revoked → sign-in now demands the TOTP code →
   full access restored. Repeat for finance + ops admins (rollout list in
   Phase 1 §F).
5. **TOTP replay check:** submit the SAME authenticator code twice in quick
   succession → second attempt answers 401 `MFA_INVALID` (replay guard).
6. **Guest-order authorization model (FINAL CLOSURE):**
   a. `GET /api/orders/lookup?email=&orderNumber=` WITHOUT a grant/session
      → 401 `ORDER_VERIFICATION_REQUIRED` for an existing order AND for a
      non-existent one (bodies byte-identical).
   b. `POST /api/orders/otp/request` → 503 `EMAIL_PROVIDER_NOT_CONFIGURED`
      until the provider decision lands (EXPECTED if not yet configured —
      uniform for every pair, so no oracle).
   c. With the provider configured (staging): request → code from the
      mailbox → verify → grant → lookup/receipt WITH the grant → 200;
      receipt on an unpaid order → 409 `NOT_PAID` (payment gate retained);
      the same code again → 401 (replay); grant after 15 min → 401.
      Full matrix: `scripts/readiness/guest-order-otp-e2e.ts`.
7. **Email verification + claiming (staging):** register with an email that
   has unclaimed guest orders → login shows `emailVerified: false`, nothing
   claimed; verify the code → orders claimed exactly once (script §9).
8. **Reviews smoke:** PDP renders; a delivered-order shopper can submit a
   review (pending); admin moderation approve → aggregate updates.
9. **Financial + inventory smoke:** one checkout E2E through the PSP mock →
   `/api/health` invariants still OK → `bun run verify:finance` on staging
   (its residue policy is documented and balanced) → order-maintenance +
   expiry sweeps tick clean.
10. **Cache invalidation smoke:** PATCH a product price as seller → the NEXT
    public PDP request serves the new price (immediate tag bust).
11. Re-open traffic. Watch `dev.log`/access logs for 15 minutes:
    `MFA_ENROLLMENT_REQUIRED` 403s are EXPECTED until privileged admins enroll;
    `ORDER_VERIFICATION_REQUIRED` 401s are EXPECTED for knowledge-pair lookups.

---

## 5. Rollback (full)

**HARD RULE — session tokens are hashed ONE-WAY: NEVER redeploy an
application build that still reads/plaintext-matches `Session.token` against
a database where migration 1 has run.** The pre-Phase-1 build looks up raw
tokens, finds only sha256 digests, and every session simply fails (users
re-login) — worse, its login writes would then store RAW tokens alongside
hashed rows, re-creating the at-rest exposure the migration closed. The ONLY
correct way to undo migration 1 is the backup restore in step 2, which must
therefore PRECEDE any old-code redeploy.

1. Caddy traffic-drain (503), stop scheduler + chat-service + web.
2. Restore the backup taken in §1 (PITR snapshot point) — this is the only
   way to undo migration 1 (one-way hash) and is acceptable because the
   window is closed and sessions re-issue on next login. Restoring first is
   what makes step 3 safe.
3. ONLY NOW redeploy the previous code build; restart services in the §3
   order. (The previous build may be Phase 2.1-level or later — any build
   that hash-matches tokens. If you must go further back than Phase 1, you
   MUST restore the database to the matching pre-hash snapshot first — same
   rule, stated twice on purpose.)
4. Post-rollback verification: health, cron ticks, one login, one checkout
   E2E on the mock rails.
5. If ONLY the Phase 2.1 / FINAL CLOSURE code needs rolling back (not the
   migrations — every such change is code-only; migrations 5 and 6 are
   additive and ignored by old code): redeploy the previous build. NOTE for
   FINAL CLOSURE: rolling its code back re-opens the knowledge-pair lookup
   and unverified claiming — treat that as a security regression and only
   do it inside an incident response, with the guest-lookup surfaces watched.
6. Migration 6 rollback (rare): the `EmailOtpChallenge` table can simply be
   dropped — it holds no irreplaceable data EXCEPT verified shopper-email
   rows (claiming proofs). Dropping it re-disables claiming (fail-closed),
   which is safe but forces re-verification for those users.

## 6. Scheduler restart note

The scheduler must restart to pick up… no new jobs in 2.1 (six jobs unchanged
from Phase 2) — but the restart in §3 keeps its code version aligned with the
web app (it POSTs cron routes on the new build).
