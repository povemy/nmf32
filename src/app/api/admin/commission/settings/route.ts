import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireCap, requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCommissionSettings } from "@/lib/commission";
import { readBody, optNum, optBool } from "@/app/api/admin/_helpers";

// GET /api/admin/commission/settings
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const settings = await getCommissionSettings();
  return ok(settings);
});

// PUT /api/admin/commission/settings (RBAC commission.manage)
export const PUT = handle(async (req: NextRequest) => {
  const admin = await requireCap("commission.manage");
  const body = await readBody(req);

  const before = await getCommissionSettings();

  const data: Record<string, unknown> = {};
  const defaultPercent = optNum(body, "defaultPercent");
  if (defaultPercent != null) {
    if (defaultPercent < 0 || defaultPercent > 100) throw new ApiError(400, "VALIDATION", "defaultPercent must be 0..100");
    data.defaultPercent = defaultPercent;
  }
  const payoutHoldDays = optNum(body, "payoutHoldDays");
  if (payoutHoldDays != null) {
    if (payoutHoldDays < 0 || payoutHoldDays > 60) throw new ApiError(400, "VALIDATION", "payoutHoldDays must be 0..60");
    data.payoutHoldDays = Math.round(payoutHoldDays);
  }
  const appliesToShipping = optBool(body, "appliesToShipping");
  if (appliesToShipping != null) data.appliesToShipping = appliesToShipping;
  const basePriceRule = typeof body.basePriceRule === "string" ? body.basePriceRule : undefined;
  if (basePriceRule != null) {
    if (!["paid_price", "list_price"].includes(basePriceRule)) throw new ApiError(400, "VALIDATION", "basePriceRule must be paid_price | list_price");
    data.basePriceRule = basePriceRule;
  }
  const fixedFeeMinor = optNum(body, "fixedFeeMinor");
  if (fixedFeeMinor != null) {
    if (fixedFeeMinor < 0) throw new ApiError(400, "VALIDATION", "fixedFeeMinor must be >= 0");
    data.fixedFeeMinor = Math.round(fixedFeeMinor);
  }
  const minCommissionMinor = optNum(body, "minCommissionMinor");
  if (minCommissionMinor != null) {
    if (minCommissionMinor < 0) throw new ApiError(400, "VALIDATION", "minCommissionMinor must be >= 0");
    data.minCommissionMinor = Math.round(minCommissionMinor);
  }
  const holdReleaseRule = typeof body.holdReleaseRule === "string" ? body.holdReleaseRule : undefined;
  if (holdReleaseRule != null) {
    if (!["days_after_paid", "days_after_delivered"].includes(holdReleaseRule)) {
      throw new ApiError(400, "VALIDATION", "holdReleaseRule must be days_after_paid | days_after_delivered");
    }
    data.holdReleaseRule = holdReleaseRule;
  }
  const graceDaysAfterDelivered = optNum(body, "graceDaysAfterDelivered");
  if (graceDaysAfterDelivered != null) {
    if (graceDaysAfterDelivered < 0 || graceDaysAfterDelivered > 60) throw new ApiError(400, "VALIDATION", "graceDaysAfterDelivered must be 0..60");
    data.graceDaysAfterDelivered = Math.round(graceDaysAfterDelivered);
  }

  if (Object.keys(data).length === 0) throw new ApiError(400, "VALIDATION", "Nothing to update");

  const after = await db.commissionSetting.upsert({
    where: { id: 1 },
    create: { id: 1, ...data },
    update: data,
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "commission.settings.update",
    entityType: "commission_settings",
    entityId: "1",
    before,
    after: data,
  });

  return ok(after);
});
