import { handle, ok } from "@/lib/api";
import { db } from "@/lib/db";
import { requireAnyCap } from "@/lib/auth";
import { getAffiliateSettings } from "@/lib/affiliate";
import { affiliateReconciliation } from "@/lib/affiliate-queries";
import type { AdminAffOverviewData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/admin/affiliate/overview — programme dashboard: counts, settings
// state, and the 7-point reconciliation summary (cap: affiliate.manage).
export const GET = handle(async () => {
  await requireAnyCap("affiliate.manage", "affiliate.finance");
  const [settings, recon, affiliateCount, suspendedCount, linkCount, touchCount] = await Promise.all([
    getAffiliateSettings(),
    affiliateReconciliation(),
    db.affiliateProfile.count(),
    db.affiliateProfile.count({ where: { status: "suspended" } }),
    db.affiliateLink.count(),
    db.affiliateAttributionTouch.count(),
  ]);
  const payload: AdminAffOverviewData = {
    settings,
    counts: {
      affiliates: affiliateCount,
      suspended: suspendedCount,
      links: linkCount,
      attributionTouches: touchCount,
    },
    reconciliation: recon,
  };
  return ok(payload);
});
