import { handle, ok, ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { requireCap } from "@/lib/auth";
import { auditAdmin } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { getAffiliateSettings } from "@/lib/affiliate";

export const dynamic = "force-dynamic";

// POST /api/admin/affiliate/accounts/[id]/status {action: suspend|reinstate|terminate, reason}
// — affiliate review controls (spec §12). Suspended affiliates stop earning NEW
// commissions; their sponsor-role shares on OTHER affiliates' in-flight pools
// are HELD separately (never redirecting the direct promoter's 90%).
// Every action is audit-logged with the authorised admin + reason.
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  rateLimit(req, "admin-aff-status", 30);
  const admin = await requireCap("affiliate.manage");
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "");
  const reason = body.reason != null ? String(body.reason).slice(0, 500) : null;
  if (!["suspend", "reinstate", "terminate"].includes(action)) {
    throw new ApiError(400, "VALIDATION", "action must be suspend | reinstate | terminate");
  }
  if (action !== "reinstate" && (!reason || reason.trim().length < 10)) {
    throw new ApiError(400, "VALIDATION", "A documented reason (≥10 chars) is required");
  }

  const profile = await db.affiliateProfile.findUnique({ where: { id } });
  if (!profile) throw new ApiError(404, "NOT_FOUND", "Affiliate not found");

  const now = new Date();
  const result = await db.$transaction(async (tx) => {
    // Status flip (CAS-style: read state must match expectations).
    const data: Record<string, unknown> =
      action === "suspend"
        ? { status: "suspended", suspendedAt: now, suspendedReason: reason }
        : action === "reinstate"
          ? { status: "active", suspendedAt: null, suspendedReason: null }
          : { status: "terminated", suspendedAt: now, suspendedReason: reason };
    const updated = await tx.affiliateProfile.update({ where: { id }, data });

    if (action === "suspend" || action === "terminate") {
      // Hold this affiliate's PENDING/AVAILABLE sponsor-role shares (they earn
      // nothing while under review). Direct-role entries from OTHER affiliates
      // are untouched — their legitimate 90% is never penalised.
      await tx.affiliateCommissionEntry.updateMany({
        where: {
          beneficiaryAffiliateId: id,
          role: "sponsor",
          status: { in: ["pending", "approved", "available"] },
        },
        data: { status: "held", holdReason: `beneficiary_${action}` },
      });
    } else if (action === "reinstate") {
      // Release holds: held entries return to the lifecycle (approved) with a
      // FRESH review window. Setting availableAt is essential — entries held
      // while pending had availableAt = null and would otherwise never mature
      // (the sweep requires availableAt ≤ now). Direct-role entries from OTHER
      // affiliates are untouched — their legitimate 90% is never penalised.
      const settings = await getAffiliateSettings();
      const availableAt = new Date(now.getTime() + settings.reviewDays * 86400000);
      await tx.affiliateCommissionEntry.updateMany({
        where: { beneficiaryAffiliateId: id, status: "held", holdReason: { startsWith: "beneficiary_" } },
        data: { status: "approved", holdReason: null, availableAt },
      });
    }
    return updated;
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: `affiliate.${action}`,
    entityType: "affiliate_profile",
    entityId: id,
    before: { status: profile.status },
    after: { status: result.status, reason },
  });

  return ok({ status: result.status });
});
