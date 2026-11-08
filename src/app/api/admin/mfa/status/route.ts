import { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api";
import { requireAdminUngated } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { getMfaEnrollment } from "@/lib/mfa";
import type { AdminMfaStatus } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/admin/mfa/status — the signed-in admin's OWN enrollment state
// (C4). P2021/P2022-guarded inside getMfaEnrollment: before migration
// 20261101000002 is applied the answer is { enrolled: false, confirmed: false }
// so the console stays usable in dev, while migrated production gets full
// enforcement. No secrets ever leave this route.
export const GET = handle(async (req: NextRequest) => {
  rateLimit(req, "admin-mfa", 10);
  const admin = await requireAdminUngated();
  const enrollment = await getMfaEnrollment(admin.id);
  const payload: AdminMfaStatus = { enrolled: enrollment != null, confirmed: enrollment?.confirmedAt != null };
  return ok(payload);
});
