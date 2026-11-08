// Shared types for the admin affiliate console.
// Wave-4 contract sync: every API payload shape used by the affiliate views is
// re-exported from the centralized contract (src/lib/types/api-contract.ts) so
// the UI and the /api/admin/affiliate/* route handlers share ONE source of
// truth. Only genuinely UI-local shapes live here: the client-side parse
// target for AffiliatePayout.statementJson and the bps label helper.

import type { AdminAffBalances, AdminAffOverviewData, AdminAffReconciliation } from "@/lib/types/api-contract";

export type {
  AdminAffBalances,
  AdminAffAccountRow,
  AdminAffAccountsData,
  AdminAffAccountProfile,
  AdminAffSponsorAuditRow,
  AdminAffAccountCommissionRow,
  AdminAffAccountPayoutRow,
  AdminAffAccountDetailData,
  AdminAffSponsorBody,
  AdminAffSponsorData,
  AdminAffStatusBody,
  AdminAffStatusData,
  AdminAffCommissionsQuery,
  AdminAffCommissionEntryRow,
  AdminAffCommissionRow,
  AdminAffCommissionsData,
  AdminAffHoldBody,
  AdminAffHoldData,
  AdminAffReconciliationPoints,
  AdminAffReconciliation,
  AdminAffOverviewData,
  AdminAffPayoutsQuery,
  AdminAffPayoutRow,
  AdminAffPayoutsData,
  AdminAffProcessBody,
  AdminAffProcessData,
} from "@/lib/types/api-contract";

/** Affiliate settings block — derived from the overview payload (the contract
 *  models it inline on AdminAffOverviewData rather than as a standalone type). */
export type AffiliateSettings = AdminAffOverviewData["settings"];

/** Reconciliation status buckets — element types of the contract report. */
export type EntriesByStatus = AdminAffReconciliation["entriesByStatus"][number];
export type PayoutsByStatus = AdminAffReconciliation["payoutsByStatus"][number];

/** AffiliatePayout.statementJson — built at request time by
 *  lib/affiliate.ts requestAffiliatePayout (order refs + balance snapshot).
 *  UI-local parse target (all-optional, legacy-tolerant): the contract ships
 *  statementJson as an opaque string and defines no standalone affiliate
 *  statement type, so this stays local. */
export type PayoutStatement = {
  builtAt?: string;
  balances?: Partial<AdminAffBalances>;
  entries?: {
    entryId: string;
    commissionId: string;
    orderNumber: string | null;
    amountMinor: number;
    reversedMinor: number;
  }[];
};

/** bps → tasteful percent label: 1000 → "10%", 850 → "8.50%". */
export function bpsLabel(bps: number): string {
  const pct = (bps / 100).toFixed(2);
  return `${pct.endsWith(".00") ? pct.slice(0, -3) : pct}%`;
}
