import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { postPayoutConfirmed } from "@/lib/ledger";
import { readBody, reqStr } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/payouts/[id]/mark-paid {referenceNo} — T4 (RBAC payouts.manage)
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("payouts.manage");
  const { id } = await ctx.params;
  const body = await readBody(req);
  const referenceNo = reqStr(body, "referenceNo", "referenceNo (bank transfer reference)");

  const payout = await db.payout.findUnique({ where: { id } });
  if (!payout) throw new ApiError(404, "NOT_FOUND", "Payout not found");
  if (payout.status !== "processing") throw new ApiError(409, "CONFLICT", `Payout is ${payout.status}, only processing payouts can be marked paid`);

  const seller = await db.seller.findUnique({ where: { id: payout.sellerId } });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");

  const txn = await postPayoutConfirmed({
    walletId: payout.walletId,
    payoutId: payout.id,
    referenceNo: payout.referenceNo,
    amountMinor: payout.amountMinor,
  });

  const updated = await db.payout.update({
    where: { id },
    data: { status: "paid", paidAt: new Date(), providerRef: referenceNo },
  });

  await notify({
    event: "payout.paid",
    channel: "email",
    recipient: seller.email,
    subject: `Payout ${payout.referenceNo} on the way`,
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "payout.mark_paid",
    entityType: "payout",
    entityId: id,
    before: { status: payout.status, referenceNo: payout.referenceNo, amountMinor: payout.amountMinor },
    after: { status: "paid", providerRef: referenceNo, txnId: txn.id },
  });

  return ok(updated);
});
