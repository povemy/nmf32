import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { refreshWalletCache } from "@/lib/ledger";
import { getSellerEmailVerifiedAt } from "@/lib/seller-email-verification";

export const dynamic = "force-dynamic";

// GET /api/store/me — seller + store + wallet + onboarding checklist + stats.
//
// PHASE 2.3 (C2.7): the seller object now carries emailVerified /
// emailVerifiedAt — the CONSOLE's honest signal for the “Verify your email”
// card. The read is tolerant (stale client / un-migrated column → null = NOT
// verified), and the main seller query uses an explicit field list that
// EXCLUDES emailVerifiedAt so the un-migrated dev server keeps serving.
export const GET = handle(async () => {
  const { me, store } = await requireActiveSellerStore();

  const [sellerRow, productCount, bankVerified, orders30, emailVerifiedAt] = await Promise.all([
    // PHASE 2.3 select hygiene (C2.7): explicit fields EXCLUDING the
    // un-migrated Seller.emailVerifiedAt (default select → P2022 pre-
    // migration 20261107000000); the verified timestamp is read tolerantly
    // below/above via getSellerEmailVerifiedAt (null = NOT verified).
    db.seller.findUnique({
      where: { id: me.id },
      select: {
        id: true,
        fullName: true,
        phone: true,
        status: true,
        kycStatus: true,
        riskTier: true,
        planCode: true,
        marketplaceOptIn: true,
        submittedAt: true,
        rejectReason: true,
      },
    }),
    db.product.count({ where: { storeId: store.id, status: { not: "archived" } } }),
    db.bankAccount.findFirst({ where: { sellerId: me.id, verified: true } }),
    db.order.findMany({
      where: { storeId: store.id, paidAt: { not: null } },
      select: { totalMinor: true, paidAt: true },
    }),
    getSellerEmailVerifiedAt(me.id),
  ]);

  const checklist = {
    profile: !!(sellerRow?.fullName && sellerRow?.phone),
    storeIdentity: !!(store.name && store.tagline),
    kyc: sellerRow?.kycStatus === "approved",
    bank: !!bankVerified,
    products: productCount > 0,
  };

  let step: string;
  if (sellerRow?.status === "active") step = "done";
  else if (sellerRow?.status === "pending_review") step = "under_review";
  else if (sellerRow?.status === "rejected") step = "rejected";
  else if (sellerRow?.status === "suspended" || sellerRow?.status === "terminated") step = "suspended";
  else if (Object.values(checklist).every(Boolean)) step = "submit";
  else step = "setup";

  const cutoff30 = new Date(Date.now() - 30 * 86400000);
  const revenue30dMinor = orders30.filter((o) => o.paidAt && o.paidAt >= cutoff30).reduce((s, o) => s + o.totalMinor, 0);

  let wallet: Awaited<ReturnType<typeof db.wallet.findUnique>> = null;
  if (sellerRow) {
    const w = await db.wallet.findUnique({ where: { sellerId: sellerRow.id } });
    if (w) {
      await refreshWalletCache(w.id);
      wallet = await db.wallet.findUnique({ where: { id: w.id } });
    }
  }

  const ordersCount = await db.order.count({ where: { storeId: store.id } });

  return ok({
    seller: {
      id: me.id,
      email: me.email,
      fullName: me.fullName,
      displayName: me.displayName,
      phone: sellerRow?.phone ?? null,
      status: sellerRow?.status ?? me.status,
      kycStatus: sellerRow?.kycStatus ?? null,
      riskTier: sellerRow?.riskTier ?? null,
      planCode: sellerRow?.planCode ?? null,
      marketplaceOptIn: sellerRow?.marketplaceOptIn ?? true,
      submittedAt: sellerRow?.submittedAt ?? null,
      rejectReason: sellerRow?.rejectReason ?? null,
      // PHASE 2.3 (C2.7) — honest email-verification state: null timestamp
      // (or storage not migrated yet) is reported as NOT verified.
      emailVerified: emailVerifiedAt != null,
      emailVerifiedAt: emailVerifiedAt ? emailVerifiedAt.toISOString() : null,
    },
    store: {
      id: store.id,
      name: store.name,
      slug: store.slug,
      tagline: store.tagline,
      logoUrl: store.logoUrl,
      bannerUrl: store.bannerUrl,
      description: store.description,
      status: store.status,
      supportEmail: store.supportEmail,
      supportPhone: store.supportPhone,
      whatsapp: store.whatsapp,
      // marketplaceOptIn lives on the Seller record — surface it under store for the settings UI
      marketplaceOptIn: sellerRow?.marketplaceOptIn ?? true,
      theme: store.themeJson,
      // Storefront display + home organization (seller store settings work
      // order) — the Storefront settings tab hydrates from this payload.
      cardShowStars: store.cardShowStars,
      cardMetric: store.cardMetric,
      homeShowFeatured: store.homeShowFeatured,
      homeShowFresh: store.homeShowFresh,
      homeFeaturedFirst: store.homeFeaturedFirst,
    },
    wallet,
    onboarding: { step, checklist },
    stats: { ordersCount, productCount, revenue30dMinor },
  });
});
