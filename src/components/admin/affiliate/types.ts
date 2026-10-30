// Shared response types for the admin affiliate console (Task 2-B).
// Shapes mirror the /api/admin/affiliate/* route handlers EXACTLY — do not
// widen a field here without checking the route file (or vice versa).

export type AffiliateSettings = {
  enabled: boolean;
  sponsorEnabled: boolean;
  maxRateBps: number;
  attrWindowDays: number;
  sponsorWindowDays: number;
  reviewDays: number;
  minPayoutMinor: number;
};

export type ReconPoints = {
  expectedPoolMinor: number;
  allocatedMinor: number;
  heldMinor: number;
  availableMinor: number;
  paidOutMinor: number;
  reversalsMinor: number;
  remainingLiabilityMinor: number;
};

export type EntriesByStatus = { status: string; count: number; amountMinor: number; reversedMinor: number };
export type PayoutsByStatus = { status: string; count: number; amountMinor: number };

export type ReconciliationReport = {
  points: ReconPoints;
  ledgerBalanceMinor: number;
  invariantOk: boolean;
  commissionCount: number;
  entriesByStatus: EntriesByStatus[];
  payoutsByStatus: PayoutsByStatus[];
  pendingEntryCount: number;
};

/** GET /api/admin/affiliate/overview */
export type AffiliateOverviewBody = {
  settings: AffiliateSettings;
  counts: { affiliates: number; suspended: number; links: number; attributionTouches: number };
  reconciliation: ReconciliationReport;
};

/** GET /api/admin/affiliate/accounts (custom body — NOT the meta envelope) */
export type AccountRow = {
  id: string;
  displayName: string;
  slug: string;
  code: string;
  email: string;
  status: string;
  sponsorName: string | null;
  referrals: number;
  lifetimeEarningsMinor: number;
  activatedAt: string;
  suspendedReason: string | null;
};

export type AccountsBody = { total: number; page: number; accounts: AccountRow[] };

export type AffiliateBalances = {
  pendingMinor: number;
  approvedMinor: number;
  availableMinor: number;
  payoutInFlightMinor: number;
  paidMinor: number;
  reversedMinor: number;
  heldMinor: number;
  recoveryMinor: number;
  requestableMinor: number;
};

/** GET /api/admin/affiliate/accounts/[id] */
export type AccountDetail = {
  profile: {
    id: string;
    displayName: string;
    slug: string;
    code: string;
    email: string;
    fullName: string;
    status: string;
    bio: string | null;
    sponsor: { id: string; displayName: string } | null;
    sponsorSource: string | null;
    sponsorAssignedAt: string | null;
    activatedAt: string;
    suspendedReason: string | null;
    userCreatedAt: string;
  };
  balances: AffiliateBalances;
  referralCount: number;
  sponsorAudit: {
    fromSponsorId: string | null;
    toSponsorId: string | null;
    reason: string;
    actorId: string;
    createdAt: string;
  }[];
  commissions: {
    id: string;
    orderNumber: string;
    status: string;
    poolMinor: number;
    rateBps: number;
    createdAt: string;
    directMinor: number;
    sponsorMinor: number;
  }[];
  payouts: {
    id: string;
    amountMinor: number;
    status: string;
    reference: string | null;
    requestedAt: string;
    processedAt: string | null;
  }[];
};

/** GET /api/admin/affiliate/commissions — entry rows. NOTE: the list route
 *  currently omits `availableAt`; typed optional so the UI renders it the
 *  moment the route starts returning it (never fabricates a date). */
export type CommissionEntryRow = {
  role: string;
  status: string;
  amountMinor: number;
  reversedMinor: number;
  holdReason: string | null;
  availableAt?: string | null;
};

export type CommissionRow = {
  id: string;
  orderNumber: string;
  orderItemId: string;
  affiliate: string;
  status: string;
  rateBps: number;
  baseMinor: number;
  poolMinor: number;
  createdAt: string;
  entries: CommissionEntryRow[];
};

export type CommissionsBody = { total: number; page: number; rows: CommissionRow[] };

/** GET /api/admin/affiliate/payouts — NOTE: the list route does not return
 *  `statementJson`; typed optional and rendered when present (see detail). */
export type AffiliatePayoutRow = {
  id: string;
  amountMinor: number;
  status: string;
  method: string;
  reference: string | null;
  note: string | null;
  failReason: string | null;
  requestedAt: string;
  processedAt: string | null;
  affiliate: {
    displayName: string;
    slug: string;
    code: string;
    email: string;
    fullName: string;
    payoutRef: string | null;
  };
  statementJson?: string | null;
};

export type AffiliatePayoutsBody = {
  total: number;
  page: number;
  queue: PayoutsByStatus[];
  payouts: AffiliatePayoutRow[];
};

/** AffiliatePayout.statementJson — built at request time by
 *  lib/affiliate.ts requestAffiliatePayout (order refs + balance snapshot). */
export type PayoutStatement = {
  builtAt?: string;
  balances?: Partial<AffiliateBalances>;
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
