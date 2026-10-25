import { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { runLedgerInvariants } from "@/lib/ledger";

// GET /api/admin/system/health — counts + ledger invariants + recent audit trail
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();

  const [sellers, stores, products, orders, recentAudit] = await Promise.all([
    db.seller.count(),
    db.store.count(),
    db.product.count(),
    db.order.count(),
    db.adminAuditLog.findMany({ orderBy: { createdAt: "desc" }, take: 5 }),
  ]);

  const ledger = await runLedgerInvariants();

  return ok({
    status: ledger.ok ? "healthy" : "degraded",
    db: "up",
    counts: { sellers, stores, products, orders },
    ledger: {
      ok: ledger.ok,
      problems: ledger.problems,
      txnCount: ledger.txnCount,
      walletCount: ledger.walletCount,
      // Classification-aware drift report (mission: wallet-ledger drift):
      // hardDrift needs investigation; timeMaturityStale is benign display
      // staleness (totals equal, self-heals) — visible here WITH wallet ids
      // (authenticated surface) for targeted refresh/repair.
      hardDrift: ledger.hardDrift,
      timeMaturityStale: ledger.timeMaturityStale,
    },
    recentAudit,
  });
});
