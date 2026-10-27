// ============================================================================
// TARGET GUARD — fail-closed environment identification for load tests
// (mission: production deployment / staging capacity, Phase 1 §1.2).
// ----------------------------------------------------------------------------
// CONTRACT:
//   • Heavy traffic tests are ONLY permitted against a positively identified
//     non-production target. Everything else is refused BEFORE any request is
//     sent beyond the identification probe.
//   • Identification requires ALL of:
//       1. LOADTEST_TARGET_CONFIRM env explicitly set to `dev-sandbox-local`
//          or `staging` (anything else — unset, typo, `production` — REFUSES).
//       2. The target app answers GET /api/health and reports its
//          `deployment.nodeEnv` — which must NOT be `production`.
//       3. The app's `deployment.dbFingerprint` EQUALS the fingerprint the
//          runner computes from ITS OWN database connection (and, when
//          LOADTEST_DB_FINGERPRINT is provided, equals that too) — proving
//          app and runner agree on which database is about to be exercised,
//          so [LT] setup/cleanup can only touch the intended dataset's DB.
//   • Fingerprint = 16 hex of sha256("poolerHost|databaseOid|maxConnections")
//     — identical formula to /api/health's deployment block. No credentials
//     are read, printed, or transmitted.
//
// Usage (load runner entry):
//   const target = await assertTestTarget();        // throws + exits on refuse
//   // → { base, nodeEnv, dbFingerprint, confirmedAt }
// ============================================================================
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { db } from "../../src/lib/db";

export const ALLOWED_TARGETS = ["dev-sandbox-local", "staging"] as const;
export type AllowedTarget = (typeof ALLOWED_TARGETS)[number];

export type TargetInfo = {
  confirmed: AllowedTarget;
  base: string;
  nodeEnv: string;
  dbFingerprint: string;
  expectedByEnv: string | null;
  confirmedAt: string;
};

function envUrl(): string {
  if (process.env.SUPABASE_DATABASE_URL) return process.env.SUPABASE_DATABASE_URL;
  try {
    return readFileSync(".env", "utf8").match(/^SUPABASE_DATABASE_URL=(.+)$/m)?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Same formula as /api/health `deployment.dbFingerprint`. */
export async function ownDbFingerprint(): Promise<string> {
  let host = "unknown";
  try {
    host = new URL(envUrl()).host;
  } catch { /* keep "unknown" */ }
  let oid = "0";
  let maxc = "0";
  try {
    const rows = await db.$queryRaw<{ oid: string; maxc: string }[]>`SELECT oid::text AS oid, current_setting('max_connections') AS maxc FROM pg_database WHERE datname = current_database()`;
    oid = rows[0]?.oid ?? "0";
    maxc = rows[0]?.maxc ?? "0";
  } catch { /* degrade deterministically */ }
  return createHash("sha256").update(`${host}|${oid}|${maxc}`).digest("hex").slice(0, 16);
}

export async function assertTestTarget(overrides?: { base?: string; confirm?: string }): Promise<TargetInfo> {
  const refuse = (why: string): never => {
    console.error(`\n[target-guard] REFUSED — ${why}`);
    console.error("[target-guard] Load tests may only run with LOADTEST_TARGET_CONFIRM=dev-sandbox-local|staging");
    console.error("[target-guard] against a non-production app whose /api/health deployment.dbFingerprint");
    console.error("[target-guard] matches this runner's own database fingerprint. Nothing was executed.");
    process.exit(78); // EX_CONFIG: configuration error — nothing ran
  };

  const confirm = (overrides?.confirm ?? process.env.LOADTEST_TARGET_CONFIRM ?? "").trim().toLowerCase();
  if (!ALLOWED_TARGETS.includes(confirm as AllowedTarget)) {
    const reason = confirm === ""
      ? "LOADTEST_TARGET_CONFIRM is not set"
      : `LOADTEST_TARGET_CONFIRM "${confirm}" is not one of: ${ALLOWED_TARGETS.join(", ")}`;
    refuse(reason);
  }
  if (confirm === "staging" && !process.env.LOADTEST_DB_FINGERPRINT) {
    // For a declared STAGING run we additionally require the operator to pin
    // the expected fingerprint — a second, independent confirmation that the
    // target DB is the isolated staging database, not production.
    refuse("staging runs require LOADTEST_DB_FINGERPRINT (16-hex from the staging app's /api/health deployment.dbFingerprint)");
  }

  const base = (overrides?.base ?? process.env.LOADTEST_BASE ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  let health: { deployment?: { nodeEnv?: string; dbFingerprint?: string } } = {};
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10_000) });
    const j = (await r.json()) as { data?: { deployment?: { nodeEnv?: string; dbFingerprint?: string } } };
    health = j.data ?? {};
    if (!health?.deployment?.dbFingerprint) throw new Error("deployment block missing (app version predates the guard)");
  } catch (e) {
    refuse(`cannot identify target at ${base} — ${e instanceof Error ? e.message : String(e)} (unreachable, unhealthy, or missing deployment fingerprint)`);
  }

  const nodeEnv = health.deployment?.nodeEnv ?? "unknown";
  if (nodeEnv === "production") {
    refuse(`target ${base} reports NODE_ENV=production — heavy tests against production are forbidden`);
  }

  const appFp = health.deployment?.dbFingerprint ?? "";
  const ownFp = await ownDbFingerprint();
  const pinned = process.env.LOADTEST_DB_FINGERPRINT?.trim().toLowerCase() ?? null;
  if (appFp !== ownFp) {
    refuse(`database mismatch — app reports ${appFp}, this runner resolves ${ownFp} (runner and app must exercise the SAME database)`);
  }
  if (pinned && pinned !== appFp) {
    refuse(`database mismatch — pinned LOADTEST_DB_FINGERPRINT ${pinned} ≠ app ${appFp}`);
  }

  const info: TargetInfo = {
    confirmed: confirm as AllowedTarget,
    base,
    nodeEnv,
    dbFingerprint: appFp,
    expectedByEnv: pinned,
    confirmedAt: new Date().toISOString(),
  };
  console.log(`[target-guard] CONFIRMED target=${confirm} base=${base} nodeEnv=${nodeEnv} dbFingerprint=${appFp}`);
  return info;
}
