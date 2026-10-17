import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin, requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { PSP_SPLIT_CANDIDATES, PSP_SPLIT_SETTING_KEYS } from "@/lib/psp";
import { readBody } from "@/app/api/admin/_helpers";

// GET /api/admin/commission/psp-settings — dormant split-settlement scaffold state.
export const GET = handle(async () => {
  await requireAdmin();
  const [autoSettleRow, providerRow] = await Promise.all([
    db.setting.findUnique({ where: { key: PSP_SPLIT_SETTING_KEYS.autoSettle } }),
    db.setting.findUnique({ where: { key: PSP_SPLIT_SETTING_KEYS.provider } }),
  ]);
  return ok({
    autoSettle: autoSettleRow ? JSON.parse(autoSettleRow.valueJson) === true : false,
    provider: providerRow ? JSON.parse(providerRow.valueJson) : "mock",
    candidates: PSP_SPLIT_CANDIDATES,
  });
});

// PUT /api/admin/commission/psp-settings {autoSettle?, provider?} — writes the
// Settings keys only. NO functional behaviour is wired: auto_settle stays a
// documented scaffold until a production PSP adapter exists (Option B).
export const PUT = handle(async (req: NextRequest) => {
  const admin = await requireCap("commission.manage");
  const body = await readBody(req);

  const before = {
    autoSettle: (await db.setting.findUnique({ where: { key: PSP_SPLIT_SETTING_KEYS.autoSettle } }))?.valueJson ?? null,
    provider: (await db.setting.findUnique({ where: { key: PSP_SPLIT_SETTING_KEYS.provider } }))?.valueJson ?? null,
  };

  const after: Record<string, string> = {};
  if (typeof body.autoSettle === "boolean") {
    if (body.autoSettle === true) {
      throw new ApiError(
        409,
        "PSP_ADAPTER_REQUIRED",
        "Auto-settle cannot be enabled: no production PSP adapter is implemented yet (mock is sandbox-only). This scaffold toggles documentation state only."
      );
    }
    await db.setting.upsert({
      where: { key: PSP_SPLIT_SETTING_KEYS.autoSettle },
      create: { key: PSP_SPLIT_SETTING_KEYS.autoSettle, valueJson: "false" },
      update: { valueJson: "false" },
    });
    after.autoSettle = "false";
  }
  if (typeof body.provider === "string") {
    const candidate = PSP_SPLIT_CANDIDATES.find((c) => c.id === body.provider);
    if (!candidate) throw new ApiError(400, "VALIDATION", "Unknown PSP provider id");
    if (candidate.awaitingAdapter) {
      throw new ApiError(409, "PSP_ADAPTER_REQUIRED", `Provider ${candidate.id} has no adapter implemented yet — only the sandbox mock can be recorded`);
    }
    await db.setting.upsert({
      where: { key: PSP_SPLIT_SETTING_KEYS.provider },
      create: { key: PSP_SPLIT_SETTING_KEYS.provider, valueJson: JSON.stringify(candidate.id) },
      update: { valueJson: JSON.stringify(candidate.id) },
    });
    after.provider = JSON.stringify(candidate.id);
  }

  if (Object.keys(after).length === 0) throw new ApiError(400, "VALIDATION", "Nothing to update");

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "commission.psp_settings.update",
    entityType: "psp_split_settings",
    entityId: "scaffold",
    before,
    after,
  });

  return ok({ updated: after });
});
