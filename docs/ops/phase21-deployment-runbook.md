# NOMOFEE — Phase 2.1 Deployment & Migration Runbook

**Status: PREPARED — NOT EXECUTED.** Every step below requires an authorized
staging/production environment. This sandbox performed zero DB operations.

Scope: applying the five migrations now sitting unapplied
(`20261101000000` … `20261103000000`), deploying the Phase 1 + 2 + 2.1 code,
and verifying the result — with exact rollback procedures.

---

## 0. Migration inventory (all reviewed in Phase 2.1 §D)

| # | Migration | Nature | Risk notes |
|---|---|---|---|
| 1 | `20261101000000_phase1_session_token_hashing` | DATA-only UPDATE of `Session.token` | **Order-critical** (see §2). SQL corrected in Phase 2.1 (`convert_to`/`sha256` — core PG, no extension). Idempotence impossible by design (hash-of-hash indistinguishable) → relies on Prisma exactly-once ledger. |
| 2 | `20261101000001_phase1_review_verified_purchase` | Additive columns + unique index + FKs + default | Legacy rows unaffected (NULLs distinct in the unique index; default applies to new inserts only). |
| 3 | `20261101000002_phase1_admin_mfa_enrollment` | New table + unique + FK cascade | Empty table = no enforcement until admins enroll. |
| 4 | `20261102000000_phase2_performance_indexes` | 7 CREATE INDEX + 1 DROP INDEX | Plain CREATE INDEX takes a SHARE lock (blocks writes per-table for the build). Fine below ~1M rows; otherwise use §3 (CONCURRENTLY escape hatch). |
| 5 | `20261103000000_phase21_mfa_totp_replay` | Additive nullable column | None — safe at any time. |

**Apply order = numeric order (1→5).** Session-token hashing FIRST is a hard rule.

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
   `IMPORT_CAP_SECRET`. `MFA_ENCRYPTION_KEY` is now a HARD prerequisite for
   privileged admin operation (see §5 — the enrollment gate depends on it).
4. Freeze deploys; announce the window.

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

# 1. Apply migrations 1-5 in order (Prisma refuses to skip).
bunx prisma migrate deploy

# 2. Verify schema state (read-only):
bunx prisma migrate status        # expects: "5 migrations found … all applied"
# Spot-checks (psql, read-only):
#   SELECT count(*) FROM "Session" WHERE length("token") <> 64;       → 0
#   SELECT count(*) FROM "AdminMfaEnrollment";                        → 0 (pre-enrollment)
#   SELECT indexname FROM pg_indexes WHERE tablename = 'PaymentGroup';→ …_status_expiresAt_idx present
#   SELECT column_name FROM information_schema.columns
#     WHERE table_name='AdminMfaEnrollment' AND column_name='lastUsedTotpCounter'; → present

# 3. Deploy new code (Next standalone build + chat-service + scheduler).
#    ENV check: MFA_ENCRYPTION_KEY / IMPORT_CAP_SECRET / CRON_SECRET / PSP_WEBHOOK_SECRET set.

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
   `orders`, `affiliate` — all `consecutiveFailures: 0`).
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
6. **Reviews smoke:** PDP renders; a delivered-order shopper can submit a
   review (pending); admin moderation approve → aggregate updates.
7. **Financial + inventory smoke:** one checkout E2E through the PSP mock →
   `/api/health` invariants still OK → `bun run verify:finance` on staging
   (its residue policy is documented and balanced) → order-maintenance +
   expiry sweeps tick clean.
8. **Cache invalidation smoke:** PATCH a product price as seller → the NEXT
   public PDP request serves the new price (immediate tag bust).
9. Re-open traffic. Watch `dev.log`/access logs for 15 minutes:
   `MFA_ENROLLMENT_REQUIRED` 403s are EXPECTED until privileged admins enroll.

---

## 5. Rollback (full)

1. Caddy traffic-drain (503), stop scheduler + chat-service + web.
2. Restore the backup taken in §1 (PITR snapshot point) — this is the only
   way to undo migration 1 (one-way hash) and is acceptable because the
   window is closed and sessions re-issue on next login.
3. Redeploy the previous code build; restart services in the §3 order.
4. Post-rollback verification: health, cron ticks, one login, one checkout
   E2E on the mock rails.
5. If ONLY the Phase 2.1 code needs rolling back (not the migrations —
   every Phase 2.1 change except migration 5 is code-only): redeploy the
   previous build; migration 5's column is additive and ignored by old code.

## 6. Scheduler restart note

The scheduler must restart to pick up… no new jobs in 2.1 (six jobs unchanged
from Phase 2) — but the restart in §3 keeps its code version aligned with the
web app (it POSTs cron routes on the new build).
