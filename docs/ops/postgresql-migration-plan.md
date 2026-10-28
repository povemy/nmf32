# PostgreSQL Migration Plan — NOMOFEE (SQLite → PostgreSQL)

> Ops doc P1 round. Companion doc: [`docs/ops/production-readiness.md`](./production-readiness.md)
> (environment inventory, backups, monitoring, go-live checklist).
> Answers blueprint open question **W5** (`docs/blueprint/10-unwired-techdebt-openquestions.md`:
> "Concurrency behaviour under multi-vendor load / Postgres migration assessment").

Status: **plan only — nothing migrated yet.** No `prisma/schema.prisma` change has been made as
part of this document (schema changes are deliberately out of scope for the ops round).

---

## 1. Motivation

| Driver | Today (SQLite, `db/custom.db`) | Post-PG |
|---|---|---|
| **Write concurrency** | SQLite allows a single writer at a time (database-level lock). Every webhook `$transaction`, checkout create, payout batch and refund serializes on one writer. Under multi-vendor load this becomes the global bottleneck and raises `SQLITE_BUSY`-class failures. | Row-level locking + MVCC. Concurrent orders for different sellers, parallel webhook processing and admin reads no longer queue behind one writer. |
| **Production traffic** | Fine for the sandbox/preview deployment (single Caddy + single Next.js server, see `docs/blueprint/09-testing-config-admin.md` §P.1). Not sized for real marketplace traffic. | Standard production RDBMS; horizontal read scaling, connection pooling (pgBouncer), managed backups/PITR. |
| **Multi-instance app** | The in-memory rate limiter (`src/lib/rate-limit.ts`) and the single SQLite file both assume one app instance. | A shared PG instance is the prerequisite for running >1 app instance (rate limiter swap to Redis remains separate — see runbook §d). |
| **Native JSON** | All JSON lives in `String` columns parsed by `src/lib/json.ts` helpers (21 files also raw-`JSON.parse`). | `jsonb` columns (optional phase — see §3.3) with indexable queries. |
| **Tooling / ops** | No `VACUUM`/analysis story, manual backup script only. | Managed snapshots, logical replication, mature monitoring. |

## 2. Provider swap

`prisma/schema.prisma` today:

```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

The swap is minimal and the URL is **already env-driven** (no hardcoded path anywhere in `src/`;
`src/lib/db.ts` is a plain `PrismaClient`):

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

- `DATABASE_URL` becomes a standard PG URL (`postgresql://user:pass@host:5432/nomofee?schema=public&connection_limit=N`).
- Regenerate client (`bun run db:generate`). Runtime code needs **no changes** — all queries go
  through Prisma. Native SQLite-specific SQL is **not used anywhere** (verified: no `$queryRaw`
  usage in `src/`).
- Prisma field defaults (`cuid()`, `autoincrement()`, `now()`, `@updatedAt`) map to PG equivalents
  automatically.
- `.zscripts/start.sh` (harness production layout) sets `DATABASE_URL=file:/app/db/custom.db` —
  that harness variable changes to the PG URL; everything else in the start script is DB-agnostic.

## 3. Type mapping for OUR schema

### 3.1 Money — Int sen (decision point)

All money is stored as **Int minor units (sen)** and all rates as **Int basis points**
(`BPS_DENOM = 10_000`, single source `src/lib/money.ts:53`).

| Prisma | SQLite | PostgreSQL (Prisma mapping) | Decision |
|---|---|---|---|
| `Int` money/rate columns (`totalMinor`, `amountMinor`, `commissionMinor`, `sellerNetMinor`, `*Bps`, `holdDays`, …) | `INTEGER` (SQLite is 64-bit under the hood) | `INTEGER` (Int32) | **Keep Int sen.** Recommended: no column type change. |

- **Ceiling:** Int32 max = `2,147,483,647` sen = **RM21,474,836.47** per column value. This
  ceiling is *inherent to the Prisma `Int` type*, so it already exists on SQLite — migrating does
  not change it. It applies per value (a single order line, payout amount, wallet balance), not to
  platform GMV aggregates (those live in sums/BigInt at computation time — the money core already
  promotes to BigInt internally beyond `Number.MAX_SAFE_INTEGER`).
- **Guard:** an `assertInt32Safe` write-boundary guard is a **known open item (FIN-09, not yet
  implemented)** — do that as part of (or before) the migration so an over-ceiling write fails
  loudly at the service boundary instead of deep in the driver. On PostgreSQL a value above Int32
  for an `INTEGER` column errors at the DB anyway (Prisma raises `P2020` "value out of range"),
  which is strictly better than SQLite silently storing a 64-bit value.
- **Escalation path (only if the business ever needs it):** ledger/wallet amount columns →
  `BigInt` (Prisma `BigInt` → PG `bigint`). That is a **code-wide** change (`number` → `bigint`
  flows through `src/lib/money.ts`, ledger journal recipes, statement builders) — treat as a
  separate project, not part of this migration. Recommendation: do NOT bundle it.

### 3.2 Scalar types

| Prisma type | Our usage | PostgreSQL | Caveats |
|---|---|---|---|
| `String` | ids (cuid), enums-as-strings, codes, emails, names | `text` | None. Keep app-level enum validation (schema comments document it). Add `varchar(n)` only if DB-level length constraints are later desired — not required. |
| `Boolean` | flags (`signatureValid`, `isActive`, …) | `boolean` | None. |
| `DateTime` | `createdAt`, `paidAt`, `holdUntil`, `expiresAt`, `validFrom/To`, … | `timestamp(3)` (Prisma default, no timezone) | **Keep UTC discipline**: the app already writes `new Date()`/ISO-UTC everywhere. `timestamp(3)` drops the tz — do not introduce mixed-timezone writers. Session expiry (`Session.expiresAt`, 7-day TTL) compares UTC — unaffected. SQLite stored ms-epoch integers; PG stores real timestamps — the seed and replay script must carry timestamps verbatim (ms precision is preserved by `timestamp(3)`). |
| `Float` | **Only two columns in the entire schema:** `Product.ratingAvg` (`schema.prisma:320`, `@default(0)`) and `FinMigrationBackup.oldValue` (`schema.prisma:1097`, the historical percent freeze anchor) | `double precision` | Neither is money. `FinMigrationBackup.oldValue` is the **reversibility anchor** for the bps migration — after cutover, re-run fin-reconcile section J (backup round-trip) to prove byte-exact preservation. |
| `Int @id @default(autoincrement())` | `CommissionSetting`, a few counters | `integer GENERATED BY DEFAULT AS IDENTITY` | Prisma handles it; the replay script must re-seed sequences after copying explicit ids. |

### 3.3 JSON-in-String columns (decision point)

SQLite/Prisma has no `Json` field type, so every JSON payload is a `String` column parsed via
`src/lib/json.ts`. **35 such columns** exist (actual columns found by reading the schema):
`snapshotJson` (CommissionExport), `themeJson` (Store) + `themeJson` (Banner), `socialJson`,
`draftJson`, `publishedJson` (Page), `flagsJson`, `overridesJson` (ShopSection), 
`shippingAddressJson`, `riskFlagsJson` (Order), `dataJson` (NotificationLog), `breakdownJson`
(OrderItem), `payloadJson` (PaymentWebhookLog) + `payloadJson` (WebhookDelivery), `lastErrorJson`
(PayoutBatch), `statementJson` (Payout), `configJson`, `eventsJson` (StoreWebhook), `payloadJson`
(IntegrationEvent — third use), `scopesJson` (ApiKey) + `scopesJson` (ImportJob), `valueJson`
(Setting), `beforeJson`, `afterJson` (AuditLog), `metaJson` (ActivityLog), `paramsJson`
(ReportExport), `progressJson`, `errorJson`, `summaryJson` (ImportJob), `warningsJson`
(ImportJob) + `warningsJson` (MarketplaceSync), `verificationResultJson` (MarketplaceSync),
`structuredDataJson`, `lockedFieldsJson` (SeoProfile).

Two options:

| Option | Mapping | Pros | Cons |
|---|---|---|---|
| **A. Keep as text (recommended for cutover)** | `String` → `text`, app untouched | **Zero-risk, byte-exact cutover.** `json.ts` helpers, raw `JSON.parse` sites, export snapshots and the FinMigrationBackup round-trip all behave identically. One variable (the engine) removed from the migration. | No DB-side JSON queries; stays a phase-2 item. |
| **B. Promote to Json now** | `String` → Prisma `Json` → `jsonb` | Indexable, DB-side validation | 35 columns × parse/serialize backfill; every `toJson()/parseJson<T>()` call site returns/accepts strings and must be audited; corrupt-JSON robustness issues (blueprint §T: 21 files raw-`JSON.parse`) become DB-rejections. |

**Recommendation:** Option A for the cutover; Option B as a **separate, later migration** done
column-batch by column-batch (starting with read-heavy ones: `Setting.valueJson`,
`Order.shippingAddressJson`), each batch gated by `bun scripts/fin-reconcile.ts`.

## 4. Migration strategy

There is no Prisma-native SQLite→PostgreSQL data transfer; the schema and the data move in two
separate mechanisms regardless of option chosen.

### Option A — `prisma migrate diff` baseline + replay script (RECOMMENDED)

1. **Schema:** flip `provider` to `"postgresql"` → `bunx prisma migrate diff --from-empty
   --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/0_init/migration.sql`
   → `bunx prisma migrate dev --name init` (or `migrate deploy` in CI) → baseline is
   reviewable SQL instead of opaque `db push`.
2. **Data:** a purpose-built Bun replay script (`scripts/pg-replay.ts`, to be written):
   - read all rows from SQLite via Prisma, write to PG via Prisma, **in FK-safe order**
     (Plan → Seller → Store → Product … LedgerTransaction → LedgerLine last);
   - copy every column **verbatim** (ids, timestamps, JSON strings, Float anchors);
   - `--dry-run` mode (counts only) + a written **manifest** (rows-per-table) that the
     reconciliation step compares;
   - idempotent per table (`deleteMany` before `createMany` chunks) so it can re-run after a
     partial failure;
   - re-seed identity sequences for the autoincrement tables at the end.
3. **Verify:** `bun scripts/fin-reconcile.ts` against the PG `DATABASE_URL` (the script uses a
   plain `PrismaClient` — provider-agnostic) → 25/25 required. Re-run `bun scripts/fin-tests.ts`
   (DB-free, sanity only). Compare per-table row counts + a `SUM(amountMinor)`-style checksum
   for ledger/wallet tables against the manifest.

**Why recommended:** the schema comes from the datamodel (single source of truth, reviewable
diff), and the data mover is a testable, re-runnable script we control — safer than raw dumps for
a 76-model schema with JSON-in-String columns and a strict ledger.

### Option B — dump-and-replay via script only

Generate DDL with `pg_dump`-style tooling from a SQLite export (or hand-port DDL), then replay
data with the same script. Rejected as primary path: the DDL is then maintained outside the
Prisma datamodel (drift risk with `db push` workflow used in this repo), and SQLite dump dialect
(`PRAGMA`, affinity, journal tables) does not map cleanly. Keep only as fallback if the Prisma
diff path produces DDL that PG rejects.

## 5. Idempotency & concurrency wins post-migration

- **`LedgerTransaction.idempotencyKey String? @unique` already exists** (verified,
  `prisma/schema.prisma:729`). Comment on that column documents the design: deterministic keys
  (`T1 order_paid:order:<id>`, `T3/T4/T4f payout_*:payout:<id>`); nullable so multi-instance
  postings (T5 refunds per order, T6 adjustments) stay NULL; SQLite UNIQUE treats NULLs as
  distinct — **PostgreSQL behaves identically** (NULLs are distinct in unique b-tree indexes), so
  semantics carry over unchanged.
- Under SQLite the whole database is one write lock, so the unique index races are rare but the
  *throughput* ceiling is what hurts. Under PG with default READ COMMITTED, two concurrent
  webhook transactions attempting the same `idempotencyKey` insert → the second blocks on the
  index and fails with P2002 at commit — **exactly the failure the P2002 → `duplicate:true`
  backstop in `src/app/api/webhooks/payments/process.ts` already handles.** No code change
  needed; concurrency safety *improves* because the DB (not the single file lock) arbitrates.
- **Payout race guard:** the payout batch per-wallet `$transaction` (payout row + T3 atomic) and
  the mark-paid/fail `status:"processing"` CAS gates keep working as-is. On PG they additionally
  get real row-level locking; if batch-vs-manual-mark races are ever observed, upgrade the CAS
  gates to `SELECT … FOR UPDATE` inside the interactive transaction (or `SERIALIZABLE` for the
  batch loop) — a small, local change.
- Interactive transactions get configurable timeouts (`$transaction(..., { timeout })`) — set
  them explicitly post-migration for the webhook and payout-batch transactions.

## 6. Cutover checklist

1. [ ] Announce write-freeze window (maintenance banner; this is pre-go-live, so shopfront can simply be closed).
2. [ ] Final SQLite backup: `bun run db:backup pre-pg-cutover` (see runbook §b — record the resulting path).
3. [ ] Stop the app (no writers during replay).
4. [ ] Flip `provider` to `"postgresql"`; set new `DATABASE_URL`; `prisma generate`; create baseline migration (Option A step 1).
5. [ ] Run `scripts/pg-replay.ts --dry-run`; review manifest; run for real.
6. [ ] Reconcile: `DATABASE_URL=<pg> bun scripts/fin-reconcile.ts` → **25/25**; compare row-count/checksum manifest.
7. [ ] Smoke E2E against PG: shopper login → cart → checkout create → simulate payment (or signed webhook) → order paid → **exactly one** `order_paid` ledger transaction → duplicate replay returns `duplicate:true` → payout batch dry-run + real run → refund path.
8. [ ] `/api/health` returns `ledgerInvariants.ok: true`.
9. [ ] Unfreeze; keep the SQLite file read-only as the system of record for the rollback window (§7).

## 7. Rollback plan

- The cutover happens inside a **write-freeze window**, so until unfreeze the SQLite file is a
  complete, authoritative copy: rollback = point `DATABASE_URL` back at the SQLite file
  (`file:…`), `prisma generate` for the sqlite provider (build the image with both providers or
  keep the pre-cutover image), restart. Trivial because zero writes occurred on PG yet.
- If the freeze window must be shortened and PG has taken writes: treat forward-fix as primary
  (fix forward on PG), and reverse-sync only the affected tables via the replay script's
  per-table mode — **never** blindly copy backwards over a live ledger.
- Keep the SQLite backups produced at step 2 of the cutover checklist for at least the retention
  window in the runbook (§b) even after decommissioning.

## 8. Effort estimate

| Item | Estimate |
|---|---|
| Schema provider swap + type decisions (§2–§3) + `assertInt32Safe` guard (FIN-09) | 0.5 day |
| `scripts/pg-replay.ts` (ordered replay, dry-run, manifest, sequence reseed, idempotent re-runs) | 1–1.5 days |
| Reconciliation fixes (fin-reconcile on PG, Float anchor round-trip, checksums) | 0.5–1 day |
| Staging soak (run the PG DB under the dev server for a day; smoke E2E) | 0.5 day |
| Cutover execution per §6 (with freeze window) | 0.5 day |
| **Total** | **~3–4 engineer-days** for this schema (~76 models), excluding staging/managed-PG provisioning and any decision to promote JSON columns (§3.3 Option B, +1–2 days) |
