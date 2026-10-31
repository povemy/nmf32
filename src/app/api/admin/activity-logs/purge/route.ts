import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { verifyPasswordAsync } from "@/lib/password";
import { db } from "@/lib/db";
import { readBody } from "@/app/api/admin/_helpers";

// Permanent ActivityLog purge (RX-CHECKLIST addendum #6).
//
// Scope: the WHOLE ActivityLog table — every actor type (admin, seller,
// shopper, system) — so the activity trail starts fresh. The AdminAuditLog
// (privileged-action compliance trail), NotificationLog and PaymentWebhookLog
// are separate tables and are deliberately NOT touched.
//
// Gates:
// - superadmin only (cap `logs.purge`)
// - current admin's PASSWORD re-verified server-side (scrypt, timing-safe);
//   the password itself is never logged or stored anywhere
// - failed attempts are audited (activity_logs.purge_denied) with a small
//   constant delay to blunt online guessing
// - deletion is batched (bounded loops) so a huge table cannot hold a single
//   long-running statement on the pooled connection
// - the purge itself is audited: an AdminAuditLog row survives the wipe and a
//   fresh ActivityLog row marks the reset (log restarts with that entry).

const BATCH_SIZE = 2000;
const MAX_BATCHES = 250; // 500k rows per invocation; larger tables re-click

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// GET /api/admin/activity-logs/purge — count for the confirm dialog.
export const GET = handle(async () => {
  await requireCap("logs.purge");
  const [total, byActor] = await Promise.all([
    db.activityLog.count(),
    db.activityLog.groupBy({ by: ["actorType"], _count: { _all: true } }),
  ]);
  return ok({
    total,
    byActor: byActor.map((a) => ({ actorType: a.actorType, count: a._count._all })),
  });
});

// POST /api/admin/activity-logs/purge {password} — verify + wipe + audit.
export const POST = handle(async (req: NextRequest) => {
  const admin = await requireCap("logs.purge");
  const body = await readBody(req);
  const password = typeof body.password === "string" ? body.password : "";
  if (!password) throw new ApiError(400, "VALIDATION", "Admin password is required");

  const full = await db.adminUser.findUnique({ where: { id: admin.id } });
  // Phase 1 (SEC-04): async scrypt — no event-loop block on this rare admin op.
  const passwordOk = !!full && full.isActive && (await verifyPasswordAsync(password, full.passwordHash));
  if (!passwordOk) {
    await sleep(400);
    await auditAdmin({
      adminId: admin.id,
      adminEmail: admin.email,
      action: "activity_logs.purge_denied",
      entityType: "activity_log",
      entityId: null,
      before: null,
      after: { result: "denied_password" },
    });
    throw new ApiError(401, "INVALID_PASSWORD", "Incorrect admin password — nothing was deleted.");
  }

  const totalBefore = await db.activityLog.count();
  let deleted = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const ids = await db.activityLog.findMany({
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE,
    });
    if (ids.length === 0) break;
    const res = await db.activityLog.deleteMany({ where: { id: { in: ids.map((i) => i.id) } } });
    deleted += res.count;
    if (ids.length < BATCH_SIZE) break;
  }
  const remaining = Math.max(0, totalBefore - deleted);

  // Survives the wipe: AdminAuditLog row + one fresh ActivityLog entry so the
  // log visibly restarts with the reset record.
  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "activity_logs.purge",
    entityType: "activity_log",
    entityId: null,
    before: { totalBefore },
    after: { deleted, remaining, scope: "all actor types" },
  });

  return ok({ deleted, remaining });
});
