// DELETE /api/store/connections/disconnect?platform= — disconnect a marketplace (soft, audited).
//
// F-20 remediation (minimal, fail-closed): the mutation is scoped STRICTLY to
// the session seller's own store rows. Global (storeId = null) rows are NEVER
// mutated — previously one seller's "disconnect" flipped the shared row every
// other store could see (audit finding F-20). Unclaimed handshake rows can no
// longer be soft-disconnected by any seller; binding flows are unaffected.
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
    // PHASE 2.3 select hygiene (C2.7): only the store id is used — selecting
    // the relation explicitly keeps the un-migrated Seller.emailVerifiedAt
    // column out of the query (default/include select → P2022 pre-migration).
    const seller = await db.seller.findUnique({
      where: { id: session.userId },
      select: { store: { select: { id: true } } },
    });
    const updated = await db.marketplaceConnection.updateMany({
      where: { platform, storeId: seller?.store?.id ?? "__none__" },
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
