import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap, revokeUserSessions } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, stripSeller } from "@/app/api/admin/_helpers";
import { planAdminStorePath, transitionStoreToward, TransitionError } from "@/lib/store-lifecycle";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/sellers/[id]/terminate {reason?} (RBAC sellers.suspend)
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("sellers.suspend");
  const { id } = await ctx.params;
  const body = await readBody(req).catch(() => ({}) as Record<string, never>);
  const reason = typeof body.reason === "string" ? body.reason : "Contract termination";

  const seller = await db.seller.findUnique({ where: { id }, include: { store: true } });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");
  if (seller.status === "terminated") throw new ApiError(409, "CONFLICT", "Seller already terminated");

  // C1.3 (seller publication governance): route the store takedown through the
  // guarded state machine (transitionStore) instead of a raw db.store.update.
  // "draft" is legal from live/claimed/suspended (maintenance passes through
  // suspended); a pre-claim or archived store cannot legally reach "draft" —
  // 409 BEFORE the seller row is mutated so the action fails without partial state.
  if (seller.store && !planAdminStorePath(seller.store.status, "draft")) {
    throw new ApiError(409, "CONFLICT", `Store in status "${seller.store.status}" cannot be taken down to draft — it must complete its own lifecycle first`);
  }

  const updated = await db.seller.update({ where: { id }, data: { status: "terminated" } });
  if (seller.store) {
    try {
      await transitionStoreToward({ storeId: seller.store.id, to: "draft", actorId: admin.id, note: `seller terminated: ${reason}` });
    } catch (err) {
      // illegal/concurrent transition ⇒ conflict; anything else is a real error
      if (err instanceof TransitionError) throw new ApiError(409, "CONFLICT", err.message);
      throw err;
    }
  }
  // F-02 remediation: termination revokes every live session immediately.
  const sessionsRevoked = await revokeUserSessions("seller", id);

  await notify({
    event: "seller.terminated",
    channel: "email",
    recipient: seller.email,
    subject: "Your seller account has been terminated",
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "seller.terminate",
    entityType: "seller",
    entityId: id,
    before: { status: seller.status, storeStatus: seller.store?.status ?? null },
    after: { status: "terminated", storeStatus: seller.store ? "draft" : null, reason, sessionsRevoked },
  });

  return ok({ ...stripSeller(updated), sessionsRevoked });
});
