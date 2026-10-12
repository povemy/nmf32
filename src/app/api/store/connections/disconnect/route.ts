// DELETE /api/store/connections/disconnect?platform= — disconnect a marketplace (soft, audited).
import { NextRequest } from "next/server";
import { handle, ok, fail, logActivity } from "@/lib/api";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const DELETE = handle(async function (req: NextRequest) {
    const session = await getSession();
    if (!session || session.userType !== "seller") return fail(401, "UNAUTHENTICATED", "Seller session required.");
    const platform = req.nextUrl.searchParams.get("platform") ?? "";
    if (!["shopee", "tiktok", "fixture"].includes(platform)) {
      return fail(400, "INVALID_PLATFORM", "Unsupported platform.");
    }
    const seller = await db.seller.findUnique({ where: { id: session.userId }, include: { store: true } });
    const updated = await db.marketplaceConnection.updateMany({
      where: { platform, OR: [{ storeId: seller?.store?.id ?? "__none__" }, { storeId: null }] },
      data: { status: "disconnected" },
    });
    await logActivity({
      actorType: "seller",
      actorId: session.userId,
      action: "connection.disconnected",
      entityType: "marketplace_connection",
      entityId: platform,
      meta: { count: updated.count },
    }).catch(() => undefined);
    return ok({ disconnected: updated.count });
});
