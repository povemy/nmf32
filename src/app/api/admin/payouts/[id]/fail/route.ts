import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, notify } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { postPayoutFailed } from "@/lib/ledger";
import { readBody, reqStr } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/payouts/[id]/fail {reason} — T4f reversal (RBAC payouts.manage)
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("payouts.manage");
  const { id } = await ctx.params;
  const body = await readBody(req);
  const reason = reqStr(body, "reason", "reason");

  const payout = await db.payout.findUnique({ where: { id } });
  if (!payout) throw new ApiError(404, "NOT_FOUND", "Payout not found");
  if (payout.status !== "processing") throw new ApiError(409, "CONFLICT", `Payout is ${payout.status}, only processing payouts can fail`);

  const seller = await db.seller.findUnique({ where: { id: payout.sellerId } });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");

  const txn = await postPayoutFailed({
    walletId: payout.walletId,
    payoutId: payout.id,
    referenceNo: payout.referenceNo,
    amountMinor: payout.amountMinor,
    reason,
  });

  const updated = await db.payout.update({
    where: { id },
    data: { status: "failed", failReason: reason },
  });

  await notify({
    event: "payout.failed",
    channel: "email",
    recipient: "ops@shopmesh.io",
    subject: `Payout ${payout.referenceNo} failed`,
  });
  await notify({
    event: "payout.failed",
    channel: "email",
    recipient: seller.email,
    subject: `Payout ${payout.referenceNo} failed`,
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "payout.fail",
    entityType: "payout",
    entityId: id,
    before: { status: payout.status, referenceNo: payout.referenceNo, amountMinor: payout.amountMinor },
    after: { status: "failed", reason, txnId: txn.id },
  });

  return ok(updated);
});
