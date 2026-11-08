import { handle, ok, ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { requireCap } from "@/lib/auth";
import { auditAdmin } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { getAffiliateSettings } from "@/lib/affiliate";
import type { AdminAffHoldBody, AdminAffHoldData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/admin/affiliate/commissions/[id]/hold {action: hold|release, reason}
// — manual hold controls on a commission's entries (fraud review, disputed
// attribution). Hold affects BOTH roles' un-paid entries; paid entries are
// never touched (late issues become recovery entries instead).
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  rateLimit(req, "admin-aff-hold", 30);
  const admin = await requireCap("affiliate.manage");
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as AdminAffHoldBody;
  const action = String(body.action ?? "");
  const reason = String(body.reason ?? "").slice(0, 200);
  if (!["hold", "release"].includes(action)) throw new ApiError(400, "VALIDATION", "action must be hold | release");
  if (action === "hold" && reason.trim().length < 10) {
    throw new ApiError(400, "VALIDATION", "A documented reason (≥10 chars) is required to hold a commission");
  }

  const commission = await db.affiliateCommission.findUnique({ where: { id }, include: { entries: true } });
  if (!commission) throw new ApiError(404, "NOT_FOUND", "Commission not found");

  const result = await db.$transaction(async (tx) => {
    if (action === "hold") {
      await tx.affiliateCommissionEntry.updateMany({
        where: { commissionId: id, status: { in: ["pending", "approved", "available"] } },
        data: { status: "held", holdReason: `manual:${reason}` },
      });
      return tx.affiliateCommission.update({ where: { id }, data: { status: "held" } });
    }
    // release: held entries return to the lifecycle (approved) with a FRESH
    // review window (availableAt = now + review_days). Setting availableAt is
    // essential: entries held while pending had availableAt = null and would
    // otherwise NEVER mature (the sweep requires availableAt ≤ now) — funds
    // stuck forever. The affiliate-tick sweep re-matures them on schedule.
    const settings = await getAffiliateSettings();
    const availableAt = new Date(Date.now() + settings.reviewDays * 86400000);
    await tx.affiliateCommissionEntry.updateMany({
      where: { commissionId: id, status: "held" },
      data: { status: "approved", holdReason: null, availableAt },
    });
    return tx.affiliateCommission.update({ where: { id }, data: { status: "approved" } });
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: `affiliate.commission_${action}`,
    entityType: "affiliate_commission",
    entityId: id,
    before: { status: commission.status },
    after: { status: result.status, reason },
  });
  const payload: AdminAffHoldData = { status: result.status };
  return ok(payload);
});
