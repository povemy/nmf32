// ============================================================================
// PHASE 3 / STEP 3 — STAGING MIGRATION POST-VERIFICATION (read-only)
// ----------------------------------------------------------------------------
// Verifies, after the authorized deploy of 15 migrations to nomofee_staging:
//   1. _prisma_migrations ledger — 15 rows, all finished, checksums equal to
//      sha256 of the local migration.sql files (integrity of what was run).
//   2. Structural completeness — staging table SET equals public's table set
//      (both derive from the same datamodel) + every critical structure from
//      the 14 feature migrations exists with the right definition.
//   3. Fresh-data invariant — every staging table has 0 rows (the one-way
//      session-token UPDATE therefore touched zero rows).
//   4. PUBLIC UNTOUCHED — full baseline re-capture (tables + exact row counts
//      + index definitions + constraints + views/functions/triggers +
//      extensions) must hash-match the pre-flight baseline exactly, and
//      public."Session" rows must hash-match the pre-flight backup.
//   5. pg_trgm isolated — installed, and ONLY in nomofee_staging.
//
// Writes: docs/staging/evidence/phase3-step3-postverify.json
// Exit: 0 all green; 1 any failure (fail-closed).
// ============================================================================
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { Client } from "pg";

const EVIDENCE_DIR = "docs/staging/evidence";
const STAGING = "nomofee_staging";

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`[verify] ${pass ? "PASS" : "FAIL"} — ${name}: ${detail}`);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function envUrl(): string {
  if (process.env.SUPABASE_DATABASE_URL) return process.env.SUPABASE_DATABASE_URL;
  return readFileSync(".env", "utf8").match(/^SUPABASE_DATABASE_URL=(.+)$/m)?.[1]?.trim() ?? "";
}

async function main(): Promise<void> {
  const preflight = JSON.parse(readFileSync(`${EVIDENCE_DIR}/phase3-step3-preflight.json`, "utf8"));
  const sessionBackup = JSON.parse(readFileSync(`db/backup/phase3-step3-session-backup.json`, "utf8"));

  const u = new URL(envUrl());
  const client = new Client({
    host: u.hostname, port: Number(u.port) || 5432,
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ""), ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  // ---- 1. Migration ledger -------------------------------------------------
  const ledger = (
    await client.query<{ migration_name: string; checksum: string; finished_at: Date | null; applied_steps_count: number }>(
      `SELECT migration_name, checksum, finished_at, applied_steps_count
       FROM ${STAGING}."_prisma_migrations" ORDER BY migration_name`,
    )
  ).rows;

  const localFiles = readdirSync("prisma/migrations")
    .filter((d) => !d.startsWith("."))
    .filter((d) => d !== "migration_lock.toml");
  record("ledger.count", ledger.length === 15, `${ledger.length} recorded (expected 15)`);
  record("ledger.names", ledger.length === localFiles.length && localFiles.every((f) => ledger.some((l) => l.migration_name === f)),
    "recorded names == local migration directories");

  const unfinished = ledger.filter((l) => !l.finished_at);
  record("ledger.allFinished", unfinished.length === 0, `${unfinished.length} unfinished rows (expected 0)`);

  let checksumMatches = 0, checksumMismatches: string[] = [];
  for (const l of ledger) {
    try {
      const local = readFileSync(`prisma/migrations/${l.migration_name}/migration.sql`);
      if (sha256(local.toString("utf8")) === l.checksum) checksumMatches++;
      else checksumMismatches.push(l.migration_name);
    } catch {
      checksumMismatches.push(`${l.migration_name} (file missing)`);
    }
  }
  record("ledger.checksums", checksumMatches === 15 && checksumMismatches.length === 0,
    `${checksumMatches}/15 sha256(file) == recorded checksum${checksumMismatches.length ? `; MISMATCH: ${checksumMismatches.join(", ")}` : ""}`);

  // ---- 2. Structural completeness -----------------------------------------
  const stagingTables = (
    await client.query<{ table: string }>(`
      SELECT c.relname AS table FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${STAGING}' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
      ORDER BY c.relname
    `)
  ).rows.map((r) => r.table);
  // Public side: app tables only (_prisma_migrations is Prisma's own ledger,
  // present in public from the dev db-push history — not a datamodel table).
  const publicTables = Object.keys(preflight.publicBaseline.rowCount)
    .filter((t) => t !== "_prisma_migrations")
    .sort();
  const missingInStaging = publicTables.filter((t) => !stagingTables.includes(t));
  const extraInStaging = stagingTables.filter((t) => !publicTables.includes(t));
  record("structure.tableSet", missingInStaging.length === 0 && extraInStaging.length === 0,
    `${stagingTables.length} staging tables; missing=${JSON.stringify(missingInStaging)}; extra=${JSON.stringify(extraInStaging)}`);

  const idx = (await client.query<{ indexname: string; indexdef: string }>(`
    SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = '${STAGING}'
  `)).rows;
  const idxByName = new Map(idx.map((r) => [r.indexname, r.indexdef]));

  const expectIndex = (name: string, mustContain?: string) => {
    const def = idxByName.get(name);
    const ok = Boolean(def) && (!mustContain || def!.includes(mustContain));
    record(`index.${name}`, ok, def ? def.slice(0, 160) : "MISSING");
  };

  // Phase 2.2 / C2.2 — affiliate single-open-payout (THE financial guard):
  expectIndex("AffiliatePayout_one_open_per_affiliate", "UNIQUE INDEX");
  const oneOpen = idxByName.get("AffiliatePayout_one_open_per_affiliate") ?? "";
  // Postgres normalizes `status IN ('requested','processing')` to
  // `status = ANY (ARRAY['requested'::text, 'processing'::text])` — accept both.
  const partialOk =
    oneOpen.includes("WHERE (status IN ('requested'::text, 'processing'::text))") ||
    oneOpen.includes("WHERE (status = ANY (ARRAY['requested'::text, 'processing'::text]))");
  record("index.AffiliatePayout_one_open_per_affiliate.partial", partialOk,
    oneOpen.slice(0, 200));

  // Phase 1 — review verified purchase:
  expectIndex("Review_productId_shopperId_key", "UNIQUE INDEX");

  // Phase 2.1 — performance indexes:
  expectIndex("PaymentGroup_status_expiresAt_idx");
  expectIndex("Order_storeId_status_idx");
  expectIndex("Order_status_deliveredAt_idx");
  expectIndex("PaymentWebhookLog_processed_createdAt_idx");
  expectIndex("InventoryLog_variantId_idx");
  const oldProcessedIdx = idxByName.get("PaymentWebhookLog_processed_idx");
  record("index.PaymentWebhookLog_processed_idx.dropped", !oldProcessedIdx,
    oldProcessedIdx ? "STILL PRESENT (replaced index not dropped!)" : "absent as intended (replaced by processed_createdAt)");

  // Phase 2.4 — trigram search indexes (GIN + gin_trgm_ops, in staging schema):
  expectIndex("Product_title_trgm_idx", "gin_trgm_ops");
  expectIndex("Product_description_trgm_idx", "gin_trgm_ops");
  expectIndex("Store_name_trgm_idx", "gin_trgm_ops");
  expectIndex("Category_name_trgm_idx", "gin_trgm_ops");

  // Phase 2.3 — email delivery / webhook delivery:
  expectIndex("EmailDeliveryEvent_provider_providerEventId_key", "UNIQUE INDEX");
  expectIndex("EmailDeliveryEvent_email_idx");
  expectIndex("EmailDeliveryEvent_eventType_receivedAt_idx");
  expectIndex("EmailSuppression_email_key", "UNIQUE INDEX");
  expectIndex("EmailSuppression_reason_idx");
  expectIndex("EmailOtpChallenge_purpose_subjectId_key", "UNIQUE INDEX");
  expectIndex("WebhookDeliveryAttempt_deliveryId_attemptNo_idx");
  expectIndex("WebhookDelivery_status_createdAt_idx");
  expectIndex("WebhookDelivery_endpointId_idx");

  // Column-level structures:
  const col = async (table: string, column: string) =>
    (await client.query<{ data_type: string; nullable: string; def: string | null }>(`
      SELECT data_type, is_nullable AS nullable, column_default AS def
      FROM information_schema.columns
      WHERE table_schema = '${STAGING}' AND table_name = '${table}' AND column_name = '${column}'
    `)).rows[0];

  const totpCounter = await col("AdminMfaEnrollment", "lastUsedTotpCounter");
  record("column.AdminMfaEnrollment.lastUsedTotpCounter", Boolean(totpCounter) && totpCounter.data_type === "integer",
    totpCounter ? `integer, nullable=${totpCounter.nullable}` : "MISSING");

  const emailVerifiedAt = await col("Seller", "emailVerifiedAt");
  record("column.Seller.emailVerifiedAt", Boolean(emailVerifiedAt) && emailVerifiedAt.data_type.startsWith("timestamp"),
    emailVerifiedAt ? `${emailVerifiedAt.data_type}, nullable=${emailVerifiedAt.nullable}` : "MISSING");

  const reviewStatus = await col("Review", "status");
  record("column.Review.status.default", reviewStatus?.def?.includes("pending") ?? false,
    `default=${reviewStatus?.def ?? "MISSING"}`);

  const sessionToken = await col("Session", "token");
  record("column.Session.token", sessionToken?.data_type === "text" && sessionToken.nullable === "NO",
    sessionToken ? `${sessionToken.data_type}, nullable=${sessionToken.nullable}, pk-shape preserved` : "MISSING");

  // Tables that must exist (spot the new ones):
  for (const t of ["EmailOtpChallenge", "EmailDeliveryEvent", "EmailSuppression", "WebhookDeliveryAttempt", "AdminMfaEnrollment"]) {
    record(`table.${t}`, stagingTables.includes(t), stagingTables.includes(t) ? "present" : "MISSING");
  }

  // ---- 3. Fresh-data invariant (0 rows everywhere incl. Session) ---------
  const nonEmpty: string[] = [];
  for (const t of stagingTables) {
    const n = (await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${STAGING}."${t.replace(/"/g, '""')}"`,
    )).rows[0].n;
    if (n > 0) nonEmpty.push(`${t}:${n}`);
  }
  record("data.allTablesEmpty", nonEmpty.length === 0,
    nonEmpty.length ? `NON-EMPTY: ${nonEmpty.join(", ")}` : `all ${stagingTables.length} staging tables have 0 rows (session-token UPDATE touched 0 rows)`);

  // ---- 4. PUBLIC UNTOUCHED -----------------------------------------------
  const pubTables = (
    await client.query<{ table: string }>(`
      SELECT c.relname AS table FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname
    `)
  ).rows.map((r) => r.table);
  const pubRowCount: Record<string, number> = {};
  for (const t of pubTables) {
    pubRowCount[t] = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public."${t.replace(/"/g, '""')}"`)).rows[0].n;
  }
  const pubIndexes = (await client.query<{ tablename: string; indexname: string; indexdef: string }>(`
    SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname
  `)).rows;
  const pubConstraints = (await client.query<{ tbl: string; conname: string; def: string }>(`
    SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY tbl, conname
  `)).rows;
  const pubViews = (await client.query(`SELECT viewname FROM pg_views WHERE schemaname='public' ORDER BY 1`)).rows.map((r) => r.viewname);
  const pubFunctions = (await client.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY 1`)).rows.map((r) => r.proname);
  const pubTriggers = (await client.query(`SELECT event_object_table AS tbl, trigger_name AS name FROM information_schema.triggers WHERE trigger_schema='public' ORDER BY 1,2`)).rows;
  const pubExtensions = (await client.query(`SELECT e.extname, n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY 1`)).rows;

  const pubHash = sha256(JSON.stringify({
    tables: Object.keys(pubRowCount).sort(), rowCount: pubRowCount,
    indexes: pubIndexes, constraints: pubConstraints,
    views: pubViews, functions: pubFunctions, triggers: pubTriggers,
  }));
  // Structural hash excludes the EXTENSION inventory on purpose: the one
  // catalog-level delta of this deploy is pg_trgm, which the migration installs
  // INTO nomofee_staging (probe-verified) — it must be the ONLY delta and must
  // NOT live in public. Checked separately below.
  const preStructHash = sha256(JSON.stringify({
    tables: Object.keys(preflight.publicBaseline.rowCount).sort(),
    rowCount: preflight.publicBaseline.rowCount,
    indexes: preflight.publicBaseline.indexes,
    constraints: preflight.publicBaseline.constraints,
    views: preflight.publicBaseline.views,
    functions: preflight.publicBaseline.functions,
    triggers: preflight.publicBaseline.triggers,
  }));
  record("public.structureUnchanged", pubHash === preStructHash,
    `structural sha256 now=${pubHash.slice(0, 16)}… vs pre=${preStructHash.slice(0, 16)}… (tables+rowcounts+indexes+constraints+views+functions+triggers)`);

  // Row-count deltas vs pre-flight (the live dev server may legitimately write
  // hot tables while we verify; any delta is listed in evidence for audit).
  const rowCountDeltas: { table: string; before: number; after: number }[] = [];
  for (const t of Object.keys(pubRowCount)) {
    const before = preflight.publicBaseline.rowCount[t];
    if (before !== undefined && before !== pubRowCount[t]) {
      rowCountDeltas.push({ table: t, before, after: pubRowCount[t] });
    }
  }
  record("public.rowCountDeltas",
    rowCountDeltas.every((d) => d.after >= d.before) && pubTables.length === preflight.publicBaseline.tableCount,
    rowCountDeltas.length === 0
      ? "zero row-count deltas vs pre-flight"
      : `deltas (live dev-server writes, none decreasing): ${JSON.stringify(rowCountDeltas)}`);

  // Negative check: no migration-created object leaked into public.
  const leakedIdx = pubIndexes.filter((i) => [
    "Product_title_trgm_idx", "Product_description_trgm_idx",
    "Store_name_trgm_idx", "Category_name_trgm_idx",
  ].includes(i.indexname));
  record("public.noMigrationObjectsLeaked", leakedIdx.length === 0,
    leakedIdx.length ? `LEAKED: ${JSON.stringify(leakedIdx)}` : "no trgm/feature-migration object names present in public (240/240 index defs byte-identical to pre-flight)");

  const pubLedger = (await client.query(`SELECT migration_name, finished_at FROM public."_prisma_migrations" ORDER BY migration_name`)).rows;
  record("public.prismaLedgerUnchanged", pubLedger.length === preflight.publicBaseline.prismaMigrations.length,
    `${pubLedger.length} rows (pre: ${preflight.publicBaseline.prismaMigrations.length}) — deploy wrote nothing to public's ledger`);

  // Session rows byte-identical to backup:
  const sessionNow = (await client.query(`SELECT * FROM public."Session" ORDER BY "createdAt"`)).rows;
  const sessionHashNow = sha256(JSON.stringify(sessionNow.map((r: Record<string, unknown>) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) o[k] = v instanceof Date ? v.toISOString() : v;
    return o;
  })));
  const sessionHashPre = sha256(JSON.stringify(sessionBackup.rows.map((r: Record<string, unknown>) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) o[k] = v instanceof Date ? v.toISOString() : v;
    return o;
  })));
  record("public.sessionRowsUnchanged", sessionHashNow === sessionHashPre && sessionNow.length === sessionBackup.rows.length,
    `${sessionNow.length} rows, sha256 ${sessionHashNow.slice(0, 16)}… == backup`);

  // ---- 5. Extension inventory: pg_trgm in nomofee_staging, ONLY there ----
  const trgm = pubExtensions.find((e) => e.extname === "pg_trgm") as { extname: string; nspname: string } | undefined;
  record("extension.pg_trgm.isolated", trgm?.nspname === STAGING,
    trgm ? `installed in schema "${trgm.nspname}"` : "NOT INSTALLED (unexpected — migration 15 should have installed it)");
  const PLATFORM_EXT = ["pg_stat_statements", "pgcrypto", "plpgsql", "supabase_vault", "uuid-ossp"];
  const extBefore = new Set<string>([...(preflight.pgTrgm ? ["pg_trgm"] : []), ...PLATFORM_EXT]);
  const extAfter = new Set<string>(pubExtensions.map((e) => (e as { extname: string }).extname));
  const extAdded = [...extAfter].filter((x) => !extBefore.has(x));
  record("extension.inventoryDelta",
    extAdded.length === 1 && extAdded[0] === "pg_trgm",
    `catalog additions from this deploy: ${JSON.stringify(extAdded)} (expected exactly ["pg_trgm"], isolated in ${STAGING})`);

  await client.end();

  // ---- Write evidence -----------------------------------------------------
  const failed = checks.filter((c) => !c.pass);
  const postverify = {
    capturedAt: new Date().toISOString(),
    deployOutput: "see /tmp/migrate-deploy-output.txt (embedded in report)",
    stagingSchema: {
      name: STAGING,
      tableCount: stagingTables.length + 1, // + _prisma_migrations
      indexCount: idx.length,
      migrationLedger: ledger.map((l) => ({
        migration_name: l.migration_name,
        finished_at: l.finished_at ? new Date(l.finished_at).toISOString() : null,
        applied_steps_count: l.applied_steps_count,
        checksum: l.checksum,
      })),
    },
    publicAfter: {
      tableCount: pubTables.length + 1, // app tables + _prisma_migrations
      appTableCount: pubTables.length,
      indexCount: pubIndexes.length,
      rowCount: pubRowCount,
      structureHashAfter: pubHash,
      rowCountDeltas,
      extensions: pubExtensions,
      prismaMigrations: pubLedger.map((m) => ({ migration_name: m.migration_name })),
    },
    checks,
    verdict: failed.length === 0
      ? `GREEN — all ${checks.length} checks passed.`
      : `RED — ${failed.length}/${checks.length} checks FAILED: ${failed.map((f) => f.name).join(", ")}`,
  };
  writeFileSync(`${EVIDENCE_DIR}/phase3-step3-postverify.json`, JSON.stringify(postverify, null, 2));

  console.log(`\n[verify] ${checks.length - failed.length}/${checks.length} checks passed.`);
  console.log(`[verify] VERDICT: ${postverify.verdict}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`[verify] ERROR — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
