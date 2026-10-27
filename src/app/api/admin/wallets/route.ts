import { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { safeRefreshWalletCache } from "@/lib/ledger";

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

  const data: unknown[] = [];
  for (const w of wallets) {
    // safeRefresh: one contended wallet row can no longer 500 the whole
    // admin finance list — it falls back to last-known values for that row.
    const truth = await safeRefreshWalletCache(w.id);
    data.push({
      ...w,
      pendingMinor: truth.truth?.pendingMinor ?? w.pendingMinor,
      availableMinor: truth.truth?.availableMinor ?? w.availableMinor,
      lifetimeEarnedMinor: truth.truth?.lifetimeEarnedMinor ?? w.lifetimeEarnedMinor,
      lifetimeCommissionMinor: truth.truth?.lifetimeCommissionMinor ?? w.lifetimeCommissionMinor,
      cacheRefreshed: truth.refreshed,
      storeName: w.seller.store?.name ?? null,
      storeSlug: w.seller.store?.slug ?? null,
    });
  }
  return ok(data);
});
