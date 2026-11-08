import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify, logActivity } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { stripSeller } from "@/app/api/admin/_helpers";
import { planAdminStorePath, transitionStoreToward, TransitionError } from "@/lib/store-lifecycle";
import type { AdminSellerFullRow } from "@/lib/types/api-contract";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/sellers/[id]/approve — activate seller + store (RBAC sellers.approve)
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("sellers.approve");
  const { id } = await ctx.params;

  const seller = await db.seller.findUnique({ where: { id }, include: { store: true } });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");
  if (seller.status === "terminated") throw new ApiError(409, "CONFLICT", "Terminated seller cannot be approved");

  // C1.3 (seller publication governance): the store status change goes through
  // the guarded state machine (transitionStore) instead of a raw db.store.update,
  // so admin approval can no longer bypass the machine's validity rules.
  // "live" is only legal from draft/maintenance (claimed/suspended pass through
  // draft first); a pre-claim or archived store cannot legally reach "live" —
  // 409 BEFORE the seller row is mutated so the action fails without partial state.
  if (seller.store && !planAdminStorePath(seller.store.status, "live")) {
    throw new ApiError(409, "CONFLICT", `Store in status "${seller.store.status}" cannot go live — it must complete its own lifecycle (claim/configuration) first`);
  }

  const updated = await db.seller.update({
    where: { id },
    data: { status: "active", kycStatus: "approved", approvedAt: new Date(), rejectReason: null },
  });
  if (seller.store) {
    try {
      await transitionStoreToward({ storeId: seller.store.id, to: "live", actorId: admin.id, note: "seller approved" });
    } catch (err) {
      // illegal/concurrent transition ⇒ conflict; anything else is a real error
      if (err instanceof TransitionError) throw new ApiError(409, "CONFLICT", err.message);
      throw err;
    }
  }

  await notify({
    event: "kyc.approved",
    channel: "email",
    recipient: seller.email,
    subject: "You're approved — your store is live!",
  });
  await logActivity({
    actorType: "system",
    action: "seller.approved",
    entityType: "seller",
    entityId: id,
    meta: { sellerEmail: seller.email, storeName: seller.store?.name ?? null },
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "seller.approve",
    entityType: "seller",
    entityId: id,
    before: { status: seller.status, kycStatus: seller.kycStatus, storeStatus: seller.store?.status ?? null },
    after: { status: "active", kycStatus: "approved", storeStatus: seller.store ? "live" : null },
  });

  const payload: AdminSellerFullRow = {
    ...stripSeller(updated),
    submittedAt: updated.submittedAt ? updated.submittedAt.toISOString() : null,
    approvedAt: updated.approvedAt ? updated.approvedAt.toISOString() : null,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
    emailVerifiedAt: updated.emailVerifiedAt ? updated.emailVerifiedAt.toISOString() : null,
  };
  return ok(payload);
});
