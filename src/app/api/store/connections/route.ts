// GET /api/store/connections — list the seller's marketplace connections.
// Tokens are NEVER returned — only status, shop identity and expiry.
import { NextRequest } from "next/server";
import { handle, ok, fail } from "@/lib/api";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const GET = handle(async function (_req: NextRequest) {
    const session = await getSession();
    if (!session || session.userType !== "seller") return fail(401, "UNAUTHENTICATED", "Seller session required.");
    const seller = await db.seller.findUnique({ where: { id: session.userId }, include: { store: true } });
    const connections = await db.marketplaceConnection.findMany({
      where: { OR: [{ storeId: seller?.store?.id ?? "__none__" }, { storeId: null }] },
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
    return ok({ connections, env });
});
