import { handle, ok, ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { requireCap } from "@/lib/auth";
import { auditAdmin } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import {
  postAffiliatePayoutInitiated,
  postAffiliatePayoutConfirmed,
  postAffiliatePayoutFailed,
} from "@/lib/ledger";

export const dynamic = "force-dynamic";

// POST /api/admin/affiliate/payouts/[id]/process {action, reference?, reason?}
// — the MANUAL controlled payout workflow (spec §3.H + §12). Finance approves
// (T-A3), executes the bank transfer offline, then records the transfer
// reference when marking paid (T-A4). Failed transfers reverse (T-A4f) and
// release the claimed entries back to available. Idempotent state machine:
// conditional updateMany claims + ledger dedupKeys; no automated bank
// transfer capability is claimed or implied.
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  rateLimit(req, "admin-aff-payout", 30);
  const admin = await requireCap("affiliate.finance");
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "");
  const reference = body.reference != null ? String(body.reference).trim().slice(0, 100) : null;
  const reason = body.reason != null ? String(body.reason).slice(0, 300) : null;

  if (!["approve", "mark-paid", "fail", "reject"].includes(action)) {
    throw new ApiError(400, "VALIDATION", "action must be approve | mark-paid | fail | reject");
  }
  if (action === "mark-paid" && !reference) {
    throw new ApiError(400, "VALIDATION", "The bank/PSP transfer reference is required to mark a payout paid");
  }
  if ((action === "fail" || action === "reject") && (!reason || reason.trim().length < 5)) {
    throw new ApiError(400, "VALIDATION", "A reason is required");
  }

  const payout = await db.affiliatePayout.findUnique({ where: { id } });
  if (!payout) throw new ApiError(404, "NOT_FOUND", "Payout not found");

  const result = await db.$transaction(async (tx) => {
    if (action === "approve") {
      const claim = await tx.affiliatePayout.updateMany({
        where: { id, status: "requested" },
        data: { status: "processing", processedBy: admin.id },
      });
      if (claim.count === 0) throw new ApiError(409, "STATE_INVALID", "Only a requested payout can be approved");
      await postAffiliatePayoutInitiated({ payoutId: payout.id, affiliateId: payout.affiliateId, amountMinor: payout.amountMinor, tx });
      return { status: "processing" };
    }

    if (action === "mark-paid") {
      const claim = await tx.affiliatePayout.updateMany({
        where: { id, status: "processing" },
        data: { status: "paid", reference, processedAt: new Date(), processedBy: admin.id },
      });
      if (claim.count === 0) throw new ApiError(409, "STATE_INVALID", "Only a processing payout can be marked paid");
      await postAffiliatePayoutConfirmed({ payoutId: payout.id, amountMinor: payout.amountMinor, reference: reference!, tx });
      const paidAt = new Date();
      // The claimed entries become paid (skip any reversed in the interim —
      // those remain recovery offsets rather than double-counting).
      await tx.affiliateCommissionEntry.updateMany({
        where: { payoutId: payout.id, status: { in: ["available", "approved"] } },
        data: { status: "paid", paidAt },
      });
      // Advance the PARENT commission rows to paid once EVERY entry on them is
      // paid (spec §10 lifecycle: the commission row's status mirrors its
      // entries — payouts flip both, not only the per-beneficiary entries).
      const covered = await tx.affiliateCommissionEntry.findMany({
        where: { payoutId: payout.id },
        select: { commissionId: true },
      });
      const commissionIds = [...new Set(covered.map((e) => e.commissionId))];
      for (const cid of commissionIds) {
        const entries = await tx.affiliateCommissionEntry.findMany({
          where: { commissionId: cid },
          select: { status: true },
        });
        if (entries.length > 0 && entries.every((e) => e.status === "paid" || e.status === "reversed")) {
          await tx.affiliateCommission.updateMany({
            where: { id: cid, status: { in: ["approved", "available"] } },
            data: { status: "paid", paidAt },
          });
        }
      }
      return { status: "paid", reference };
    }

    if (action === "fail") {
      const claim = await tx.affiliatePayout.updateMany({
        where: { id, status: "processing" },
        data: { status: "failed", failReason: reason, processedAt: new Date(), processedBy: admin.id },
      });
      if (claim.count === 0) throw new ApiError(409, "STATE_INVALID", "Only a processing payout can be marked failed");
      await postAffiliatePayoutFailed({ payoutId: payout.id, amountMinor: payout.amountMinor, reason: reason ?? "unspecified", tx });
      // Release the claimed entries back to the available pool.
      await tx.affiliateCommissionEntry.updateMany({
        where: { payoutId: payout.id, status: { in: ["available", "approved"] } },
        data: { payoutId: null },
      });
      return { status: "failed", reason };
    }

    // reject — a REQUESTED payout never moved money; release the claim.
    const claim = await tx.affiliatePayout.updateMany({
      where: { id, status: "requested" },
      data: { status: "rejected", failReason: reason, processedAt: new Date(), processedBy: admin.id },
    });
    if (claim.count === 0) throw new ApiError(409, "STATE_INVALID", "Only a requested payout can be rejected");
    await tx.affiliateCommissionEntry.updateMany({
      where: { payoutId: payout.id, status: { in: ["available", "approved"] } },
      data: { payoutId: null },
    });
    return { status: "rejected", reason };
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: `affiliate.payout_${action.replace("-", "_")}`,
    entityType: "affiliate_payout",
    entityId: id,
    before: { status: payout.status, amountMinor: payout.amountMinor },
    after: { ...result, amountMinor: payout.amountMinor },
  });

  return ok(result);
});
