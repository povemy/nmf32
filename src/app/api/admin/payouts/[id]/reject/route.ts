import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { refreshWalletCache } from "@/lib/ledger";
import { readBody, reqStr } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/payouts/[id]/reject {reason} — seller payout request → rejected.
// No ledger movement: a request never moved money (T3 posts at approve time),
// so rejection simply releases the request and the balance stays available.
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("payouts.manage");
  const { id } = await ctx.params;
  const body = await readBody(req);
  const reason = reqStr(body, "reason", "reason");

  const payout = await db.payout.findUnique({ where: { id } });
  if (!payout) throw new ApiError(404, "NOT_FOUND", "Payout not found");
  if (payout.status !== "requested") {
    throw new ApiError(409, "CONFLICT", `Payout is ${payout.status}, only requested payouts can be rejected`);
  }

  const seller = await db.seller.findUnique({ where: { id: payout.sellerId } });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");

  // Keep ledger truth fresh so the wallet page immediately shows the released balance.
  await refreshWalletCache(payout.walletId);

  const updated = await db.payout.update({
    where: { id },
    data: { status: "rejected", failReason: reason },
  });

  await notify({
    event: "payout.rejected",
    channel: "email",
    recipient: seller.email,
    subject: `Payout request ${payout.referenceNo} not approved`,
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "payout.request.reject",
    entityType: "payout",
    entityId: id,
    before: { status: payout.status, amountMinor: payout.amountMinor },
    after: { status: "rejected", reason },
  });

  return ok(updated);
});
