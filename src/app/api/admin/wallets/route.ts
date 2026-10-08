import { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { refreshWalletCache } from "@/lib/ledger";

// GET /api/admin/wallets — wallets w/ seller + store names, truth-refreshed balances
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const wallets = await db.wallet.findMany({
    include: {
      seller: {
        select: {
          id: true,
          email: true,
          displayName: true,
          fullName: true,
          status: true,
          riskTier: true,
          store: { select: { id: true, name: true, slug: true, status: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const data = [];
  for (const w of wallets) {
    const truth = await refreshWalletCache(w.id);
    data.push({
      ...w,
      pendingMinor: truth.pendingMinor,
      availableMinor: truth.availableMinor,
      lifetimeEarnedMinor: truth.lifetimeEarnedMinor,
      lifetimeCommissionMinor: truth.lifetimeCommissionMinor,
      storeName: w.seller.store?.name ?? null,
      storeSlug: w.seller.store?.slug ?? null,
    });
  }
  return ok(data);
});
