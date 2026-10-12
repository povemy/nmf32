// GET /api/store/imports — import jobs + connection status for the seller import centre.
import { NextRequest } from "next/server";
import { handle, ok, fail } from "@/lib/api";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { parseJson } from "@/lib/json";

export const dynamic = "force-dynamic";

export const GET = handle(async function (_req: NextRequest) {
    const session = await getSession();
    if (!session || session.userType !== "seller") return fail(401, "UNAUTHENTICATED", "Seller session required.");
    const seller = await db.seller.findUnique({ where: { id: session.userId }, include: { store: true } });
    const jobs = await db.importJob.findMany({
      where: { OR: [{ storeId: seller?.store?.id ?? "__none__" }, { claimedById: session.userId }] },
      orderBy: { createdAt: "desc" },
      take: 30,
      include: { _count: { select: { items: true } } },
    });
    const connections = await db.marketplaceConnection.findMany({
      where: { OR: [{ storeId: seller?.store?.id ?? "__none__" }, { storeId: null }] },
      select: { platform: true, status: true, shopName: true, expiresAt: true, envConfigured: true },
    });
    return ok({
      jobs: jobs.map((j) => {
        const summary = parseJson<{ productsOk?: number; productsFailed?: number; isFixture?: boolean }>(j.summaryJson, {});
        const progress = parseJson<Record<string, number>>(j.progressJson, {});
        const error = parseJson<{ message?: string }>(j.errorJson, {});
        return {
          id: j.id,
          trackingToken: j.trackingToken,
          platform: j.platform,
          urlType: j.urlType,
          inputUrl: j.inputUrl,
          status: j.status,
          phaseDetail: j.phaseDetail,
          isFixture: j.isFixture,
          storeId: j.storeId,
          createdAt: j.createdAt,
          finishedAt: j.finishedAt,
          itemCount: j._count.items,
          productsOk: summary.productsOk ?? null,
          productsFailed: summary.productsFailed ?? null,
          progress,
          errorMessage: error.message ?? null,
        };
      }),
      connections,
      env: {
        shopee: Boolean(process.env.SHOPEE_PARTNER_ID && process.env.SHOPEE_PARTNER_KEY),
        tiktok: Boolean(process.env.TIKTOK_SHOP_APP_KEY && process.env.TIKTOK_SHOP_APP_SECRET),
      },
    });
});
