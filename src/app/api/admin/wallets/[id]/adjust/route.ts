import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { postAdminAdjustment, refreshWalletCache, walletTruth } from "@/lib/ledger";
import { readBody, reqNum, reqStr } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/wallets/[id]/adjust {amountMinor, direction: credit|debit, reason} — T6 (RBAC payouts.manage)
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("payouts.manage");
  const { id } = await ctx.params;
  const body = await readBody(req);

  const amountMinor = reqNum(body, "amountMinor", "amountMinor");
  if (amountMinor <= 0) throw new ApiError(400, "VALIDATION", "amountMinor must be > 0");
  const direction = reqStr(body, "direction", "direction");
  if (!["credit", "debit"].includes(direction)) throw new ApiError(400, "VALIDATION", "direction must be credit | debit");
  const reason = reqStr(body, "reason", "reason");

  const wallet = await db.wallet.findUnique({ where: { id }, include: { seller: true } });
  if (!wallet) throw new ApiError(404, "NOT_FOUND", "Wallet not found");

  const before = await walletTruth(id);

  const txn = await postAdminAdjustment({
    walletId: id,
    direction: direction as "credit" | "debit",
    amountMinor,
    reason,
    adminEmail: admin.email,
  });

  const after = await refreshWalletCache(id);
  const fresh = await db.wallet.findUnique({ where: { id } });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "wallet.adjust",
    entityType: "wallet",
    entityId: id,
    before: { pendingMinor: before.pendingMinor, availableMinor: before.availableMinor, sellerEmail: wallet.seller.email },
    after: { pendingMinor: after.pendingMinor, availableMinor: after.availableMinor, direction, amountMinor, reason, txnId: txn.id },
  });

  return ok({ wallet: fresh, txnId: txn.id, before, after });
});
