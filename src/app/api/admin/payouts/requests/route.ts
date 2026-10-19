import { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

// GET /api/admin/payouts/requests — seller-initiated payout requests
// (Payout rows with method "seller_request"). Split into an "open" queue
// (requested → needs approve/reject) and "recent" history (processing /
// paid / failed / rejected) so the admin payouts page can render both.
export const GET = handle(async (_req: NextRequest) => {
  await requireAdmin();

  const rows = await db.payout.findMany({
    where: { method: "seller_request" },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      bankAccount: { select: { id: true, bankName: true, holderName: true, accountNumberMasked: true, verified: true } },
    },
  });

  // seller info resolved manually (no relation declared on Payout)
  const sellerIds = [...new Set(rows.map((p) => p.sellerId))];
  const sellers = sellerIds.length
    ? await db.seller.findMany({
        where: { id: { in: sellerIds } },
        select: { id: true, email: true, displayName: true, store: { select: { id: true, name: true, slug: true } } },
      })
    : [];
  const sMap = new Map(sellers.map((s) => [s.id, s]));

  const shaped = rows.map((p) => {
    const s = sMap.get(p.sellerId);
    return {
      ...p,
      seller: s ? { id: s.id, email: s.email, displayName: s.displayName } : null,
      storeName: s?.store?.name ?? null,
    };
  });

  return ok({
    open: shaped.filter((p) => p.status === "requested"),
    recent: shaped.filter((p) => p.status !== "requested"),
  });
});
