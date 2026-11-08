import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap, revokeUserSessions } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, reqStr, stripSeller } from "@/app/api/admin/_helpers";
import { planAdminStorePath, transitionStoreToward, TransitionError } from "@/lib/store-lifecycle";
import type { AdminSellerRejectBody, AdminSellerRejectData } from "@/lib/types/api-contract";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/sellers/[id]/reject {reason}
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("sellers.approve");
  const { id } = await ctx.params;
  const body = (await readBody(req)) as AdminSellerRejectBody & Record<string, unknown>;
  const reason = reqStr(body, "reason", "reason");

  const seller = await db.seller.findUnique({ where: { id }, include: { store: true } });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");
  if (seller.status === "active") throw new ApiError(409, "CONFLICT", "Active seller cannot be rejected — suspend or terminate instead");

  // C1.3 (seller publication governance): route the store takedown through the
  // guarded state machine (transitionStore) instead of a raw db.store.update.
  // "draft" is legal from live/claimed/suspended (maintenance passes through
  // suspended); a pre-claim or archived store cannot legally reach "draft" —
  // 409 BEFORE the seller row is mutated so the action fails without partial state.
  if (seller.store && !planAdminStorePath(seller.store.status, "draft")) {
    throw new ApiError(409, "CONFLICT", `Store in status "${seller.store.status}" cannot be taken down to draft — it must complete its own lifecycle first`);
  }

  // V-F3 (stage-gate verification): SAFE ORDERING — the store takedown runs
  // BEFORE the seller row is mutated (same rationale as suspend: a CAS-losing
  // transition must leave the seller UNTOUCHED, not a rejected seller with a
  // still-live store). The mirrored partial state (store drafted, seller not
  // yet rejected) is safe and re-runnable (planAdminStorePath(draft→draft) = []).
  if (seller.store) {
    try {
      await transitionStoreToward({ storeId: seller.store.id, to: "draft", actorId: admin.id, note: `seller rejected: ${reason}` });
    } catch (err) {
      // illegal/concurrent transition ⇒ conflict; anything else is a real error
      if (err instanceof TransitionError) throw new ApiError(409, "CONFLICT", err.message);
      throw err;
    }
  }
  const updated = await db.seller.update({
    where: { id },
    data: { status: "rejected", kycStatus: "rejected", rejectReason: reason },
  });
  // F-02 remediation: rejection revokes live sessions too — the seller must
  // re-authenticate after being told their application was rejected (fresh
  // login remains allowed for the documented revision loop; only the STALE
  // pre-rejection sessions die). Draft-store access continues deliberately so
  // the revision loop (store edits → resubmit) keeps working.
  const sessionsRevoked = await revokeUserSessions("seller", id);

  await notify({
    event: "kyc.rejected",
    channel: "email",
    recipient: seller.email,
    subject: "KYC verification rejected",
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "seller.reject",
    entityType: "seller",
    entityId: id,
    before: { status: seller.status, kycStatus: seller.kycStatus },
    after: { status: "rejected", kycStatus: "rejected", reason, sessionsRevoked },
  });

  const payload: AdminSellerRejectData = {
    ...stripSeller(updated),
    submittedAt: updated.submittedAt ? updated.submittedAt.toISOString() : null,
    approvedAt: updated.approvedAt ? updated.approvedAt.toISOString() : null,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
    emailVerifiedAt: updated.emailVerifiedAt ? updated.emailVerifiedAt.toISOString() : null,
    sessionsRevoked,
  };
  return ok(payload);
});
