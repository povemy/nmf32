import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { ACCOUNTS } from "@/lib/ledger";
import type { SellerWalletActivityData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/store/wallet/activity/[id] — one ledger activity (a journal line)
// with full transaction context: both double-entry legs + the related business
// object (order / payout / settlement / adjustment) so the seller can jump to
// the originating order, refund or payout.
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { me, store } = await requireActiveSellerStore();
  const { id } = await ctx.params;

  const wallet = await db.wallet.findUnique({ where: { sellerId: me.id } });
  if (!wallet) throw new ApiError(404, "NOT_FOUND", "Wallet not found");

  const line = await db.ledgerLine.findUnique({
    where: { id },
    include: { txn: { include: { lines: true } } },
  });
  if (!line) throw new ApiError(404, "NOT_FOUND", "Ledger activity not found");

  // Ownership check — the transaction must touch this seller's wallet.
  const touchesMyWallet = line.txn.lines.some((l) => l.walletId === wallet.id);
  if (!touchesMyWallet) throw new ApiError(403, "FORBIDDEN", "This activity does not belong to your wallet");

  const payableCode = ACCOUNTS.sellerPayable(wallet.id);
  const myLines = line.txn.lines.filter((l) => l.accountCode === payableCode);
  const walletAmountMinor = myLines.reduce(
    (s, l) => s + (l.direction === "credit" ? l.amountMinor : -l.amountMinor),
    0
  );

  // Resolve the related business object so the UI can deep-link to it.
  let related: SellerWalletActivityData["related"] = null;
  if (line.txn.refType === "order" && line.txn.refId) {
    const order = await db.order.findUnique({
      where: { id: line.txn.refId },
      include: { items: true },
    });
    if (order && order.storeId === store.id) {
      related = {
        kind: "order",
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        totalMinor: order.totalMinor,
        placedAt: order.createdAt.toISOString(),
        paidAt: order.paidAt ? order.paidAt.toISOString() : null,
        itemCount: order.items.reduce((s, i) => s + i.qty, 0),
      };
    }
  } else if (line.txn.refType === "payout" && line.txn.refId) {
    const payout = await db.payout.findUnique({ where: { id: line.txn.refId } });
    if (payout && payout.walletId === wallet.id) {
      related = {
        kind: "payout",
        payoutId: payout.id,
        referenceNo: payout.referenceNo,
        status: payout.status,
        method: payout.method,
        amountMinor: payout.amountMinor,
        paidAt: payout.paidAt ? payout.paidAt.toISOString() : null,
      };
    }
  } else if (line.txn.refType === "settlement") {
    related = { kind: "settlement", reference: line.txn.refId };
  } else if (line.txn.refType === "wallet") {
    related = { kind: "wallet_adjustment", reference: line.txn.refId };
  }

  const payload: SellerWalletActivityData = {
    line: {
      id: line.id,
      accountCode: line.accountCode,
      direction: line.direction,
      amountMinor: line.amountMinor,
      availableAt: line.availableAt ? line.availableAt.toISOString() : null,
      memo: line.memo,
      createdAt: line.createdAt.toISOString(),
    },
    txn: {
      id: line.txn.id,
      txnType: line.txn.txnType,
      refType: line.txn.refType,
      refId: line.txn.refId,
      description: line.txn.description,
      occurredAt: line.txn.occurredAt.toISOString(),
    },
    walletAmountMinor,
    related,
    journal: line.txn.lines.map((l) => ({
      id: l.id,
      accountCode: l.accountCode,
      direction: l.direction,
      amountMinor: l.amountMinor,
      availableAt: l.availableAt ? l.availableAt.toISOString() : null,
      memo: l.memo,
      isMine: l.walletId === wallet.id,
    })),
  };
  return ok(payload);
});
