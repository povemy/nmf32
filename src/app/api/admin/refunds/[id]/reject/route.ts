import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/refunds/[id]/reject {reason?} (RBAC refunds.manage)
//
// C3 (Phase 2.2) — REJECTION CONCURRENCY: this route previously performed an
// UNCONDITIONAL `db.refund.update({ status: "rejected" })` after a stale read.
// TOCTOU: if /process committed `status: "processed"` (money moved, T5
// posted, wallet debited) between this route's read and write, the rejection
// OVERWROTE processed → rejected — the audit trail then claimed "rejected"
// for money that actually moved, and a re-process attempt was blocked
// ("Rejected refund cannot be processed").
//
// Now the rejection is a CONDITIONAL claim mirroring the approve route's
// FIN-2a pattern: only a `requested` or `approved` refund can be rejected;
// a concurrent process/approve wins the row and this call fails with 409
// instead of overwriting a terminal state. The process route's Order FOR
// UPDATE + conditional refund claim safeguards are preserved unchanged.
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("refunds.manage");
  const { id } = await ctx.params;
  const body = await readBody(req).catch(() => ({}) as Record<string, never>);
  const reason = typeof body.reason === "string" ? body.reason : "Refund request declined";

  const refund = await db.refund.findUnique({ where: { id }, include: { order: { include: { store: { include: { seller: true } } } } } });
  if (!refund) throw new ApiError(404, "NOT_FOUND", "Refund not found");

  // Conditional claim — a refund that has already been processed (or is
  // being processed under the FOR UPDATE lock) can never be overwritten by a
  // rejection. Only requested/approved rows are rejectable.
  const claim = await db.refund.updateMany({
    where: { id, status: { in: ["requested", "approved"] } },
    data: { status: "rejected" },
  });
  if (claim.count === 0) {
    throw new ApiError(409, "CONFLICT", `Refund cannot be rejected from its current state (${refund.status})`);
  }
  const updated = await db.refund.findUniqueOrThrow({ where: { id } });

  if (refund.order.store.seller?.email) {
    await notify({
      event: "refund.rejected",
      channel: "email",
      recipient: refund.order.store.seller.email,
      subject: `Refund rejected for order ${refund.order.orderNumber}`,
    });
  }

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "refund.reject",
    entityType: "refund",
    entityId: id,
    before: { status: refund.status, amountMinor: refund.amountMinor },
    after: { status: "rejected", reason },
  });

  return ok(updated);
});
