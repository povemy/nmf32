import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { refreshWalletCache } from "@/lib/ledger";

export const dynamic = "force-dynamic";

// GET /api/store/me — seller + store + wallet + onboarding checklist + stats.
export const GET = handle(async () => {
  const { me, store } = await requireActiveSellerStore();

  const [sellerRow, productCount, bankVerified, orders30] = await Promise.all([
    db.seller.findUnique({ where: { id: me.id } }),
    db.product.count({ where: { storeId: store.id, status: { not: "archived" } } }),
    db.bankAccount.findFirst({ where: { sellerId: me.id, verified: true } }),
    db.order.findMany({
      where: { storeId: store.id, paidAt: { not: null } },
      select: { totalMinor: true, paidAt: true },
    }),
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

  let wallet = null;
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
    },
    wallet,
    onboarding: { step, checklist },
    stats: { ordersCount, productCount, revenue30dMinor },
  });
});
