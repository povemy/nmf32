// POST /api/store/publish — publish the seller's store after the publication gate.
import { NextRequest } from "next/server";
import { handle, ok, fail } from "@/lib/api";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { canPublish, transitionStore } from "@/lib/store-lifecycle";

export const dynamic = "force-dynamic";

export const POST = handle(async function (_req: NextRequest) {
    const session = await getSession();
    if (!session || session.userType !== "seller") return fail(401, "UNAUTHENTICATED", "Seller session required.");
    const seller = await db.seller.findUnique({ where: { id: session.userId }, include: { store: true } });
    if (!seller?.store) return fail(404, "NO_STORE", "No store found for this seller.");
    const gate = await canPublish(seller.store.id);
    if (!gate.ok) return fail(422, "PUBLISH_BLOCKED", "Store cannot be published yet.", { blockers: gate.blockers });
    const current = seller.store.status;
    if (current !== "draft" && current !== "maintenance" && current !== "claimed") {
      return fail(409, "INVALID_STATE", `Store in status "${current}" cannot be published.`);
    }
    // route through the guarded state machine
    let status = current;
    if (status === "claimed") {
      await transitionStore({ storeId: seller.store.id, to: "draft", actorType: "seller", actorId: session.userId });
      status = "draft";
    }
    const res = await transitionStore({ storeId: seller.store.id, to: "live", actorType: "seller", actorId: session.userId, note: "published via publish gate" });
    return ok({ status: res.status, publishedAt: new Date().toISOString() });
});
