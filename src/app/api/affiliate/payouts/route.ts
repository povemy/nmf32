import { handle, ok } from "@/lib/api";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { requireAffiliate, affiliateBalances, requestAffiliatePayout, getAffiliateSettings } from "@/lib/affiliate";
import type { PayoutsData, AffiliatePayoutRow, PayoutRequestData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/affiliate/payouts — my payout history + requestable balance.
export const GET = handle(async () => {
  const aff = await requireAffiliate();
  const [payouts, balances, settings] = await Promise.all([
    db.affiliatePayout.findMany({
      where: { affiliateId: aff.id },
      orderBy: { requestedAt: "desc" },
      take: 50,
    }),
    affiliateBalances(aff.id),
    getAffiliateSettings(),
  ]);
  const rows: AffiliatePayoutRow[] = payouts.map((p) => ({
    id: p.id, amountMinor: p.amountMinor, status: p.status, method: p.method,
    reference: p.reference, note: p.note, failReason: p.failReason,
    requestedAt: p.requestedAt.toISOString(),
    processedAt: p.processedAt?.toISOString() ?? null,
  }));
  const payload: PayoutsData = { balances, minPayoutMinor: settings.minPayoutMinor, payouts: rows };
  return ok(payload);
});

// POST /api/affiliate/payouts — request a withdrawal (manual controlled
// workflow: finance approves, executes the transfer and records the bank
// reference — no automated bank transfer is claimed).
export const POST = handle(async (req: Request) => {
  rateLimit(req, "affiliate-payout-request", 3);
  const aff = await requireAffiliate();
  const result = await requestAffiliatePayout(aff.id);
  const payload: PayoutRequestData = { payoutId: result.payoutId, amountMinor: result.amountMinor };
  return ok(payload, { status: 201 });
});
