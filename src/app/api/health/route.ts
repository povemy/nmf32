import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { runLedgerInvariants, type LedgerInvariantResult } from "@/lib/ledger";
import { checkoutGateStats } from "@/lib/checkout-gate";
import { createHash } from "node:crypto";
import type { HealthData, HealthQuery } from "@/lib/types/api-contract";

// GET /api/health — system heartbeat (SYS-06 lite)
//
// MISSION REMEDIATION (wallet-ledger drift + health-check behavior):
// 1. TTL-CACHED: the ledger invariant scan is a full-ledger aggregation
//    (measured ~1.2 s in this environment). Polling it on every health probe
//    wastes DB capacity exactly when the system is busy. Result cached
//    in-process for 60 s; pass ?fresh=1 to force a recompute (ops/debug).
// 2. CLASSIFICATION-AWARE: cache-vs-ledger mismatches are separated into
//    HARD drift (totals differ / unexplained — money-correctness signal,
//    flips ok=false) and benign TIME-MATURITY staleness (holds matured by
//    clock after the cache's last write; totals equal; self-heals on the
//    next wallet event or wallet-page read — reported for visibility only).
// 3. NO SENSITIVE DATA: this endpoint is public — it reports magnitudes and
//    counts only, never wallet ids, seller names or customer data.
//
// DEPLOYMENT-PREFLIGHT (mission: environment separation, Phase 1):
// 4. `deployment` block — nodeEnv + a NON-SENSITIVE database fingerprint
//    (16 hex chars of sha256 over pooler host | database oid | max_connections).
//    Purpose: a load-test runner can positively confirm the app it is about
//    to hammer is backed by the SAME database the runner's own connection
//    resolves to, and refuse when it is not (fail-closed staging guard).
//    The fingerprint is stable per database deployment, reveals no
//    credentials, and is safe to expose publicly. Computed once per process
//    and cached — two tiny queries at most.
async function deploymentFingerprint(): Promise<{ nodeEnv: string; dbFingerprint: string }> {
  const g = globalThis as unknown as { __dbFingerprint?: { at: number; value: { nodeEnv: string; dbFingerprint: string } } };
  if (g.__dbFingerprint && Date.now() - g.__dbFingerprint.at < 3_600_000) return g.__dbFingerprint.value;
  let host = "unknown";
  try {
    host = new URL(process.env.SUPABASE_DATABASE_URL ?? "").host;
  } catch { /* keep "unknown" — fingerprint still identifies the database by oid */ }
  let oid = "0";
  let maxc = "0";
  let resolved = false;
  try {
    const rows = await db.$queryRaw<{ oid: string; maxc: string }[]>`SELECT oid::text AS oid, current_setting('max_connections') AS maxc FROM pg_database WHERE datname = current_database()`;
    oid = rows[0]?.oid ?? "0";
    maxc = rows[0]?.maxc ?? "0";
    resolved = oid !== "0";
  } catch { /* transient — do NOT cache the degraded value; next request retries */ }
  const value = {
    nodeEnv: process.env.NODE_ENV ?? "development",
    dbFingerprint: createHash("sha256").update(`${host}|${oid}|${maxc}`).digest("hex").slice(0, 16),
  };
  // Cache ONLY fully-resolved fingerprints. A degraded fallback (host-only)
  // stays uncached so a transient DB hiccup can never pin the fallback for
  // an hour — the guard's same-DB proof must always converge on real values.
  if (resolved) g.__dbFingerprint = { at: Date.now(), value };
  return value;
}

export const GET = handle(async (req: Request) => {
  const g = globalThis as unknown as {
    __ledgerInvariantCache?: { at: number; result: LedgerInvariantResult };
  };
  const fresh: HealthQuery["fresh"] = new URL(req.url).searchParams.get("fresh") === "1" ? "1" : null;
  const TTL_MS = 60_000;
  let ledger = fresh ? undefined : g.__ledgerInvariantCache?.result;
  if (!ledger || Date.now() - (g.__ledgerInvariantCache?.at ?? 0) > TTL_MS) {
    ledger = await runLedgerInvariants();
    g.__ledgerInvariantCache = { at: Date.now(), result: ledger };
  }

  const [stores, products, orders, deployment] = await Promise.all([
    db.store.count(),
    db.product.count(),
    db.order.count(),
    deploymentFingerprint(),
  ]);
  const payload: HealthData = {
    status: ledger.ok ? "healthy" : "unhealthy",
    db: "up",
    deployment,
    counts: { stores, products, orders },
    ledgerInvariants: {
      ok: ledger.ok,
      txnCount: ledger.txnCount,
      walletCount: ledger.walletCount,
      hardProblems: ledger.problems,
      hardDriftCount: ledger.hardDrift.length,
      // Benign time-maturity staleness — visible, bounded, no wallet ids.
      // magnitudeMinor = Σ|availableDelta| across stale wallets.
      timeMaturityStaleness: {
        count: ledger.timeMaturityStale.length,
        magnitudeMinor: ledger.timeMaturityStale.reduce((s, d) => s + Math.abs(d.availableDelta), 0),
        note: "display-cache staleness only; totals equal; payout authorization uses ledger truth",
      },
    },
    checkoutGate: checkoutGateStats(),
    invariantCachedAt: g.__ledgerInvariantCache?.at ? new Date(g.__ledgerInvariantCache.at).toISOString() : null,
    time: new Date().toISOString(),
  };
  return ok(payload);
});
