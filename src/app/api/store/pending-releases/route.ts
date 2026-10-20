import { db } from "@/lib/db";
import { ApiError, getPagination, handle, okPaged } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { ACCOUNTS, refreshWalletCache } from "@/lib/ledger";

export const dynamic = "force-dynamic";

// GET /api/store/pending-releases — grace-period release schedule.
//
// Rows are the PENDING seller-net credits on SELLER:{walletId}:PAYABLE, i.e.
// ledger lines where direction=credit AND availableAt > now. Only order-origin
// credits are listed: the T1 recipe (src/lib/ledger.ts postOrderPaid) writes
// exactly ONE credit per paid order with txnType="order_paid", refType="order",
// refId=orderId and availableAt = paidAt + holdDays (dedupKey
// `order_paid:order:{orderId}` guarantees 1:1 with the order), so a credit
// joined to its order by refId is always a single unambiguous row.
// Other credits on the same account (payout reversals T4r, wallet adjustments)
// mature immediately (availableAt = now) or are not order-origin — they never
// appear here, and Wallet.pendingMinor remains the cached ledger truth.
export const GET = handle(async (req: Request) => {
  const { me } = await requireActiveSellerStore();

  const wallet = await db.wallet.findUnique({ where: { sellerId: me.id } });
  if (!wallet) throw new ApiError(404, "NOT_FOUND", "Wallet not found");

  // Cached wallet columns are refreshed before reading (ledger is the truth).
  await refreshWalletCache(wallet.id);

  const url = new URL(req.url);
  if (!url.searchParams.get("size")) url.searchParams.set("size", "25"); // default page size 25
  const { page, size, skip, take } = getPagination(url, 100);

  const lineWhere = {
    accountCode: ACCOUNTS.sellerPayable(wallet.id),
    direction: "credit" as const,
    walletId: wallet.id,
    availableAt: { gt: new Date() },
    txn: { txnType: "order_paid", refType: "order" },
  };

  const [total, sum, next, lines] = await Promise.all([
    db.ledgerLine.count({ where: lineWhere }),
    db.ledgerLine.aggregate({ where: lineWhere, _sum: { amountMinor: true } }),
    db.ledgerLine.findFirst({
      where: lineWhere,
      orderBy: { availableAt: "asc" },
      select: { availableAt: true },
    }),
    db.ledgerLine.findMany({
      where: lineWhere,
      include: { txn: { select: { txnType: true, refType: true, refId: true, occurredAt: true } } },
      orderBy: { availableAt: "asc" }, // soonest release first
      skip,
      take,
    }),
  ]);

  // One T1 credit per order → join the page's refIds to orders (1:1).
  const refIds = lines.map((l) => l.refId).filter((id): id is string => typeof id === "string");
  const orders = refIds.length
    ? await db.order.findMany({
        where: { id: { in: refIds } },
        select: { id: true, orderNumber: true, status: true, paidAt: true },
      })
    : [];
  const orderById = new Map(orders.map((o) => [o.id, o]));

  const releases = lines.map((l) => {
    const order = (l.refId ? orderById.get(l.refId) : undefined) ?? null;
    const availableAt = l.availableAt as Date;
    // paidAt = the order's payment timestamp when present, else the T1 txn's
    // occurredAt (postOrderPaid writes occurredAt = paidAt, so they agree).
    const paidAt = order?.paidAt ?? l.txn.occurredAt;
    const holdDays = Math.max(0, Math.ceil((availableAt.getTime() - paidAt.getTime()) / 86400000));
    return {
      orderId: l.refId ?? order?.id ?? "",
      orderNumber: order?.orderNumber ?? "—",
      orderStatus: order?.status ?? "unknown",
      amountMinor: l.amountMinor,
      paidAt,
      availableAt,
      holdDays,
    };
  });

  return okPaged(
    {
      summary: {
        totalMinor: sum._sum.amountMinor ?? 0,
        count: total,
        nextReleaseAt: next?.availableAt ?? null,
      },
      releases,
    },
    { page, size, total }
  );
});
