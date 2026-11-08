import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { claimVoucherForShopper, SUPPORTED_VOUCHER_KINDS } from "@/lib/vouchers";
import type { ClaimByCodeBody, ClaimByCodeData, MeClaimableVoucher, MeHeldVoucher, MeWalletVoucher, VouchersData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

function isExpired(v: { expiryAt: Date }): boolean {
  return v.expiryAt.getTime() < Date.now();
}

type StoreBrief = { name: string; slug: string; logoUrl: string | null };

function storeBrief(store: { name: string; slug: string; logoUrl: string | null } | null | undefined): StoreBrief | null {
  return store ? { name: store.name, slug: store.slug, logoUrl: store.logoUrl ?? null } : null;
}

// GET /api/me/vouchers — the signed-in buyer's voucher wallet PLUS the claim
// centre pool. Response (all under data):
//  • vouchers — legacy mine array (kept for existing UI)
//  • mine     — held vouchers with full voucher + store brief + claimedByMe
//  • center   — claimable pool (platform + live-store scoped, coinsback
//               excluded) with store brief, claimedByMe and quotaRemaining
export const GET = handle(async () => {
  const me = await requireShopper();
  const rows = await db.userVoucher.findMany({
    where: { userId: me.id },
    orderBy: { claimedAt: "desc" },
    include: { voucher: { include: { store: { select: { name: true, slug: true, logoUrl: true } } } } },
  });

  // Lazy expiry — rows past their expiry date flip to EXPIRED on read.
  const stale = rows.filter((r) => r.status === "AVAILABLE" && isExpired(r.voucher));
  if (stale.length > 0) {
    await db.userVoucher.updateMany({
      where: { id: { in: stale.map((r) => r.id) } },
      data: { status: "EXPIRED" },
    });
  }
  const expiredIds = new Set(stale.map((r) => r.id));

  const mine: MeWalletVoucher[] = rows.map((r) => {
    const status = r.status === "AVAILABLE" && expiredIds.has(r.id) ? "EXPIRED" : r.status;
    return {
      id: r.id,
      status,
      claimedByMe: true,
      claimedAt: r.claimedAt.toISOString(),
      usedAt: r.usedAt ? r.usedAt.toISOString() : null,
      usedOrderId: r.usedOrderId,
      voucher: {
        id: r.voucher.id,
        code: r.voucher.code,
        title: r.voucher.title,
        kind: r.voucher.kind,
        discountMinor: r.voucher.discountMinor,
        percentOff: r.voucher.percentOff,
        maxDiscountMinor: r.voucher.maxDiscountMinor,
        minSpendMinor: r.voucher.minSpendMinor,
        expiryAt: r.voucher.expiryAt.toISOString(),
        scope: r.voucher.scope,
        storeId: r.voucher.storeId,
        regionLimit: r.voucher.regionLimit,
        store: storeBrief(r.voucher.store),
      },
    };
  });

  // Legacy contract: flat rows keyed `vouchers` (me-hub voucher sub-view).
  const legacy: MeHeldVoucher[] = mine.map((m) => ({
    id: m.id,
    status: m.status,
    claimedAt: m.claimedAt,
    usedAt: m.usedAt,
    voucher: {
      code: m.voucher.code,
      title: m.voucher.title,
      kind: m.voucher.kind,
      discountMinor: m.voucher.discountMinor,
      percentOff: m.voucher.percentOff,
      maxDiscountMinor: m.voucher.maxDiscountMinor,
      minSpendMinor: m.voucher.minSpendMinor,
      expiryAt: m.voucher.expiryAt,
    },
  }));

  // Claim centre pool: active, started, unexpired, claimable kinds only.
  // Platform vouchers + store-scope vouchers of LIVE stores surface; coinsback
  // is excluded platform-wide (finance suite dormant).
  const now = new Date();
  const pool = await db.voucher.findMany({
    where: {
      isActive: true,
      kind: { in: [...SUPPORTED_VOUCHER_KINDS] },
      expiryAt: { gt: now },
      OR: [{ startsAt: null }, { startsAt: { lte: now } }],
    },
    orderBy: { createdAt: "desc" },
    include: { store: { select: { name: true, slug: true, logoUrl: true, status: true } } },
  });
  const heldVoucherIds = new Set(rows.map((r) => r.voucherId));
  const center: MeClaimableVoucher[] = pool
    .filter((v) => v.scope === "PLATFORM" || (v.scope === "STORE" && v.store?.status === "live"))
    .map((v) => {
      const claimedByMe = heldVoucherIds.has(v.id);
      const quotaRemaining = v.quota != null ? Math.max(0, v.quota - v.claimedCount) : null;
      return {
        id: v.id,
        code: v.code,
        title: v.title,
        kind: v.kind,
        discountMinor: v.discountMinor,
        percentOff: v.percentOff,
        maxDiscountMinor: v.maxDiscountMinor,
        minSpendMinor: v.minSpendMinor,
        expiryAt: v.expiryAt.toISOString(),
        startsAt: v.startsAt ? v.startsAt.toISOString() : null,
        scope: v.scope,
        regionLimit: v.regionLimit,
        store: storeBrief(v.store),
        claimedByMe,
        quotaRemaining,
        claimable: !claimedByMe && (quotaRemaining == null || quotaRemaining > 0),
      };
    });

  const payload: VouchersData = { vouchers: legacy, mine, center };
  return ok(payload);
});

const claimSchema = { code: "string (2-40 chars)" } as const;

// POST /api/me/vouchers — claim a pool voucher by code (legacy contract; the
// same engine powers POST /api/me/vouchers/claim which also accepts voucherId).
export const POST = handle(async (req: Request) => {
  const me = await requireShopper();
  const body = (await req.json().catch(() => ({}))) as ClaimByCodeBody;
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (code.length < 2 || code.length > 40) {
    throw new ApiError(400, "VALIDATION", `A voucher code is required (${claimSchema.code})`);
  }
  const res = await claimVoucherForShopper(me.id, { code });
  const payload: ClaimByCodeData = {
    voucher: { code: res.voucher.code, title: res.voucher.title, kind: res.voucher.kind, scope: res.voucher.scope },
    status: res.userVoucher.status,
  };
  return ok(payload, { status: 201 });
});
