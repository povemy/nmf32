import { handle, ok } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { affiliateReconciliation } from "@/lib/affiliate-queries";

export const dynamic = "force-dynamic";

// GET /api/admin/affiliate/reconciliation — the 7-point financial
// reconciliation report (spec §9): expected pool vs allocated vs held vs
// available vs paid vs reversals vs remaining liability, cross-checked
// against the PLATFORM:AFFILIATE_LIABILITY ledger balance.
export const GET = handle(async () => {
  await requireCap("affiliate.finance");
  const report = await affiliateReconciliation();
  return ok(report);
});
