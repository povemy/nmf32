# Phase 3 / Step 3 — Staging Migration Report

**Mission:** Apply all 15 Prisma migrations to the isolated `nomofee_staging` schema in the authorized Supabase staging project, under the six safeguards specified in the approval message.
**Status:** ✅ **COMPLETE — all 15 migrations applied successfully; all 6 safeguards satisfied; 44/44 post-verification checks GREEN; `public` schema proven untouched.**
**Executed:** 2026-11-02, 12:08:10–12:08:18 UTC (deploy window; pre-flight from 11:59 UTC).
**Authorization:** User approval received in this session ("Approved — execute staging migrations, subject to the following safeguards…"). Financial race suites (Step 4) were **NOT** run — awaiting separate authorization.

---

## 1. Safeguard results (as required by the approval)

| # | Safeguard required | Result | Evidence |
|---|---|---|---|
| 1 | Confirm the Supabase project is non-production and the target DB is not shared with production | ✅ **Confirmed** (see §2 for the honest scope of this confirmation) | preflight JSON §`nonProductionEvidence` |
| 2 | Reconfirm the exact database identity and `nomofee_staging` as the active migration schema immediately before execution | ✅ **Reconfirmed 3 ways, seconds before deploy** (see §3) | `migrate status` output, §3.4 |
| 3 | Verify no migration will modify `public` or cause unintended database-wide changes | ✅ **Verified** — static scan of all 15 files + live probe + post-run proof (§4, §7) | §4, §7 |
| 4 | Apply all 15 migrations exactly as planned | ✅ **Applied in filename order, 15/15, zero failures** | §5 |
| 5 | Verify all migrations, critical indexes and required structures afterward | ✅ **44/44 checks GREEN** incl. ledger checksums, every critical index/structure (§6) | postverify JSON |
| 6 | Stop immediately if the connection target differs, unexpected changes detected, or any migration fails; no improvised repair | ✅ **Never triggered.** The fail-closed pre-flight refused twice during development of the guard itself (before anything executed); the deploy itself needed no repair | §2, §5 |

**No migration failed. No improvised repair was performed at any point. Nothing was rolled back.**

---

## 2. Safeguard 1 — non-production project confirmation

What was positively established (all read-only, live):

1. **The only app answering for this database reports `NODE_ENV=development`** and `/api/health` `status=healthy`, `db=up` (`deployment.nodeEnv: "development"`, `dbFingerprint: aa338c2b6272e14c`).
2. **The migration connection resolves the same fingerprint** `aa338c2b6272e14c` (formula: sha256(`poolerHost|dbOID|maxConnections`)[0:16], identical to `/api/health` and `target-guard.ts`) — app and migration connection provably target the SAME database.
3. **The project contains only Supabase platform objects:**
   - Databases (allowconn): `postgres`, `template1` — nothing else exists.
   - Schemas: `public`, `information_schema`, `extensions`, `auth`, `storage`, `realtime`, `supabase_functions`, `graphql_public`, `vault`, `graphql`, `pgbouncer` + `nomofee_staging` (our prepared target) — all platform-owned except `public` (the sandbox dev dataset) and `nomofee_staging`.
   - Login roles: `authenticator`, `pgbouncer`, `postgres`, `supabase_admin`, `supabase_auth_admin`, `supabase_etl_admin`, `supabase_read_only_user`, `supabase_replication_admin`, `supabase_storage_admin` — the stock Supabase set, no app-specific roles.
4. **The data is the sandbox's own dev dataset:** 1,175 users with email domains `lt.test` (992), `lt.nomofee.test` (120), `verify.nomofee.io` (40), `probe.local` (13), `nomofee.test` (5)… — test traffic from this sandbox's E2E/probe history; 49 stores / 5,162 products / 1,207 orders / 450 ledger transactions, DB size 40 MB.
5. **NOMOFEE has no production deployment anywhere:** no production credentials, hosts or domains exist in this sandbox (single Supabase credential set in the env vault); CI has never produced a production artifact; the handoff report's category 4 ("Production verified") remains empty.

**Honest limitation (unchanged from prior assessments):** this sandbox has exactly ONE Supabase project, and it also holds the sandbox's own dev dataset in `public`. It is non-production (nothing production exists), but it is not a *separate* project. The approved mitigation — and the reason this run is safe — is **schema-level isolation**: staging occupies `nomofee_staging`, a distinct PostgreSQL schema, and the migration run was proven (probe + before/after hashes) incapable of touching `public`. The dev app continues to use `public`; staging tests will use `nomofee_staging`; neither can see the other.

---

## 3. Safeguard 2 — identity + schema reconfirmed immediately before execution

Sequence in the minutes before the deploy (all captured in evidence files):

1. **Pre-flight (11:59–12:05 UTC):** fingerprint match `aa338c2b6272e14c` (app ↔ migration connection), `current_database()=postgres (oid 5)`, `current_user=postgres`, server `2406:da18:…:b7e9/128 :5432` via pooler `aws-0-ap-southeast-1.pooler.supabase.com:5432`.
2. **Staging target:** `nomofee_staging` existed as an **empty shell (0 objects, owned by `postgres`)** — the schema prepared in Step 2. No other state.
3. **`prisma migrate status` output, immediately before `deploy` (same URL variable, same shell):**

   ```
   Datasource "db": PostgreSQL database "postgres", schema "nomofee_staging"
                    at "aws-0-ap-southeast-1.pooler.supabase.com:5432"
   15 migrations found in prisma/migrations
   Following migrations have not yet been applied:
   0_init … 20261109000000_phase24_search_indexes   (all 15 listed)
   ```

4. The deploy command used the **identical URL string** (built once into a shell variable, `…/postgres?sslmode=require&connection_limit=10&connect_timeout=10&schema=nomofee_staging`) — zero possibility of target divergence between the reconfirmation and the execution.

---

## 4. Safeguard 3 — no modification of `public` / no unintended database-wide changes

### 4.1 Static review of all 15 migration files

Full-file scan of every `migration.sql` for database-wide or `public`-qualified statements (`public.`, `CREATE EXTENSION`, `DROP SCHEMA`, `ALTER SYSTEM`, `CREATE/DROP ROLE`, `GRANT/REVOKE`, `pg_catalog`, `auth.`, `storage.`, `realtime.`, `CONCURRENTLY`, `UNLOGGED`, `CREATE/DROP/ALTER DATABASE`):

- **14 of 15 files: zero flagged statements.** All DDL is unqualified (`CREATE TABLE "Plan"`, `CREATE INDEX … ON "Order"` …), i.e. resolved through the session `search_path`.
- **0_init line 1–2:** `CREATE SCHEMA IF NOT EXISTS "public"` — **a verified no-op** (schema exists; `IF NOT EXISTS`; the live run raised nothing). It cannot modify `public`'s contents.
- **20261109000000 (search indexes):** `CREATE EXTENSION IF NOT EXISTS pg_trgm;` — the ONE statement with database-level effect (a catalog row in `pg_extension`). Pre-flight established **pg_trgm was NOT installed** on this project, so this run genuinely installed it. **It was probe-verified and post-verified to be installed INTO `nomofee_staging`** (isolated: drops with the schema; `public` untouched). See §4.2/§7.
- **20261101000000 (session-token hashing):** data-only `UPDATE "Session" SET token = sha256(...)` — unqualified, hence scoped by `search_path` to `nomofee_staging."Session"` (created empty by `0_init` in the same run: **0 rows affected**). The runbook's stop-old-code invariant applies to live upgrades with existing sessions; on a fresh schema there are no sessions and no writers.

### 4.2 Live mechanics probe (throwaway schema, before the real run)

Because unqualified DDL follows the connection's `search_path`, the actual Prisma behavior was verified empirically on a disposable schema `nomofee_probe` (2 mini-migrations replicating exactly the risky mechanics: the `public` no-op, unqualified CREATE TABLE/INDEX, search_path capture, `CREATE EXTENSION IF NOT EXISTS pg_trgm`, `gin_trgm_ops` index, unqualified `DROP INDEX`). Results:

| Mechanic question | Probe answer |
|---|---|
| What `search_path` does `prisma migrate deploy` use? | **Exactly the `schema=` URL parameter** (`nomofee_probe`), captured inside a migration row |
| Where do unqualified tables/indexes land? | Target schema only (verified via `pg_class`/`pg_indexes`) |
| Where is `_prisma_migrations` created? | Target schema only |
| Does `CREATE EXTENSION IF NOT EXISTS pg_trgm` work, and where does it land? | Works — **installs into the target schema** (first schema in search_path) |
| Does `gin_trgm_ops` resolve under that search_path? | **Yes** (extension in the same schema) |
| Is an unqualified `DROP INDEX` scoped to the target schema? | **Yes** (dropped the target's own index; `public` never consulted) |
| Does Prisma auto-create a missing target schema? | Yes (probe schema was not pre-created) |
| Was `public` touched by the probe? | No — 97 tables / 240 indexes before and after; zero probe objects in `public` |

The probe schema was then **fully torn down** (`DROP SCHEMA nomofee_probe CASCADE` — pg_trgm was removed with it) and the database was confirmed restored to its exact pre-probe state before the authorized run. Probe files retained at `prisma/probe/` (self-documenting, reusable for future environments).

**Why this mattered:** without the probe, a wrong search_path assumption could have silently created the 4 trigram indexes in `public` (new names — no collision failure) or dropped `public.PaymentWebhookLog_processed_idx`. The probe proved none of those paths were live before the authorized run started.

---

## 5. Execution record

```
$ SUPABASE_DATABASE_URL="…postgres?sslmode=require&…&schema=nomofee_staging" \
      bunx prisma migrate deploy --schema prisma/schema.prisma

Datasource "db": PostgreSQL database "postgres", schema "nomofee_staging"
                 at "aws-0-ap-southeast-1.pooler.supabase.com:5432"
15 migrations found in prisma/migrations

Applying migration `0_init`                                             12:08:10→13.852Z
Applying migration `20261030000000_affiliate_system_baseline`           …14.269Z
Applying migration `20261031000000_orderitem_affiliate_sponsor_policy_snapshot`  …14.555Z
Applying migration `20261031000001_affiliate_collection_profile_fk`     …14.839Z
Applying migration `20261101000000_phase1_session_token_hashing`        …15.120Z
Applying migration `20261101000001_phase1_review_verified_purchase`     …15.407Z
Applying migration `20261101000002_phase1_admin_mfa_enrollment`         …15.698Z
Applying migration `20261102000000_phase2_performance_indexes`          …15.989Z
Applying migration `20261103000000_phase21_mfa_totp_replay`             …16.272Z
Applying migration `20261104000000_final_email_otp`                     …16.556Z
Applying migration `20261105000000_phase22_marketplace_integrity`       …16.845Z
Applying migration `20261106000000_phase23_email_delivery`              …17.132Z
Applying migration `20261107000000_phase23_seller_verification`         …17.415Z
Applying migration `20261108000000_phase23_webhook_delivery`            …17.709Z
Applying migration `20261109000000_phase24_search_indexes`              …18.306Z

All migrations have been successfully applied.                          (finished 12:08:18Z)
```

- Verbatim log: `docs/staging/evidence/phase3-step3-deploy-output.txt`
- Order = filename order, exactly as planned; each migration recorded as **1 applied step** (no partial steps).
- The dev server (writes only to `public`) remained running throughout; see §7 for proof of non-interference.

---

## 6. Post-verification — 44/44 checks GREEN

Full evidence: `docs/staging/evidence/phase3-step3-postverify.json`. Highlights:

### 6.1 Migration ledger (`nomofee_staging._prisma_migrations`)
- **15 rows, all `finished_at` set, zero failures/rollbacks.**
- **15/15 checksums equal `sha256(migration.sql)` of the local files** — what ran is byte-identical to the repo's migration history.
- `prisma migrate status` (staging URL): **"Database schema is up to date!"**

### 6.2 Structural completeness
- **96 app tables in `nomofee_staging` = exactly `public`'s app-table set** (public = 96 app tables + its own `_prisma_migrations`; both derive from the same datamodel).
- 245 indexes in staging (240 datamodel indexes + 4 trigram + `_prisma_migrations` pkey).

### 6.3 Critical indexes & structures (per the approval's verification requirement)

| Structure | Verified definition (staging) |
|---|---|
| **Affiliate single-open-payout guard** | `CREATE UNIQUE INDEX "AffiliatePayout_one_open_per_affiliate" ON nomofee_staging."AffiliatePayout" USING btree ("affiliateId") WHERE (status = ANY (ARRAY['requested'::text, 'processing'::text]))` — unique, partial, exactly the intended open-status predicate |
| Review verified-purchase | `Review_productId_shopperId_key` UNIQUE (`productId`,`shopperId`); `Review.status` default `'pending'`; `orderId`/`shopperId` FKs |
| MFA | `AdminMfaEnrollment` table + `adminId` UNIQUE + FK; `lastUsedTotpCounter` integer column |
| Email OTP | `EmailOtpChallenge` + `EmailOtpChallenge_purpose_subjectId_key` UNIQUE |
| Email delivery | `EmailDeliveryEvent` + `provider_providerEventId` UNIQUE + `email_idx` + `eventType_receivedAt_idx`; `EmailSuppression` + `email` UNIQUE + `reason_idx` |
| Seller verification | `Seller.emailVerifiedAt timestamp(3)` nullable |
| Webhook delivery | `WebhookDeliveryAttempt` + `deliveryId_attemptNo_idx`; `WebhookDelivery_status_createdAt_idx`; `WebhookDelivery_endpointId_idx` |
| Performance indexes | `PaymentGroup_status_expiresAt_idx`, `Order_storeId_status_idx`, `Order_status_deliveredAt_idx`, `PaymentWebhookLog_processed_createdAt_idx`, `InventoryLog_variantId_idx` — and the replaced `PaymentWebhookLog_processed_idx` **absent** as intended |
| Search indexes | `Product_title_trgm_idx`, `Product_description_trgm_idx`, `Store_name_trgm_idx`, `Category_name_trgm_idx` — GIN `gin_trgm_ops`, in `nomofee_staging` |
| Session token shape | `Session.token` text NOT NULL (PK shape preserved; hashing is an application-level convention) |

### 6.4 Fresh-data invariant
- **All 96 staging tables have 0 rows** — the one-way session-token `UPDATE` touched zero rows; no financial or user data exists in staging (clean slate for Step 4).

### 6.5 Drift check (migrations ↔ datamodel)
`prisma migrate diff --from-url <staging> --to-schema-datamodel prisma/schema.prisma` → the **only** difference is the 4 trigram GIN indexes (DROP statements to reach the datamodel state). This is the known, documented Prisma limitation — hand-authored `gin_trgm_ops` indexes cannot be expressed in the Prisma datamodel, so they rightly exist only in migration SQL. **Every table, column, constraint and datamodel-expressible index matches the datamodel exactly.** (This also means staging = `public`'s db-push structure + the 4 trigram indexes, i.e. staging is the *more* correct schema.)

---

## 7. `public` proven untouched (the core safety proof)

Baseline captured at 12:05 UTC, re-captured after the deploy, compared byte-exactly:

| Component | Before | After | Result |
|---|---|---|---|
| Structural hash (tables + row counts + **all 240 index definitions** + all 176 constraint definitions + views + functions + triggers) | `24ac8aa602328b63…` | `24ac8aa602328b63…` | **IDENTICAL** |
| Row counts (all 97 public tables) | — | — | **zero deltas** |
| `public."Session"` rows | 404 rows, sha256 `082b2b0d84c6d37a…` | same | **IDENTICAL** (restore-point backup retained: `db/backup/phase3-step3-session-backup.json`) |
| `public._prisma_migrations` | 4 rows (dev history) | 4 rows | deploy wrote nothing to public's ledger |
| Migration-object leakage into `public` | — | — | none (no trgm/feature index names present; 240/240 defs byte-identical) |
| Extensions catalog | 5 platform extensions | + `pg_trgm` **in `nomofee_staging` only** | the single, intended, isolated catalog addition |

The running dev app was healthy before and after (`status=healthy, db=up, ledgerInvariants.ok=true`).

**Honest note on the one database-level change:** installing `pg_trgm` creates one row in `pg_extension` (a database-scoped catalog object). It was mandated by approved migration 15's own SQL, is fully contained in `nomofee_staging` (members + opclass live there; `DROP SCHEMA nomofee_staging CASCADE` removes it entirely), and no other database-wide change of any kind occurred.

---

## 8. Rollback / restore definition (for the record)

- **Staging rollback:** `DROP SCHEMA nomofee_staging CASCADE;` — removes every object this run created (tables, indexes, `_prisma_migrations`, `pg_trgm`) and returns the project to its pre-run state. No other restore is required because `public` was never touched.
- **`public` restore point (defensive only):** full structural repair manifest in the pre-flight evidence (every index/constraint definition) + `Session` row dump in `db/backup/`. Not needed — nothing changed.

---

## 9. What this enables / what is still NOT done

**Ready now:**
- `nomofee_staging` is a complete, empty, structurally-verified NOMOFEE schema (all 15 migrations, all critical guards in place) in the authorized non-production Supabase project.
- Step 4 (financial & concurrency validation) can run against it by pointing Prisma at `SUPABASE_DATABASE_URL=…&schema=nomofee_staging` (the exact URL form used here, recorded in §3.4).

**Explicitly NOT done (awaiting authorization/decisions):**
- **Step 4 financial race suites — NOT run** (`scripts/readiness/phase22-races.ts`, finance-regression, guest-order E2E untouched), per the approval's instruction to report migrations first.
- No real email provider configured; no PSP selected/integrated (unchanged owner decisions).
- No commits or pushes performed (working tree carries this session's artifacts only).
- Production deployment: not attempted, unchanged.

**Carried-forward note for Step 4:** the race suites write financial fixtures into whatever schema Prisma targets — when authorized, they must be run with the staging URL override (and a fresh re-verify that the target is `nomofee_staging`), never against the dev `public` dataset.

---

## Appendix — artifacts produced this step

| Artifact | Purpose |
|---|---|
| `scripts/readiness/phase3-staging-preflight.ts` | Fail-closed read-only safeguard probe (identity, non-production allowlists, baseline capture, Session backup) |
| `scripts/readiness/phase3-staging-postverify.ts` | 44-check read-only post-verification (ledger, structures, isolation, drift) |
| `prisma/probe/` | Disposable-schema mechanics probe (search_path / extension / DROP scoping proof), reusable for future environments |
| `docs/staging/evidence/phase3-step3-preflight.json` | Pre-run evidence + `public` baseline + repair manifest |
| `docs/staging/evidence/phase3-step3-postverify.json` | Post-run evidence, all 44 check results, migration ledger |
| `docs/staging/evidence/phase3-step3-deploy-output.txt` | Verbatim deploy log |
| `db/backup/phase3-step3-session-backup.json` | `public."Session"` restore point (404 rows) |
