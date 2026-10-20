import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/refunds/[id]/approve (RBAC refunds.manage)
//
// FIN-3a: approve stays a STATUS FLIP ONLY — no money moves here. The ledger
// T5 posts at /process, which re-validates the cumulative refund cap and the
// seller wallet balance against ledger truth before posting.
//
// Transition guard (requested → approved): the old unconditional update is
// replaced by a conditional claim (FIN-2a atomic-claim pattern). Two admins
// clicking approve concurrently both pass the readable check below, but
// updateMany is atomic at row level — the loser re-evaluates the WHERE clause
// against the winner's committed write, matches 0 rows and is rejected with
// 409 instead of silently re-approving.
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("refunds.manage");
  const { id } = await ctx.params;

  const refund = await db.refund.findUnique({ where: { id }, include: { order: { include: { store: { include: { seller: true } } } } } });
  if (!refund) throw new ApiError(404, "NOT_FOUND", "Refund not found");
  // Readable fast-fail (stale read) — the conditional claim below is the real guard.
  if (refund.status !== "requested") throw new ApiError(409, "CONFLICT", `Refund is ${refund.status}, only requested refunds can be approved`);

  const claim = await db.refund.updateMany({
    where: { id, status: "requested" },
    data: { status: "approved" },
  });
  if (claim.count === 0) {
    throw new ApiError(409, "CONFLICT", "Refund is no longer in requested state (concurrent update)");
  }

  // Re-fetch the claimed row so the response shape (ok(updated refund)) is
  // preserved for the admin refunds UI.
  const updated = await db.refund.findUnique({ where: { id } });

  await notify({
    event: "refund.approved",
    channel: "email",
    recipient: refund.order.customerEmail,
    subject: `Refund approved for order ${refund.order.orderNumber}`,
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "refund.approve",
    entityType: "refund",
    entityId: id,
    before: { status: refund.status, amountMinor: refund.amountMinor, orderNumber: refund.order.orderNumber },
    after: { status: "approved" },
  });

  return ok(updated);
});
