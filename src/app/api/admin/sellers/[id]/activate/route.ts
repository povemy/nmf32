import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { stripSeller } from "@/app/api/admin/_helpers";
import { planAdminStorePath, transitionStoreToward, TransitionError } from "@/lib/store-lifecycle";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/sellers/[id]/activate (RBAC sellers.suspend)
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("sellers.suspend");
  const { id } = await ctx.params;

  const seller = await db.seller.findUnique({ where: { id }, include: { store: true } });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");
  if (seller.status === "terminated" || seller.status === "rejected") {
    throw new ApiError(409, "CONFLICT", `Cannot activate a ${seller.status} seller`);
  }

  // C1.3 (seller publication governance): route the store status change through
  // the guarded state machine (transitionStore) instead of a raw db.store.update —
  // same legal-path rules as approve: "live" only from draft/maintenance
  // (claimed/suspended pass through draft); pre-claim/archived 409s BEFORE the
  // seller row is mutated so the action fails without partial state.
  if (seller.store && !planAdminStorePath(seller.store.status, "live")) {
    throw new ApiError(409, "CONFLICT", `Store in status "${seller.store.status}" cannot go live — it must complete its own lifecycle (claim/configuration) first`);
  }

  const updated = await db.seller.update({ where: { id }, data: { status: "active" } });
  if (seller.store) {
    try {
      await transitionStoreToward({ storeId: seller.store.id, to: "live", actorId: admin.id, note: "seller activated" });
    } catch (err) {
      // illegal/concurrent transition ⇒ conflict; anything else is a real error
      if (err instanceof TransitionError) throw new ApiError(409, "CONFLICT", err.message);
      throw err;
    }
  }

  await notify({
    event: "seller.activated",
    channel: "email",
    recipient: seller.email,
    subject: "Your store is back online",
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "seller.activate",
    entityType: "seller",
    entityId: id,
    before: { status: seller.status, storeStatus: seller.store?.status ?? null },
    after: { status: "active", storeStatus: seller.store ? "live" : null },
  });

  return ok(stripSeller(updated));
});
