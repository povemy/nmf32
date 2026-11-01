// POST /api/store/publish — publish the seller's store after the publication gate.
import { NextRequest } from "next/server";
import { handle, ok, fail } from "@/lib/api";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { canPublish, transitionStore } from "@/lib/store-lifecycle";
import { bustPublicCacheSafe, PUBLIC_CACHE_TAGS } from "@/lib/public-cache";

export const dynamic = "force-dynamic";

export const POST = handle(async function (_req: NextRequest) {
    const session = await getSession();
    if (!session || session.userType !== "seller") return fail(401, "UNAUTHENTICATED", "Seller session required.");
    const seller = await db.seller.findUnique({ where: { id: session.userId }, include: { store: true } });
    if (!seller?.store) return fail(404, "NO_STORE", "No store found for this seller.");
    // F-02 remediation: a suspended/terminated seller must not be able to
    // self-un-suspend their storefront by re-publishing the draft store that
    // suspension set. (The publish path is the import-claim flow's go-live
    // gate — onboarding-tier statuses keep their documented access.)
    if (seller.status === "suspended") {
      return fail(403, "ACCOUNT_SUSPENDED", "This seller account is suspended — the store cannot be published.");
    }
    if (seller.status === "terminated") {
      return fail(403, "ACCOUNT_TERMINATED", "This seller account is terminated — the store cannot be published.");
    }
    // C1.3 (seller publication governance): FAIL CLOSED for public selling —
    // only an admin-approved seller (status "active") may take a store live.
    // Until genuine seller verification exists, every pre-approval status
    // blocks self-publication, so the import-claim flow deliberately requires
    // admin approval before going live (claim → claimed → draft keeps working;
    // the seller submits onboarding → admin approves → publish). These blocks
    // are belt-and-braces — canPublish() enforces the same rule as the
    // authoritative gate.
    if (seller.status === "onboarding") {
      return fail(403, "SELLER_ONBOARDING", "Your seller account is still in onboarding — submit it for review; an administrator must approve it before this store can go live.");
    }
    if (seller.status === "pending_review") {
      return fail(403, "SELLER_PENDING_REVIEW", "Your seller account is pending review — an administrator must approve it before this store can go live.");
    }
    if (seller.status === "rejected") {
      return fail(403, "SELLER_REJECTED", "Your seller application was rejected — revise and resubmit it; an administrator must approve it before this store can go live.");
    }
    if (seller.status !== "active") {
      // catch-all for any future seller status — the gate stays closed
      return fail(403, "SELLER_NOT_APPROVED", `Seller account status "${seller.status}" cannot publish a public store.`);
    }
    const gate = await canPublish(seller.store.id);
    if (!gate.ok) {
      // C1.3: a seller-approval failure from the gate is an account problem
      // (403), not a store-completeness problem (422).
      if (gate.code === "SELLER_NOT_APPROVED") {
        return fail(403, "SELLER_NOT_APPROVED", "Your seller account must be approved by an administrator before this store can go live.", { blockers: gate.blockers });
      }
      return fail(422, "PUBLISH_BLOCKED", "Store cannot be published yet.", { blockers: gate.blockers });
    }
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
    bustPublicCacheSafe(PUBLIC_CACHE_TAGS.stores, PUBLIC_CACHE_TAGS.market);
    return ok({ status: res.status, publishedAt: new Date().toISOString() });
});
