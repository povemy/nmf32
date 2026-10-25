import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { runLedgerInvariants, type LedgerInvariantResult } from "@/lib/ledger";
import { checkoutGateStats } from "@/lib/checkout-gate";

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
export const GET = handle(async (req: Request) => {
  const g = globalThis as unknown as {
    __ledgerInvariantCache?: { at: number; result: LedgerInvariantResult };
  };
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  const TTL_MS = 60_000;
  let ledger = fresh ? undefined : g.__ledgerInvariantCache?.result;
  if (!ledger || Date.now() - (g.__ledgerInvariantCache?.at ?? 0) > TTL_MS) {
    ledger = await runLedgerInvariants();
    g.__ledgerInvariantCache = { at: Date.now(), result: ledger };
  }

  const [stores, products, orders] = await Promise.all([
    db.store.count(),
    db.product.count(),
    db.order.count(),
  ]);
  return ok({
    status: ledger.ok ? "healthy" : "unhealthy",
    db: "up",
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
  });
});
