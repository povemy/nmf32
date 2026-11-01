import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin, requireCap, requireAnyCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, optNum, optBool, str, stripSeller, daysAgo } from "@/app/api/admin/_helpers";
import { getSellerEmailVerifiedAt } from "@/lib/seller-email-verification";

type Ctx = { params: Promise<{ id: string }> };

// PHASE 2.3 select hygiene (C2.7): every Seller read/write below uses an
// EXPLICIT field list that EXCLUDES emailVerifiedAt and passwordHash — a
// default/include select would read the column added by migration
// 20261107000000 and P2022 on the un-migrated dev DB. The verified timestamp
// is read tolerantly (null = NOT verified) and surfaced as its own honest
// field. Bank accounts are narrowed to masked-display fields — the ciphertext
// (accountNumberEnc) is NEVER returned by a read surface (C2.5).
const SELLER_SCALARS = {
  id: true,
  email: true,
  fullName: true,
  displayName: true,
  countryCode: true,
  phone: true,
  status: true,
  riskTier: true,
  commissionOverridePercent: true,
  holdDaysOverride: true,
  kycStatus: true,
  planCode: true,
  marketplaceOptIn: true,
  rejectReason: true,
  submittedAt: true,
  approvedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

// GET /api/admin/sellers/[id] — full seller profile
// F-26 (Phase 3): this profile bundles KYC documents, bank accounts, the
// wallet and internal notes — a money/PII read that was previously open to
// every admin role (moderator included). Elevated tier only: ops + superadmin
// (seller management/approval) and finance + superadmin (commission/hold
// overrides are edited from this very view — F-09). Moderator keeps the
// non-sensitive sellers LIST (GET /api/admin/sellers, requireAdmin).
export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  await requireAnyCap("sellers.approve", "commission.manage");
  const { id } = await ctx.params;
  const seller = await db.seller.findUnique({
    where: { id },
    select: {
      ...SELLER_SCALARS,
      store: true,
      wallet: true,
      kycDocuments: { orderBy: { createdAt: "asc" } },
      bankAccounts: {
        orderBy: { createdAt: "desc" },
        select: { id: true, holderName: true, bankName: true, accountNumberMasked: true, verified: true, verifiedAt: true, createdAt: true },
      },
      sellerNotes: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");

  // PHASE 2.3 (C2.7) — honest email-verification state for the admin profile:
  // tolerant read; a null timestamp (never verified, or storage not yet
  // migrated) is reported as NOT verified. Never a facade "verified".
  const emailVerifiedAt = await getSellerEmailVerifiedAt(id);

  const [recentProducts, recentOrders, productCount] = await Promise.all([
    db.product.findMany({
      where: { storeId: seller.store?.id ?? "__none__" },
      include: { images: { orderBy: { sortOrder: "asc" }, take: 1 }, category: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    db.order.findMany({
      where: { storeId: seller.store?.id ?? "__none__" },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    db.product.count({ where: { storeId: seller.store?.id ?? "__none__" } }),
  ]);

  const since = daysAgo(30);
  const agg = seller.store
    ? await db.order.aggregate({
        where: { storeId: seller.store.id, paidAt: { gte: since, not: null } },
        _sum: { totalMinor: true },
        _count: { _all: true },
      })
    : { _sum: { totalMinor: 0 }, _count: { _all: 0 } };

  return ok({
    seller: { ...stripSeller(seller), emailVerifiedAt: emailVerifiedAt ? emailVerifiedAt.toISOString() : null },
    store: seller.store,
    kycDocuments: seller.kycDocuments,
    bankAccounts: seller.bankAccounts,
    wallet: seller.wallet,
    products: recentProducts,
    orders: recentOrders,
    notes: seller.sellerNotes,
    gmv30dMinor: agg._sum.totalMinor ?? 0,
    orders30d: agg._count._all,
    productCount,
  });
});

// PATCH /api/admin/sellers/[id] — risk tier / commission / hold overrides / marketplace opt-in
// F-09 (Phase 3): commission-policy fields (riskTier, commissionOverridePercent,
// holdDaysOverride) are now gated by `commission.manage` (superadmin | finance)
// — previously bare requireAdmin let a moderator zero any seller's commission
// and hold days. marketplaceOptIn is a listing preference, not money policy,
// and stays at the admin tier. Mixed bodies take the STRICTEST tier demanded
// by any field they carry.
export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req);

  const touchesCommissionPolicy =
    "riskTier" in body || "commissionOverridePercent" in body || "holdDaysOverride" in body;
  const admin = touchesCommissionPolicy
    ? await requireCap("commission.manage")
    : await requireAdmin();

  // PHASE 2.3 select hygiene: explicit fields for the audit "before" snapshot
  // (excludes the un-migrated emailVerifiedAt and the passwordHash).
  const seller = await db.seller.findUnique({
    where: { id },
    select: { id: true, riskTier: true, commissionOverridePercent: true, holdDaysOverride: true, marketplaceOptIn: true },
  });
  if (!seller) throw new ApiError(404, "NOT_FOUND", "Seller not found");

  const data: {
    riskTier?: string;
    commissionOverridePercent?: number | null;
    holdDaysOverride?: number | null;
    marketplaceOptIn?: boolean;
  } = {};
  const riskTier = str(body, "riskTier");
  if (riskTier != null) {
    if (!["low", "medium", "high"].includes(riskTier)) throw new ApiError(400, "VALIDATION", "riskTier must be low | medium | high");
    data.riskTier = riskTier;
  }
  if ("commissionOverridePercent" in body) {
    const v = optNum(body, "commissionOverridePercent");
    if (v != null && (v < 0 || v > 100)) throw new ApiError(400, "VALIDATION", "commissionOverridePercent must be 0..100");
    data.commissionOverridePercent = v ?? null;
  }
  if ("holdDaysOverride" in body) {
    const v = optNum(body, "holdDaysOverride");
    if (v != null && (v < 0 || v > 60)) throw new ApiError(400, "VALIDATION", "holdDaysOverride must be 0..60");
    data.holdDaysOverride = v != null ? Math.round(v) : null;
  }
  const marketplaceOptIn = optBool(body, "marketplaceOptIn");
  if (marketplaceOptIn != null) data.marketplaceOptIn = marketplaceOptIn;

  if (Object.keys(data).length === 0) throw new ApiError(400, "VALIDATION", "Nothing to update");

  // Same hygiene for the write: update() would RETURN all scalars (incl. the
  // un-migrated emailVerifiedAt — P2022 pre-migration 20261107000000).
  const updated = await db.seller.update({ where: { id }, data, select: { ...SELLER_SCALARS } });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "seller.update",
    entityType: "seller",
    entityId: id,
    before: {
      riskTier: seller.riskTier,
      commissionOverridePercent: seller.commissionOverridePercent,
      holdDaysOverride: seller.holdDaysOverride,
      marketplaceOptIn: seller.marketplaceOptIn,
    },
    after: data,
  });

  return ok(stripSeller(updated));
});
