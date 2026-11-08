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
import type { AdminAffProcessBody, AdminAffProcessData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/admin/affiliate/payouts/[id]/process {action, reference?, reason?}
// — the MANUAL controlled payout workflow (spec §3.H + §12). Finance approves
// (T-A3), executes the bank transfer offline, then records the transfer
// reference when marking paid (T-A4). Failed transfers reverse (T-A4f) and
// release the claimed entries back to available. Idempotent state machine:
// conditional updateMany claims + ledger dedupKeys; no automated bank
// transfer capability is claimed or implied.
//
// C1.2 (Phase 2.2) — REFUND COORDINATION + AMOUNT TRUTH:
//   • Refunds now shrink an open payout's frozen amount transactionally (see
//     reverseAffiliateForRefund): a refund and a payout can no longer both
//     consume the same commission liability.
//   • Because the payout row can change between the pre-tx read and the
//     claim, EVERY action re-reads the payout row AFTER winning its
//     conditional claim (the claim row lock makes the re-read stable) and
//     uses the FRESH amountMinor for the ledger posting — T-A3/T-A4/T-A4f
//     can never post a stale amount.
//   • approve additionally RE-VALIDATES the frozen amount against live entry
//     truth (Σ (amount − reversed) over the claimed live entries, minus the
//     current recovery offset from paid entries). A refund that consumed
//     recovery headroom since the request surfaces as 409 FROZEN_AMOUNT_STALE
//     — the operator then rejects the payout so the affiliate can re-request
//     at the correct amount. Approve is the transfer AUTHORIZATION point of
//     the manual workflow, so this is the last fully-safe gate before money
//     moves; refunds landing between approve and mark-paid shrink the amount
//     further (and debit PAYOUT_CLEARING via the T5 split), keeping the books
//     balanced at the adjusted figure.
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  rateLimit(req, "admin-aff-payout", 30);
  const admin = await requireCap("affiliate.finance");
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as AdminAffProcessBody;
  const action = String(body.action ?? "");
  const reference = body.reference != null ? String(body.reference).trim().slice(0, 100) : null;
  const reason = body.reason != null ? String(body.reason).slice(0, 300) : null;

  if (!["approve", "mark-paid", "fail", "reject"].includes(action)) {
    throw new ApiError(400, "VALIDATION", "action must be approve | mark-paid | fail | reject");
  }
  if ((action === "fail" || action === "reject") && (!reason || reason.trim().length < 5)) {
    throw new ApiError(400, "VALIDATION", "A reason is required");
  }

  const payout = await db.affiliatePayout.findUnique({ where: { id } });
  if (!payout) throw new ApiError(404, "NOT_FOUND", "Payout not found");

  if (action === "mark-paid" && payout.amountMinor > 0 && !reference) {
    // F-1 FIX (Work 2): a payout consumed to 0 by refunds settles with NO bank
    // transfer, so no transfer reference can exist — the requirement applies
    // only when there is money to transfer. (amountMinor read pre-tx; a refund
    // shrinking it further between read and claim only makes the provided
    // reference unused, never a missing one.)
    throw new ApiError(400, "VALIDATION", "The bank/PSP transfer reference is required to mark a payout paid");
  }

  const result = await db.$transaction(async (tx) => {
    if (action === "approve") {
      const claim = await tx.affiliatePayout.updateMany({
        where: { id, status: "requested" },
        data: { status: "processing", processedBy: admin.id },
      });
      if (claim.count === 0) throw new ApiError(409, "STATE_INVALID", "Only a requested payout can be approved");
      // C1.2: fresh read AFTER the claim (row lock held) — the frozen amount
      // may have been shrunk by refunds since the pre-tx read.
      const fresh = await tx.affiliatePayout.findUniqueOrThrow({ where: { id } });

      // ---- C1.2 amount re-validation against live entry truth ------------
      // truth = Σ(amount − reversed) over the payout's live claimed entries −
      // the CURRENT recovery offset (reversals booked against already-paid
      // entries). Equal to the frozen amount in the steady state; a refund
      // that consumed recovery headroom makes truth < amount → refuse.
      const claimed = await tx.affiliateCommissionEntry.findMany({
        where: { payoutId: id, status: { in: ["available", "approved"] } },
        select: { amountMinor: true, reversedMinor: true },
      });
      const recovery = (
        await tx.affiliateCommissionEntry.aggregate({
          where: { beneficiaryAffiliateId: fresh.affiliateId, status: "paid" },
          _sum: { reversedMinor: true },
        })
      )._sum.reversedMinor ?? 0;
      const liveValue = claimed.reduce((s, e) => s + e.amountMinor - e.reversedMinor, 0);
      const truth = Math.max(0, liveValue - recovery);
      if (truth < fresh.amountMinor) {
        throw new ApiError(
          409,
          "FROZEN_AMOUNT_STALE",
          `Commissions totalling ${fresh.amountMinor - truth} sen were reversed by refunds since this request was created — reject this payout so the affiliate can re-request at the correct amount`
        );
      }

      await postAffiliatePayoutInitiated({ payoutId: fresh.id, affiliateId: fresh.affiliateId, amountMinor: fresh.amountMinor, tx });
      return { status: "processing", amountMinor: fresh.amountMinor };
    }

    if (action === "mark-paid") {
      const claim = await tx.affiliatePayout.updateMany({
        where: { id, status: "processing" },
        data: { status: "paid", reference, processedAt: new Date(), processedBy: admin.id },
      });
      if (claim.count === 0) throw new ApiError(409, "STATE_INVALID", "Only a processing payout can be marked paid");
      // C1.2: fresh read AFTER the claim — refunds between approve and the
      // bank transfer shrink the amount transactionally; the ledger must
      // record the adjusted figure (finance should transfer the CURRENT
      // amount shown in the queue, and the T5 clearing split keeps the books
      // balanced at exactly this number).
      // F-1 FIX (Work 2): at amount 0 there is nothing to transfer — the T5
      // clearing lines already returned the full T-A3 credit (ΣX == T-A3
      // amount under the V-F8 cap), so PAYOUT_CLEARING already nets to zero.
      // Skip the T-A4 posting entirely: a zero-value transaction is rejected
      // by the ledger core and would 500 the payout into a permanent
      // `processing` stuck state. (Reachable only for legacy pre-fix rows —
      // post-fix refunds auto-release processing payouts at 0 — kept as the
      // operator remediation path.)
      const fresh = await tx.affiliatePayout.findUniqueOrThrow({ where: { id } });
      if (fresh.amountMinor > 0) {
        await postAffiliatePayoutConfirmed({ payoutId: fresh.id, amountMinor: fresh.amountMinor, reference: reference!, tx });
      }
      const paidAt = new Date();
      // The claimed entries become paid (skip any reversed in the interim —
      // those remain recovery offsets rather than double-counting).
      await tx.affiliateCommissionEntry.updateMany({
        where: { payoutId: fresh.id, status: { in: ["available", "approved"] } },
        data: { status: "paid", paidAt },
      });
      // Advance the PARENT commission rows to paid once EVERY entry on them is
      // paid (spec §10 lifecycle: the commission row's status mirrors its
      // entries — payouts flip both, not only the per-beneficiary entries).
      const covered = await tx.affiliateCommissionEntry.findMany({
        where: { payoutId: fresh.id },
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
      return { status: "paid", reference, amountMinor: fresh.amountMinor };
    }

    if (action === "fail") {
      const claim = await tx.affiliatePayout.updateMany({
        where: { id, status: "processing" },
        data: { status: "failed", failReason: reason, processedAt: new Date(), processedBy: admin.id },
      });
      if (claim.count === 0) throw new ApiError(409, "STATE_INVALID", "Only a processing payout can be marked failed");
      // C1.2: fresh read AFTER the claim — T-A4f must release the ADJUSTED
      // amount so PAYOUT_CLEARING nets to zero against T-A3 + any T5 splits.
      // F-1 FIX (Work 2): at amount 0 the T5 clearing lines have already
      // consumed the entire T-A3 credit (ΣX == T-A3 amount) — a T-A4f would
      // be zero-value (rejected by the ledger core, HTTP 500, stuck
      // processing). Skip it; the entry release below still runs.
      const fresh = await tx.affiliatePayout.findUniqueOrThrow({ where: { id } });
      if (fresh.amountMinor > 0) {
        await postAffiliatePayoutFailed({ payoutId: fresh.id, amountMinor: fresh.amountMinor, reason: reason ?? "unspecified", tx });
      }
      // Release the claimed entries back to the available pool.
      await tx.affiliateCommissionEntry.updateMany({
        where: { payoutId: fresh.id, status: { in: ["available", "approved"] } },
        data: { payoutId: null },
      });
      return { status: "failed", reason, amountMinor: fresh.amountMinor };
    }

    // reject — a REQUESTED payout never moved money; release the claim.
    const claim = await tx.affiliatePayout.updateMany({
      where: { id, status: "requested" },
      data: { status: "rejected", failReason: reason, processedAt: new Date(), processedBy: admin.id },
    });
    if (claim.count === 0) throw new ApiError(409, "STATE_INVALID", "Only a requested payout can be rejected");
    await tx.affiliateCommissionEntry.updateMany({
      where: { payoutId: id, status: { in: ["available", "approved"] } },
      data: { payoutId: null },
    });
    return { status: "rejected", reason, amountMinor: payout.amountMinor };
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: `affiliate.payout_${action.replace("-", "_")}`,
    entityType: "affiliate_payout",
    entityId: id,
    before: { status: payout.status, amountMinor: payout.amountMinor },
    after: result,
  });

  const payload: AdminAffProcessData = result;
  return ok(payload);
});
