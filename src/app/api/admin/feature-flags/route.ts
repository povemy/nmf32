import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin, requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, reqStr, optNum, optBool } from "@/app/api/admin/_helpers";
import type { AdminFeatureFlagRow, FeatureFlagPatchBody, FeatureFlagPatchData } from "@/lib/types/api-contract";

// GET /api/admin/feature-flags
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const rows = await db.featureFlag.findMany({ orderBy: { key: "asc" } });
  const data: AdminFeatureFlagRow[] = rows.map((r) => ({
    key: r.key,
    description: r.description,
    isEnabled: r.isEnabled,
    rolloutPercent: r.rolloutPercent,
  }));
  return ok(data);
});

// PATCH /api/admin/feature-flags {key, isEnabled?, rolloutPercent?, description?} (RBAC settings.manage)
export const PATCH = handle(async (req: NextRequest) => {
  const admin = await requireCap("settings.manage");
  const body = (await readBody(req)) as FeatureFlagPatchBody & Record<string, unknown>;
  const key = reqStr(body, "key", "key");

  const existing = await db.featureFlag.findUnique({ where: { key } });

  const data: Omit<FeatureFlagPatchBody, "key"> = {};
  const isEnabled = optBool(body, "isEnabled");
  if (isEnabled != null) data.isEnabled = isEnabled;
  const rolloutPercent = optNum(body, "rolloutPercent");
  if (rolloutPercent != null) {
    if (rolloutPercent < 0 || rolloutPercent > 100) throw new ApiError(400, "VALIDATION", "rolloutPercent must be 0..100");
    data.rolloutPercent = Math.round(rolloutPercent);
  }
  if (typeof body.description === "string") data.description = body.description;

  const flag = await db.featureFlag.upsert({
    where: { key },
    create: { key, isEnabled: data.isEnabled ?? false, rolloutPercent: data.rolloutPercent ?? 100, description: data.description ?? null },
    update: data,
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "feature_flag.update",
    entityType: "feature_flag",
    entityId: key,
    before: existing ? { isEnabled: existing.isEnabled, rolloutPercent: existing.rolloutPercent } : null,
    after: data,
  });

  const payload: FeatureFlagPatchData = {
    key: flag.key,
    description: flag.description,
    isEnabled: flag.isEnabled,
    rolloutPercent: flag.rolloutPercent,
  };
  return ok(payload);
});
