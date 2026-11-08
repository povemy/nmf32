import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { postAdminAdjustment, refreshWalletCache, walletTruth } from "@/lib/ledger";
import { readBody, reqNum, reqStr, type Body } from "@/app/api/admin/_helpers";
import type { AdminWalletAdjustBody, AdminWalletAdjustData, AdminWalletRow } from "@/lib/types/api-contract";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/wallets/[id]/adjust {amountMinor, direction: credit|debit, reason} — T6 (RBAC payouts.manage)
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("payouts.manage");
  const { id } = await ctx.params;
  const body = (await readBody(req)) as Body & AdminWalletAdjustBody;

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
    direction: direction as AdminWalletAdjustBody["direction"],
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

  const walletPayload: AdminWalletRow | null = fresh
    ? { ...fresh, createdAt: fresh.createdAt.toISOString(), updatedAt: fresh.updatedAt.toISOString() }
    : null;
  // Contract types `wallet` as AdminWalletRow (non-null); findUnique can return
  // null in theory — cast at the serialization boundary keeps behavior identical.
  const payload = { wallet: walletPayload, txnId: txn.id, before, after } as AdminWalletAdjustData;
  return ok(payload);
});
