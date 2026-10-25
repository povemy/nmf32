import { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { runLedgerInvariants } from "@/lib/ledger";

// GET /api/admin/system/health — counts + ledger invariants + recent audit trail
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();

  const [sellers, stores, products, orders, recentAudit, reconByStatus] = await Promise.all([
    db.seller.count(),
    db.store.count(),
    db.product.count(),
    db.order.count(),
    db.adminAuditLog.findMany({ orderBy: { createdAt: "desc" }, take: 5 }),
    db.paymentReconciliation.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  const ledger = await runLedgerInvariants();

  const reconCounts: Record<string, number> = { requested: 0, processing: 0, succeeded: 0, failed: 0, unknown: 0 };
  for (const row of reconByStatus) reconCounts[row.status] = row._count._all;

  return ok({
    status: ledger.ok ? "healthy" : "degraded",
    db: "up",
    counts: { sellers, stores, products, orders },
    // Late-payment refund/reconciliation obligations (expired-group payments
    // captured at the PSP): failed/unknown need operator eyes — runbook:
    // docs/late-payment-refund-runbook.md. Full drill-down:
    // /api/admin/payment-reconciliation.
    paymentReconciliation: reconCounts,
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
