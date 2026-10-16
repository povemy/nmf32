import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { SUPPORTED_VOUCHER_KINDS } from "@/lib/vouchers";

export const dynamic = "force-dynamic";

function parseDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function intOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function genVoucherCode(): string {
  // Auto code — readable, unique-checked below; e.g. "LM-7K3QD9"
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

// GET /api/store/vouchers — seller voucher panel: store-scope vouchers with
// claim/usage stats + the store's FS cost-recovery option.
export const GET = handle(async () => {
  const { store } = await requireActiveSellerStore();
  const rows = await db.voucher.findMany({
    where: { scope: "STORE", storeId: store.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { holders: true } } },
  });
  const usedCounts = await db.userVoucher.groupBy({
    by: ["voucherId"],
    where: { status: "USED", voucher: { storeId: store.id } },
    _count: true,
  });
  const usedByVoucher = new Map(usedCounts.map((u) => [u.voucherId, u._count]));

  return ok({
    vouchers: rows.map((v) => ({
      id: v.id,
      code: v.code,
      title: v.title,
      kind: v.kind,
      discountMinor: v.discountMinor,
      percentOff: v.percentOff,
      maxDiscountMinor: v.maxDiscountMinor,
      minSpendMinor: v.minSpendMinor,
      expiryAt: v.expiryAt,
      startsAt: v.startsAt,
      isActive: v.isActive,
      scope: v.scope,
      regionLimit: v.regionLimit,
      quota: v.quota,
      claimedCount: v.claimedCount,
      holders: v._count.holders,
      usedCount: usedByVoucher.get(v.id) ?? 0,
      createdAt: v.createdAt,
    })),
    fsPriceAdjustMinor: store.fsPriceAdjustMinor,
  });
});

// POST /api/store/vouchers — create a STORE-scope voucher for the seller's own
// store. Rules:
//  • kind: discount (flat discountMinor XOR percentOff 1..90 with optional cap)
//    or freeshipping (regionLimit forced to "peninsular" — West Malaysia only).
//  • code optional: auto-generated when omitted; 409 CODE_TAKEN on duplicates.
//  • money fields are integer minor units.
export const POST = handle(async (req: Request) => {
  const { me, store } = await requireActiveSellerStore();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const title = String(body.title ?? "").trim();
  if (title.length < 3 || title.length > 80) {
    throw new ApiError(400, "VALIDATION", "title must be 3-80 characters");
  }
  const kind = String(body.kind ?? "discount");
  if (!SUPPORTED_VOUCHER_KINDS.includes(kind)) {
    throw new ApiError(400, "VALIDATION", "kind must be discount | freeshipping (coinsback is disabled platform-wide)");
  }

  const minSpendMinor = intOr(body.minSpendMinor ?? 0, 0);
  if (minSpendMinor < 0 || minSpendMinor > 100_000_000) {
    throw new ApiError(400, "VALIDATION", "minSpendMinor must be a non-negative integer (minor units)");
  }
  const quota = body.quota != null && body.quota !== "" ? intOr(body.quota, 0) : null;
  if (quota != null && (quota < 1 || quota > 1_000_000)) {
    throw new ApiError(400, "VALIDATION", "quota must be a positive integer when provided");
  }
  const startsAt = parseDate(body.startsAt);
  const expiryAt = parseDate(body.expiryAt);
  if (!expiryAt) throw new ApiError(400, "VALIDATION", "expiryAt is required (ISO date)");
  if (expiryAt.getTime() <= Date.now()) throw new ApiError(400, "VALIDATION", "expiryAt must be in the future");
  if (startsAt && startsAt.getTime() >= expiryAt.getTime()) {
    throw new ApiError(400, "VALIDATION", "startsAt must be before expiryAt");
  }

  let discountMinor = 0;
  let percentOff: number | null = null;
  let maxDiscountMinor: number | null = null;
  let regionLimit: string | null = null;

  if (kind === "discount") {
    const hasFlat = body.discountMinor != null && body.discountMinor !== "";
    const hasPercent = body.percentOff != null && body.percentOff !== "";
    if (hasFlat === hasPercent) {
      throw new ApiError(400, "VALIDATION", "Provide exactly one of discountMinor (flat) or percentOff (1..90)");
    }
    if (hasFlat) {
      discountMinor = intOr(body.discountMinor, 0);
      if (discountMinor <= 0 || discountMinor > 100_000_000) {
        throw new ApiError(400, "VALIDATION", "discountMinor must be a positive integer (minor units)");
      }
    } else {
      const p = intOr(body.percentOff, 0);
      if (p < 1 || p > 90) throw new ApiError(400, "VALIDATION", "percentOff must be 1..90");
      percentOff = p;
      if (body.maxDiscountMinor != null && body.maxDiscountMinor !== "") {
        maxDiscountMinor = intOr(body.maxDiscountMinor, 0);
        if (maxDiscountMinor <= 0) throw new ApiError(400, "VALIDATION", "maxDiscountMinor must be a positive integer when provided");
      }
    }
  } else {
    // freeshipping — seller-funded, West-Malaysia-only by platform rule.
    regionLimit = "peninsular";
  }

  // Code: seller-supplied (normalized) or auto-generated; unique enforced.
  const rawCode = String(body.code ?? "").trim().toUpperCase();
  const candidates: string[] = [];
  if (rawCode) {
    if (!/^[A-Z0-9_-]{3,24}$/.test(rawCode)) {
      throw new ApiError(400, "VALIDATION", "code must be 3-24 chars (A-Z, 0-9, - or _)");
    }
    candidates.push(rawCode);
  } else {
    for (let i = 0; i < 5; i++) candidates.push(`${store.slug.slice(0, 2).toUpperCase()}-${genVoucherCode()}`);
  }
  let code = candidates[0];
  for (const c of candidates) {
    const exists = await db.voucher.findUnique({ where: { code: c } });
    if (!exists) {
      code = c;
      break;
    }
    if (rawCode) break; // seller-specified duplicate → 409 below
  }
  const dup = await db.voucher.findUnique({ where: { code } });
  if (dup) throw new ApiError(409, "CODE_TAKEN", "That voucher code already exists — pick another");

  const voucher = await db.voucher.create({
    data: {
      code,
      title,
      kind,
      discountMinor,
      percentOff,
      maxDiscountMinor,
      minSpendMinor,
      expiryAt,
      isActive: body.isActive == null ? true : Boolean(body.isActive),
      scope: "STORE",
      storeId: store.id,
      regionLimit,
      quota,
      startsAt,
    },
  });

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "voucher.created",
    entityType: "voucher",
    entityId: voucher.id,
    meta: { code: voucher.code, kind, storeSlug: store.slug, fsPriceAdjustMinor: store.fsPriceAdjustMinor },
  });

  return ok(
    {
      voucher: {
        id: voucher.id,
        code: voucher.code,
        title: voucher.title,
        kind: voucher.kind,
        discountMinor: voucher.discountMinor,
        percentOff: voucher.percentOff,
        maxDiscountMinor: voucher.maxDiscountMinor,
        minSpendMinor: voucher.minSpendMinor,
        expiryAt: voucher.expiryAt,
        startsAt: voucher.startsAt,
        isActive: voucher.isActive,
        scope: voucher.scope,
        regionLimit: voucher.regionLimit,
        quota: voucher.quota,
      },
    },
    { status: 201 }
  );
});
