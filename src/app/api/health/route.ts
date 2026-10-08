import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { runLedgerInvariants } from "@/lib/ledger";

// GET /api/health — system heartbeat (SYS-06 lite)
export const GET = handle(async () => {
  const [stores, products, orders] = await Promise.all([
    db.store.count(),
    db.product.count(),
    db.order.count(),
  ]);
  const ledger = await runLedgerInvariants();
  return ok({
    status: "healthy",
    db: "up",
    counts: { stores, products, orders },
    ledgerInvariants: { ok: ledger.ok, problems: ledger.problems },
    time: new Date().toISOString(),
  });
});
