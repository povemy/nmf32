import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap, revokeUserSessions } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, stripSeller } from "@/app/api/admin/_helpers";
import { planAdminStorePath, transitionStoreToward, TransitionError } from "@/lib/store-lifecycle";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/sellers/[id]/suspend {reason?} (RBAC sellers.suspend)
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("sellers.suspend");
  const { id } = await ctx.params;
  const body = await readBody(req).catch(() => ({}) as Record<string, never>);
  const reason = typeof body.reason === "string" ? body.reason : "Policy review";

  const seller = await db.seller.findUnique({ where: { id }, include: { store: true } });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");
  if (seller.status !== "active") throw new ApiError(409, "CONFLICT", `Only active sellers can be suspended (current: ${seller.status})`);

  // C1.3 (seller publication governance): route the store takedown through the
  // guarded state machine (transitionStore) instead of a raw db.store.update.
  // "draft" is legal from live/claimed/suspended (maintenance passes through
  // suspended); a pre-claim or archived store cannot legally reach "draft" —
  // 409 BEFORE the seller row is mutated so the action fails without partial state.
  if (seller.store && !planAdminStorePath(seller.store.status, "draft")) {
    throw new ApiError(409, "CONFLICT", `Store in status "${seller.store.status}" cannot be taken down to draft — it must complete its own lifecycle first`);
  }

  const updated = await db.seller.update({ where: { id }, data: { status: "suspended" } });
  if (seller.store) {
    try {
      await transitionStoreToward({ storeId: seller.store.id, to: "draft", actorId: admin.id, note: `seller suspended: ${reason}` });
    } catch (err) {
      // illegal/concurrent transition ⇒ conflict; anything else is a real error
      if (err instanceof TransitionError) throw new ApiError(409, "CONFLICT", err.message);
      throw err;
    }
  }
  // F-02 remediation: suspension takes effect IMMEDIATELY — every live seller
  // session is revoked so the suspended seller's next request 401s, and the
  // login gate (F-24) refuses to mint a new one.
  const sessionsRevoked = await revokeUserSessions("seller", id);

  await notify({
    event: "seller.suspended",
    channel: "email",
    recipient: seller.email,
    subject: "Your store has been suspended",
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "seller.suspend",
    entityType: "seller",
    entityId: id,
    before: { status: seller.status, storeStatus: seller.store?.status ?? null },
    after: { status: "suspended", storeStatus: seller.store ? "draft" : null, reason, sessionsRevoked },
  });

  return ok({ ...stripSeller(updated), sessionsRevoked });
});
