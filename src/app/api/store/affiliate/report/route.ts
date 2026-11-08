import { handle, ok } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { sellerAffiliateReport } from "@/lib/affiliate-queries";
import type { AffiliateReportQuery, AffiliateReportData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/store/affiliate/report?days=30 — the seller's affiliate performance
// + commission liabilities (spec §7). Seller-isolated: only this store's data.
export const GET = handle(async (req: Request) => {
  const { store } = await requireActiveSellerStore();
  const url = new URL(req.url);
  const days: NonNullable<AffiliateReportQuery["days"]> =
    Math.min(180, Math.max(1, Number(url.searchParams.get("days") ?? 30) || 30));
  const report = await sellerAffiliateReport(store.id, days);
  const payload: AffiliateReportData = { ...report, days };
  return ok(payload);
});
