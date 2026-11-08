// GET /api/store/connections — list the seller's marketplace connections.
// Tokens are NEVER returned — only status, shop identity and expiry.
//
// F-20 remediation (minimal, fail-closed): the list is scoped STRICTLY to the
// session seller's own store. Global (storeId = null) handshake rows are
// invisible — they are pre-claim artifacts of the deferred OAuth binding flow
// and were never this seller's to see (cross-store information disclosure,
// audit finding F-20). Binding happens via the claim flow, not this list.
import { NextRequest } from "next/server";
import { handle, ok, fail } from "@/lib/api";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import type { ConnectionsData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

export const GET = handle(async function (_req: NextRequest) {
    const session = await getSession();
    if (!session || session.userType !== "seller") return fail(401, "UNAUTHENTICATED", "Seller session required.");
    // PHASE 2.3 select hygiene (C2.7): only the store id is used — selecting
    // the relation explicitly keeps the un-migrated Seller.emailVerifiedAt
    // column out of the query (default/include select → P2022 pre-migration).
    const seller = await db.seller.findUnique({
      where: { id: session.userId },
      select: { store: { select: { id: true } } },
    });
    const connections = await db.marketplaceConnection.findMany({
      where: { storeId: seller?.store?.id ?? "__none__" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        platform: true,
        status: true,
        envConfigured: true,
        shopId: true,
        shopName: true,
        region: true,
        expiresAt: true,
        lastRefreshAt: true,
        lastError: true,
        createdAt: true,
      },
    });
    // per-platform env status (never values)
    const env = {
      shopee: Boolean(process.env.SHOPEE_PARTNER_ID && process.env.SHOPEE_PARTNER_KEY),
      tiktok: Boolean(process.env.TIKTOK_SHOP_APP_KEY && process.env.TIKTOK_SHOP_APP_SECRET),
    };
    const payload: ConnectionsData = {
      connections: connections.map((c) => ({
        id: c.id,
        platform: c.platform,
        status: c.status,
        envConfigured: c.envConfigured,
        shopId: c.shopId,
        shopName: c.shopName,
        region: c.region,
        expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
        lastRefreshAt: c.lastRefreshAt ? c.lastRefreshAt.toISOString() : null,
        lastError: c.lastError,
        createdAt: c.createdAt.toISOString(),
      })),
      env,
    };
    return ok(payload);
});
