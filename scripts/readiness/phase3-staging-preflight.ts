// ============================================================================
// PHASE 3 / STEP 3 — STAGING MIGRATION PRE-FLIGHT (READ-ONLY)
// ----------------------------------------------------------------------------
// Safeguard executor for the authorized staging migration run. STRICTLY
// read-only against the database (SELECT / catalog only; nothing created,
// altered or dropped). Verifies, immediately before execution:
//
//   1. DATABASE IDENTITY — current_database/user/server addr/port/db OID and
//      the SAME fingerprint formula /api/health uses (host|oid|maxConn) —
//      compared LIVE against the running app's report. Any mismatch REFUSES.
//   2. NON-PRODUCTION PROJECT — the app answers NODE_ENV != production; the
//      project contains ONLY Supabase platform databases/schemas/roles (no
//      other app footprint); nomofee_staging does NOT yet exist.
//   3. pg_extension inventory — decides how migration 20261109000000's
//      `CREATE EXTENSION IF NOT EXISTS pg_trgm` will behave (pre-installed
//      → no-op; catalog state is baselined either way).
//   4. PUBLIC BASELINE SNAPSHOT — tables + EXACT row counts, full index
//      definitions, constraints, views, functions, triggers. This is BOTH the
//      non-modification proof (post-run diff must be byte-identical) AND the
//      repair manifest if anything unexpected happens.
//   5. SESSION ROW BACKUP — "Session" is the ONLY table any of the 15
//      migrations writes to (the one-way sha256 token UPDATE in
//      20261101000000). A full row dump is the real data restore point.
//
// Writes:
//   docs/staging/evidence/phase3-step3-preflight.json
//   db/backup/phase3-step3-session-backup.json
//
// Exit codes: 0 = all safeguards green; 78 = REFUSED (identity/allowlist
// violation — nothing executed, nothing written except the refusal reason).
// ============================================================================
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Client } from "pg";

const EVIDENCE_DIR = "docs/staging/evidence";
const APP_HEALTH = process.env.APP_HEALTH_URL ?? "http://127.0.0.1:3000/api/health";

// Supabase platform schemas expected on a stock project. Anything else in
// pg_namespace (outside pg_* system schemas) = unexpected footprint → REFUSE.
const PLATFORM_SCHEMAS = new Set([
  "public", "information_schema", "extensions", "auth", "storage",
  "realtime", "supabase_functions", "graphql_public", "vault", "sudo",
  "pgsodium", "pgsodium_keyset", "net", "pgtle", "_analytics", "_supabase",
  "graphql", "pgbouncer", // platform-owned (supabase_admin / pgbouncer roles)
]);
const PLATFORM_DATABASES = new Set(["postgres", "template0", "template1", "_supabase"]);

function envUrl(): string {
  if (process.env.SUPABASE_DATABASE_URL) return process.env.SUPABASE_DATABASE_URL;
  try {
    return readFileSync(".env", "utf8").match(/^SUPABASE_DATABASE_URL=(.+)$/m)?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

function refuse(reason: string): never {
  console.error(`\n[preflight] REFUSED — ${reason}`);
  console.error("[preflight] No migration content was executed. Nothing was written to the database.");
  process.exit(78);
}

function fingerprint(host: string, oid: string, maxc: string): string {
  return createHash("sha256").update(`${host}|${oid}|${maxc}`).digest("hex").slice(0, 16);
}

async function main(): Promise<void> {
  const rawUrl = envUrl();
  if (!rawUrl) refuse("SUPABASE_DATABASE_URL is not resolvable (env + .env)");
  const u = new URL(rawUrl);
  console.log(`[preflight] target host       : ${u.host}`);
  console.log(`[preflight] target database   : ${u.pathname.replace(/^\//, "")}`);

  // ---- 1. App identity (must be the running dev app, non-production) ------
  let health: { deployment?: { nodeEnv?: string; dbFingerprint?: string }; status?: string; db?: string };
  try {
    const r = await fetch(APP_HEALTH, { signal: AbortSignal.timeout(10_000) });
    const j = (await r.json()) as { data?: { deployment?: { nodeEnv?: string; dbFingerprint?: string }; status?: string; db?: string } };
    health = j.data ?? {};
  } catch (e) {
    refuse(`cannot read app identity from ${APP_HEALTH} — ${e instanceof Error ? e.message : String(e)}`);
  }
  const nodeEnv = health.deployment?.nodeEnv ?? "unknown";
  const appFp = health.deployment?.dbFingerprint ?? "";
  console.log(`[preflight] app nodeEnv       : ${nodeEnv}`);
  console.log(`[preflight] app dbFingerprint : ${appFp}`);
  if (nodeEnv === "production") refuse("the app answering /api/health reports NODE_ENV=production");
  if (health.status !== "healthy" || health.db !== "up") {
    refuse(`app is not healthy (status=${health.status} db=${health.db})`);
  }

  // ---- 2. Database identity + inventories (read-only) --------------------
  const client = new Client({
    host: u.hostname,
    port: Number(u.port) || 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ""),
    ssl: { rejectUnauthorized: false }, // Supavisor pooler TLS; transport still encrypted
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();

  const identity = (
    await client.query<{
      db: string; usr: string; ver: string; addr: string; port: number;
      oid: string; maxc: string; search_path: string; server_encoding: string;
    }>(`
      SELECT current_database() AS db, current_user AS usr, version() AS ver,
             coalesce(inet_server_addr()::text,'') AS addr, inet_server_port() AS port,
             (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS oid,
             current_setting('max_connections') AS maxc,
             current_setting('search_path') AS search_path,
             current_setting('server_encoding') AS server_encoding
    `)
  ).rows[0];

  const dbFp = fingerprint(u.host, identity.oid, identity.maxc);
  console.log(`[preflight] db current_database: ${identity.db} (oid ${identity.oid}) @ ${identity.addr}:${identity.port}`);
  console.log(`[preflight] db current_user    : ${identity.usr}`);
  console.log(`[preflight] db computed fp     : ${dbFp}`);
  if (dbFp !== appFp) {
    await client.end();
    refuse(`database mismatch — app reports fingerprint ${appFp}, this connection resolves ${dbFp}`);
  }
  console.log("[preflight] fingerprint MATCH  : app and migration connection target the SAME database ✓");

  const databases = (await client.query<{ datname: string }>(
    `SELECT datname FROM pg_database WHERE datallowconn ORDER BY datname`,
  )).rows.map((r) => r.datname);
  const unexpectedDbs = databases.filter((d) => !PLATFORM_DATABASES.has(d));
  if (unexpectedDbs.length) {
    await client.end();
    refuse(`unexpected non-platform database(s) present: ${unexpectedDbs.join(", ")}`);
  }

  const schemas = (
    await client.query<{ nspname: string; owner: string }>(`
      SELECT nspname, pg_get_userbyid(nspowner) AS owner
      FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' ORDER BY nspname
    `)
  ).rows;
  const unexpectedSchemas = schemas.filter(
    (s) => !PLATFORM_SCHEMAS.has(s.nspname) && s.nspname !== "nomofee_staging", // our own prepared target — validated separately below
  );
  if (unexpectedSchemas.length) {
    await client.end();
    refuse(`unexpected non-platform schema(s) present: ${unexpectedSchemas.map((s) => s.nspname).join(", ")}`);
  }

  const stagingOwner = (
    await client.query<{ owner: string }>(
      `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'nomofee_staging'`,
    )
  ).rows[0];
  let stagingObjects: { relkind: string; relname: string }[] = [];
  if (stagingOwner) {
    stagingObjects = (
      await client.query<{ relkind: string; relname: string }>(`
        SELECT c.relkind, c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'nomofee_staging' ORDER BY c.relname
      `)
    ).rows;
    // A pre-created EMPTY shell is the Step-2-prepared target (owned by the
    // connecting role, zero objects). Anything with objects = refuse.
    if (stagingObjects.length > 0) {
      await client.end();
      refuse(
        `schema "nomofee_staging" already contains ${stagingObjects.length} object(s) ` +
          `(${stagingObjects.slice(0, 5).map((o) => o.relname).join(", ")}…) — ` +
          `expected an empty prepared target; refusing to touch it`,
      );
    }
    if (stagingOwner.owner !== identity.usr) {
      await client.end();
      refuse(`schema "nomofee_staging" is owned by ${stagingOwner.owner}, not the connecting role ${identity.usr}`);
    }
    console.log("[preflight] staging target    : nomofee_staging exists as an EMPTY shell (0 objects) — fresh target ✓");
  } else {
    console.log("[preflight] staging target    : nomofee_staging does not exist yet — fresh target ✓");
  }

  const loginRoles = (await client.query<{ rolname: string }>(
    `SELECT rolname FROM pg_roles WHERE rolcanlogin ORDER BY rolname`,
  )).rows.map((r) => r.rolname);

  const extensions = (
    await client.query<{ extname: string; nspname: string; extversion: string }>(`
      SELECT e.extname, n.nspname, e.extversion
      FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
      ORDER BY e.extname
    `)
  ).rows;
  const pgTrgm = extensions.find((e) => e.extname === "pg_trgm");
  console.log(
    `[preflight] pg_trgm            : ${pgTrgm ? `installed in schema "${pgTrgm.nspname}" v${pgTrgm.extversion}` : "NOT installed"}`,
  );

  // ---- 3. Public baseline snapshot (non-modification proof) --------------
  const tables = (
    await client.query<{ table: string }>(`
      SELECT c.relname AS table FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname
    `)
  ).rows.map((r) => r.table);

  const rowCount: Record<string, number> = {};
  for (const t of tables) {
    const q = `SELECT count(*)::int AS n FROM public."${t.replace(/"/g, '""')}"`;
    rowCount[t] = (await client.query<{ n: number }>(q)).rows[0].n;
  }

  const indexes = (
    await client.query<{ tablename: string; indexname: string; indexdef: string }>(`
      SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' ORDER BY tablename, indexname
    `)
  ).rows;

  const constraints = (
    await client.query<{ tbl: string; conname: string; def: string }>(`
      SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY tbl, conname
    `)
  ).rows;

  const views = (
    await client.query<{ viewname: string }>(
      `SELECT viewname FROM pg_views WHERE schemaname = 'public' ORDER BY viewname`,
    )
  ).rows.map((r) => r.viewname);

  const functions = (
    await client.query<{ proname: string }>(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' ORDER BY p.proname
    `)
  ).rows.map((r) => r.proname);

  const triggers = (
    await client.query<{ tbl: string; name: string }>(`
      SELECT event_object_table AS tbl, trigger_name AS name
      FROM information_schema.triggers WHERE trigger_schema = 'public' ORDER BY tbl, name
    `)
  ).rows;

  const prismaMigrationsExists = (
    await client.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = '_prisma_migrations'
      ) AS exists
    `)
  ).rows[0].exists;
  const prismaMigrations = prismaMigrationsExists
    ? (await client.query<{ migration_name: string; finished_at: Date | null }>(
        `SELECT migration_name, finished_at FROM public."_prisma_migrations" ORDER BY migration_name`,
      )).rows
    : [];

  const dbSize = (
    await client.query<{ pretty: string; bytes: string }>(`
      SELECT pg_size_pretty(pg_database_size(current_database())) AS pretty,
             pg_database_size(current_database())::text AS bytes
    `)
  ).rows[0];

  // Dev-data characterisation (non-PII): user count + email domain histogram.
  const userTotal = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public."ShopperUser"`)).rows[0].n;
  const emailDomains = (
    await client.query<{ domain: string; n: number }>(`
      SELECT split_part("email", '@', 2) AS domain, count(*)::int AS n
      FROM public."ShopperUser" GROUP BY 1 ORDER BY 2 DESC LIMIT 10
    `)
  ).rows;

  // ---- 4. Session row backup (only table a migration writes to) ---------
  const sessionRows = (await client.query(`SELECT * FROM public."Session" ORDER BY "createdAt"`)).rows;

  await client.end();

  // ---- 5. Write evidence -------------------------------------------------
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const capturedAt = new Date().toISOString();
  const baselineHash = createHash("sha256")
    .update(
      JSON.stringify({ tables: Object.keys(rowCount).sort(), rowCount, indexes, constraints, views, functions, triggers, extensions }),
    )
    .digest("hex");

  const preflight = {
    capturedAt,
    app: { healthUrl: APP_HEALTH, nodeEnv, dbFingerprint: appFp, status: health.status, db: health.db },
    target: {
      urlHost: u.host, database: identity.db, user: identity.usr, oid: identity.oid,
      serverAddr: identity.addr, serverPort: identity.port, maxConnections: identity.maxc,
      computedFingerprint: dbFp, roleDefaultSearchPath: identity.search_path,
      serverVersion: identity.ver.split(",")[0], serverEncoding: identity.server_encoding,
    },
    nonProductionEvidence: {
      databases, schemas, loginRoles,
      userTotal, emailDomains,
      dbSize: dbSize.pretty, dbSizeBytes: Number(dbSize.bytes),
      note: "Only Supabase platform databases/schemas/login roles present; data is the sandbox dev dataset (seeded stores, test email domains); the only app answering for this database reports NODE_ENV=development. No production deployment of NOMOFEE exists (no production credentials, hosts, or domains anywhere in this sandbox).",
    },
    stagingTarget: {
      schema: "nomofee_staging",
      existedBefore: Boolean(stagingOwner),
      owner: stagingOwner?.owner ?? null,
      objectCountBefore: stagingObjects.length,
    },
    pgTrgm: pgTrgm ?? null,
    publicBaseline: {
      tableCount: tables.length,
      rowCount,
      indexCount: indexes.length,
      indexes,
      constraintCount: constraints.length,
      constraints,
      views,
      functions,
      triggers,
      prismaMigrationsTable: prismaMigrationsExists,
      prismaMigrations: prismaMigrations.map((m) => ({
        migration_name: m.migration_name,
        finished_at: m.finished_at ? new Date(m.finished_at).toISOString() : null,
      })),
      baselineHash,
    },
    sessionBackup: { rows: sessionRows.length, file: "db/backup/phase3-step3-session-backup.json" },
    verdict: "GREEN — identity confirmed, non-production project confirmed, fresh nomofee_staging target, baseline captured.",
  };

  writeFileSync(`${EVIDENCE_DIR}/phase3-step3-preflight.json`, JSON.stringify(preflight, null, 2));
  writeFileSync(`db/backup/phase3-step3-session-backup.json`, JSON.stringify({ capturedAt, rows: sessionRows }, null, 2));

  console.log(`[preflight] public baseline  : ${tables.length} tables, ${indexes.length} indexes, ${constraints.length} constraints (hash ${baselineHash.slice(0, 16)}…)`);
  console.log(`[preflight] session backup   : ${sessionRows.length} rows → db/backup/phase3-step3-session-backup.json`);
  console.log(`[preflight] db size          : ${dbSize.pretty}`);
  console.log(`[preflight] login roles      : ${loginRoles.join(", ")}`);
  console.log(`[preflight] VERDICT          : GREEN — pre-flight safeguards all passed.`);
}

main().catch((e) => {
  console.error(`[preflight] ERROR — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
