// POST /api/claim/bind — bind a generated store to the authenticated seller.
// Security model (spec §7.3):
//  - claim token is 192-bit random, stored sha256-hashed, single-use, time-limited
//  - binding happens in a guarded transaction (two sellers can never claim concurrently)
//  - OAuth methods additionally verify the authorised shop identity matches the imported shop
//  - fixture demo stores are claimed with the claim token itself (clearly-labelled demo)
//  - PHASE 2.2 (C3 — marketplace OAuth connection ownership): the OAuth
//    verification connection must be the claiming seller's OWN (attributed via
//    the OAuth sellerId) or a legacy unattributed connection matching the
//    imported shop; the post-claim bulk-bind likewise only attaches the
//    claimer's own (or the shop-matched legacy) unbound connections — never
//    another seller's fresh OAuth handshakes.
// NOTE (p10-a): handler normalised to the repo-standard `handle(...)` pattern
// (previously returned the wrapped function instead of a Response → 500).
import { NextRequest } from "next/server";
import { handle, ok, fail, ApiError, logActivity } from "@/lib/api";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { sha256Hex } from "@/lib/secretbox";
import { transitionStore } from "@/lib/store-lifecycle";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  const session = await getSession();
  if (!session || session.userType !== "seller") {
    return fail(401, "UNAUTHENTICATED", "Log in or create a seller account first, then claim the store.");
  }
  const body = (await req.json().catch(() => ({}))) as {
    jobId?: string;
    claimToken?: string;
    method?: string; // oauth_shopee | oauth_tiktok | claim_code
    evidence?: { connectionShopId?: string };
  };
  if (!body.jobId || !body.claimToken) {
    return fail(400, "MISSING_FIELDS", "jobId and claimToken are required.");
  }
  const job = await db.importJob.findUnique({ where: { id: body.jobId }, select: { id: true, storeId: true, sourceShopId: true, platform: true, isFixture: true, claimedById: true } });
  if (!job || !job.storeId) return fail(404, "JOB_NOT_FOUND", "Import job not found or store not generated yet.");
  if (job.claimedById) return fail(409, "ALREADY_CLAIMED", "This generated store has already been claimed.");

  const claim = await db.storeClaim.findFirst({
    where: { storeId: job.storeId, status: "active", expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!claim || claim.tokenHash !== sha256Hex(body.claimToken)) {
    return fail(403, "INVALID_CLAIM_TOKEN", "This claim link is invalid, already used, or expired.");
  }

  // verification per method
  const method = body.method ?? (job.isFixture ? "claim_code" : "pending");
  let verification: Record<string, unknown> = { method, at: new Date().toISOString() };
  if (method === "oauth_shopee" || method === "oauth_tiktok") {
    const platform = method === "oauth_shopee" ? "shopee" : "tiktok";
    if (platform !== job.platform) {
      return fail(400, "METHOD_MISMATCH", `This store was imported from ${job.platform}; connect the ${job.platform} account instead.`);
    }
    // PHASE 2.2 (C3 — marketplace OAuth connection ownership): scope the
    // verification lookup to connections the claiming seller owns — attributed
    // to them by the OAuth callback (sellerId) — or legacy unattributed rows
    // (sellerId null; pre-C3 handshakes), which remain claimable via the
    // single-use claim token plus the shop match below. Another seller's
    // attributed connection can never verify this claim.
    const conn = await db.marketplaceConnection.findFirst({
      where: {
        platform,
        status: "connected",
        shopId: job.sourceShopId ?? undefined,
        OR: [{ sellerId: session.userId }, { sellerId: null }],
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, shopId: true, shopName: true, sellerId: true },
    });
    if (!conn || !job.sourceShopId || conn.shopId !== job.sourceShopId) {
      return fail(403, "OWNERSHIP_NOT_VERIFIED",
        "Authorised marketplace account does not match the imported shop. Connect the marketplace account that owns this shop and try again.");
    }
    // bind connection to the claiming seller's store
    verification = {
      ...verification,
      connectionId: conn.id,
      shopId: conn.shopId,
      shopName: conn.shopName,
      connectionOwnership: conn.sellerId === session.userId ? "seller_attributed" : "legacy_shop_matched",
    };
  } else if (method === "claim_code") {
    if (!job.isFixture) {
      return fail(400, "METHOD_UNAVAILABLE", "Claim-code verification is only available for demo fixture stores.");
    }
    verification = { ...verification, demo: true };
  } else {
    return fail(400, "VERIFICATION_REQUIRED", "Complete ownership verification before claiming (connect the marketplace account).");
  }

  // atomic bind: guarded updateMany on sellerId=null prevents double-claim races
  const result = await db.$transaction(async (tx) => {
    // Store.sellerId is @unique (1 store per seller). Accounts that just
    // registered during the claim flow still own the auto-created registration
    // placeholder ("{displayName}'s Store" — native, draft, completely empty).
    // Retire that untouched placeholder (detach, never delete) so the claimed
    // generated store can be bound. A store with real content is never touched.
    const placeholder = await tx.store.findUnique({
      where: { sellerId: session.userId },
      select: { id: true, name: true, status: true, lifecycleSource: true, _count: { select: { products: true, orders: true } } },
    });
    if (placeholder) {
      const untouched =
        placeholder.lifecycleSource === "native" &&
        placeholder.status === "draft" &&
        placeholder._count.products === 0 &&
        placeholder._count.orders === 0;
      if (!untouched) {
        throw new ApiError(409, "STORE_LIMIT",
          "Your seller account already owns a store with content, and NOMOFEE links one store per account. Claim this generated store from a fresh seller account, or import the catalogue into your existing store from the seller portal Imports page.");
      }
      await tx.store.update({ where: { id: placeholder.id }, data: { sellerId: null } });
    }
    const bind = await tx.store.updateMany({
      where: { id: job.storeId as string, sellerId: null },
      data: { sellerId: session.userId },
    });
    if (bind.count !== 1) throw new ApiError(409, "ALREADY_CLAIMED", "Another seller claimed this store moments ago.");
    const used = await tx.storeClaim.updateMany({
      where: { id: claim.id, status: "active" },
      data: { status: "used", usedById: session.userId, usedAt: new Date(), verificationResultJson: JSON.stringify(verification) },
    });
    if (used.count !== 1) throw new ApiError(409, "ALREADY_CLAIMED", "This claim link was already used.");
    await tx.importJob.update({ where: { id: job.id }, data: { claimedById: session.userId } });
    const st = await tx.store.findUnique({ where: { id: job.storeId as string }, select: { id: true, name: true, slug: true } });
    return st;
  });

  await transitionStore({ storeId: result!.id, to: "claimed", actorType: "seller", actorId: session.userId, note: "store claimed via verified claim token" }).catch(() => undefined);
  // claimed → draft so the owner can configure before publishing
  await transitionStore({ storeId: result!.id, to: "draft", actorType: "seller", actorId: session.userId, note: "owner configuration phase" }).catch(() => undefined);
  // bind fixture/own connections (if any) to the store — PHASE 2.2 (C3): this
  // previously attached ALL unbound connections of the platform (including
  // other sellers' fresh OAuth handshakes) to the claimer's store. Now only the
  // claimer's OWN unbound connections, plus legacy unattributed ones matching
  // the imported shop of this claim token's job, are attached.
  await db.marketplaceConnection.updateMany({
    where: {
      platform: job.platform,
      storeId: null,
      OR: [{ sellerId: session.userId }, { sellerId: null, shopId: job.sourceShopId }],
    },
    data: { storeId: result!.id },
  }).catch(() => undefined);

  await logActivity({
    actorType: "seller",
    actorId: session.userId,
    action: "store.claimed",
    entityType: "store",
    entityId: result!.id,
    meta: verification,
  }).catch(() => undefined);

  return ok({
    store: result,
    nextStep: "Configure your store in the seller portal, then publish.",
  });
});
