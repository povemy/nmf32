// ============================================================================
// CLAIMABLE VOUCHER ENGINE (Task 10-b) — verdict + redemption primitives.
//
// Kinds (platform-wide): "discount" (flat discountMinor XOR percentOff with an
// optional maxDiscountMinor cap) and "freeshipping" (zeroes the parcel's
// shipping for the seller group it applies to; seller-funded FS cost-recovery
// is recorded on Store.fsPriceAdjustMinor). "coinsback" is INVALID platform-
// wide — the buyer finance suite is dormant (src/lib/feature-flags.ts
// NOMO_FINANCE_ENABLED=false) and must never validate or surface.
//
// Money = integer minor units (cents). All math is integer-safe: percent
// discounts are floored, caps applied, final discount never exceeds the group
// subtotal, so a group total can never go negative.
//
// Quota semantics (per recovery spec): Voucher.quota is the total REDEEMABLE
// pool. claimedCount only increments when a held voucher is redeemed on an
// order (checkout/create) — claiming checks claimedCount >= quota for
// QUOTA_EXHAUSTED, and validate() rejects fully-redeemed vouchers.
// ============================================================================
import { db } from "./db";
import { ApiError } from "./api";

// PHASE 2 / A2: precise row type for the batched wallet read in
// buildVoucherOutcomes (userVoucher + voucher + store.fsPriceAdjustMinor —
// the same include shape the per-entry resolver used).
type UserVoucherWithVoucher = Awaited<
  ReturnType<
    typeof db.userVoucher.findMany<{
      include: { voucher: { include: { store: { select: { fsPriceAdjustMinor: true } } } } };
    }>
  >
>[number];

export type VoucherKind = "discount" | "freeshipping";

export const SUPPORTED_VOUCHER_KINDS: readonly string[] = ["discount", "freeshipping"];

// ---------------------------------------------------------------------------
// Malaysian address regions — regionLimit="peninsular" (West Malaysia only).
// ---------------------------------------------------------------------------
const PENINSULAR_KEYS = new Set([
  "johor",
  "kedah",
  "kelantan",
  "malacca",
  "melaka",
  "negerisembilan",
  "pahang",
  "penang",
  "pulaupinang",
  "perak",
  "perlis",
  "selangor",
  "terengganu",
  "kualalumpur",
  "kl",
  "putrajaya",
]);

const EAST_MALAYSIA_KEYS = new Set(["sabah", "sarawak", "labuan"]);

// ---------------------------------------------------------------------------
// Seller voucher input parsing — the shared validator for CREATE (route body)
// and EDIT (merged onto current values). Mirrors the create-route rules so an
// edit can never produce a row the create path would have rejected.
// ---------------------------------------------------------------------------

export type SellerVoucherInput = {
  title: string;
  kind: VoucherKind;
  discountMinor: number;
  percentOff: number | null;
  maxDiscountMinor: number | null;
  minSpendMinor: number;
  expiryAt: Date;
  quota: number | null;
  regionLimit: string | null;
};

function intOrU(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function dateOrU(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Validate + normalize a seller-scope voucher payload (create OR merged edit
 *  state). Throws ApiError(400, "VALIDATION") on any rule violation — exactly
 *  the create-route semantics, so both paths share one source of truth. */
export function parseSellerVoucherInput(body: Record<string, unknown>): SellerVoucherInput {
  const title = String(body.title ?? "").trim();
  if (title.length < 3 || title.length > 80) {
    throw new ApiError(400, "VALIDATION", "title must be 3-80 characters");
  }
  const kind = String(body.kind ?? "discount") as VoucherKind;
  if (!SUPPORTED_VOUCHER_KINDS.includes(kind)) {
    throw new ApiError(400, "VALIDATION", "kind must be discount | freeshipping (coinsback is disabled platform-wide)");
  }

  const minSpendMinor = intOrU(body.minSpendMinor ?? 0, 0);
  if (minSpendMinor < 0 || minSpendMinor > 100_000_000) {
    throw new ApiError(400, "VALIDATION", "minSpendMinor must be a non-negative integer (minor units)");
  }
  const quota = body.quota != null && body.quota !== "" ? intOrU(body.quota, 0) : null;
  if (quota != null && (quota < 1 || quota > 1_000_000)) {
    throw new ApiError(400, "VALIDATION", "quota must be a positive integer when provided");
  }
  const expiryAt = dateOrU(body.expiryAt);
  if (!expiryAt) throw new ApiError(400, "VALIDATION", "expiryAt is required (ISO date)");
  if (expiryAt.getTime() <= Date.now()) throw new ApiError(400, "VALIDATION", "expiryAt must be in the future");

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
      discountMinor = intOrU(body.discountMinor, 0);
      if (discountMinor <= 0 || discountMinor > 100_000_000) {
        throw new ApiError(400, "VALIDATION", "discountMinor must be a positive integer (minor units)");
      }
    } else {
      const p = intOrU(body.percentOff, 0);
      if (p < 1 || p > 90) throw new ApiError(400, "VALIDATION", "percentOff must be 1..90");
      percentOff = p;
      if (body.maxDiscountMinor != null && body.maxDiscountMinor !== "") {
        maxDiscountMinor = intOrU(body.maxDiscountMinor, 0);
        if (maxDiscountMinor <= 0) throw new ApiError(400, "VALIDATION", "maxDiscountMinor must be a positive integer when provided");
      }
    }
  } else {
    // freeshipping — seller-funded, West-Malaysia-only by platform rule.
    regionLimit = "peninsular";
  }

  return { title, kind, discountMinor, percentOff, maxDiscountMinor, minSpendMinor, expiryAt, quota, regionLimit };
}

/** Normalize a free-text Malaysian state into a comparable key. */
function stateKey(state: string | null | undefined): string {
  return (state ?? "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/** "peninsular" | "east-malaysia" | "unknown" for a delivery state. */
export function stateRegion(state: string | null | undefined): "peninsular" | "east-malaysia" | "unknown" {
  const key = stateKey(state);
  if (PENINSULAR_KEYS.has(key)) return "peninsular";
  if (EAST_MALAYSIA_KEYS.has(key)) return "east-malaysia";
  return "unknown";
}

/** True when the address is West Malaysia (Peninsular) — used by FS vouchers. */
export function isPeninsularState(state: string | null | undefined): boolean {
  return stateRegion(state) === "peninsular";
}

// ---------------------------------------------------------------------------
// Verdict engine
// ---------------------------------------------------------------------------

/** Minimal structural type — accepts a Prisma Voucher row (plus optional store). */
export type VoucherLike = {
  id: string;
  code: string;
  title: string;
  kind: string;
  discountMinor: number;
  percentOff: number | null;
  maxDiscountMinor: number | null;
  minSpendMinor: number;
  expiryAt: Date;
  startsAt: Date | null;
  isActive: boolean;
  scope: string;
  storeId: string | null;
  regionLimit: string | null;
  quota: number | null;
  claimedCount: number;
  store?: { fsPriceAdjustMinor: number } | null;
};

export type VoucherVerdict = {
  valid: boolean;
  reason: string | null;
  kind: string;
  /** Applied discount for the group (0 for freeshipping / invalid verdicts). */
  discountMinor: number;
  /** True when a freeshipping voucher zeroes the group shipping. */
  freeShipping: boolean;
  /** Seller-funded FS cost-recovery option (FS vouchers with a store only). */
  fsPriceAdjustMinor: number | null;
};

export function invalidVerdict(kind: string, reason: string): VoucherVerdict {
  return { valid: false, reason, kind, discountMinor: 0, freeShipping: false, fsPriceAdjustMinor: null };
}

/** Integer-safe discount for a "discount" voucher against a subtotal. */
export function voucherDiscountMinor(v: VoucherLike, subtotalMinor: number): number {
  if (v.kind !== "discount") return 0;
  let raw: number;
  if (v.percentOff != null) {
    raw = Math.floor((subtotalMinor * Math.min(90, Math.max(1, v.percentOff))) / 100);
    if (v.maxDiscountMinor != null) raw = Math.min(raw, v.maxDiscountMinor);
  } else {
    raw = v.discountMinor;
  }
  return Math.max(0, Math.min(raw, subtotalMinor));
}

/** Core verdict — pure over the voucher row + group facts (no DB access).
 *  Order of checks gives deterministic, shopper-friendly reasons. */
export function validateVoucher(
  voucher: VoucherLike,
  groupSubtotalMinor: number,
  addressState: string | null | undefined,
  storeId?: string | null,
  now: Date = new Date()
): VoucherVerdict {
  if (!SUPPORTED_VOUCHER_KINDS.includes(voucher.kind)) {
    // coinsback (and anything unknown) is disabled platform-wide.
    return invalidVerdict(voucher.kind, voucher.kind === "coinsback" ? "Coins-back vouchers are not available right now" : "This voucher type is not supported");
  }
  if (!voucher.isActive) return invalidVerdict(voucher.kind, "This voucher is no longer active");
  if (voucher.startsAt && voucher.startsAt.getTime() > now.getTime()) {
    return invalidVerdict(voucher.kind, "This voucher is not open for use yet");
  }
  if (voucher.expiryAt.getTime() < now.getTime()) return invalidVerdict(voucher.kind, "This voucher has expired");
  if (voucher.quota != null && voucher.claimedCount >= voucher.quota) {
    return invalidVerdict(voucher.kind, "This voucher has been fully redeemed");
  }
  if (voucher.scope === "STORE") {
    if (!voucher.storeId || voucher.storeId !== storeId) {
      return invalidVerdict(voucher.kind, "This voucher is only valid at its seller's store");
    }
  }
  if (voucher.minSpendMinor > groupSubtotalMinor) {
    const rm = (voucher.minSpendMinor / 100).toFixed(2);
    return invalidVerdict(voucher.kind, `Minimum spend RM ${rm} not met`);
  }
  if (voucher.kind === "freeshipping" && voucher.regionLimit === "peninsular") {
    const region = stateRegion(addressState);
    if (region === "east-malaysia") {
      return invalidVerdict(voucher.kind, "Free shipping applies to West Malaysia addresses only");
    }
    if (region === "unknown") {
      return invalidVerdict(voucher.kind, "Choose a West Malaysia delivery address to use this free-shipping voucher");
    }
  }
  if (voucher.kind === "discount") {
    return {
      valid: true,
      reason: null,
      kind: voucher.kind,
      discountMinor: voucherDiscountMinor(voucher, groupSubtotalMinor),
      freeShipping: false,
      fsPriceAdjustMinor: null,
    };
  }
  // freeshipping — zeroes the group's parcel cost; surface the seller's FS
  // cost-recovery option (seller-funded v1) for transparency.
  return {
    valid: true,
    reason: null,
    kind: voucher.kind,
    discountMinor: 0,
    freeShipping: true,
    fsPriceAdjustMinor: voucher.store?.fsPriceAdjustMinor ?? null,
  };
}

// ---------------------------------------------------------------------------
// Wallet resolution (quote + create share this)
// ---------------------------------------------------------------------------

export type VoucherEntryInput = { storeId: string; userVoucherId: string };

export type GroupVoucherOutcome = {
  storeId: string;
  userVoucherId: string;
  valid: boolean;
  reason: string | null;
  code: string | null;
  title: string | null;
  kind: string | null;
  /** Discount actually applied to the group (already capped at subtotal). */
  discountMinor: number;
  /** True when FS zeroed the group shipping. */
  freeShipping: boolean;
  /** Seller-funded FS cost-recovery option (informational, v1). */
  fsPriceAdjustMinor: number | null;
};

const failOutcome = (e: VoucherEntryInput, reason: string): GroupVoucherOutcome => ({
  storeId: e.storeId,
  userVoucherId: e.userVoucherId,
  valid: false,
  reason,
  code: null,
  title: null,
  kind: null,
  discountMinor: 0,
  freeShipping: false,
  fsPriceAdjustMinor: null,
});

/** Load a shopper's held voucher and run the verdict for one seller group.
 *  Soft: never throws for unusable vouchers — returns an invalid outcome with
 *  the reason so the quote UI can render it. */
export async function resolveUserVoucherForGroup(input: {
  userVoucherId: string;
  shopperId: string;
  storeId: string;
  groupSubtotalMinor: number;
  addressState: string | null | undefined;
}): Promise<{ userVoucherId: string; voucher: VoucherLike; status: string; verdict: VoucherVerdict } | { error: string }> {
  const uv = await db.userVoucher.findFirst({
    where: { id: input.userVoucherId, userId: input.shopperId },
    include: { voucher: { include: { store: { select: { fsPriceAdjustMinor: true } } } } },
  });
  if (!uv) return { error: "That voucher is not in your wallet" };
  if (uv.status === "USED") return { error: "That voucher has already been used" };
  if (uv.status === "EXPIRED") return { error: "That voucher has expired" };
  if (uv.status !== "AVAILABLE") return { error: "That voucher is not available for use" };
  const verdict = validateVoucher(uv.voucher, input.groupSubtotalMinor, input.addressState, input.storeId);
  return { userVoucherId: uv.id, voucher: uv.voucher, status: uv.status, verdict };
}

/** Apply per-group voucher entries on top of the group pricing engine.
 *  Effects: discount → group discountMinor += voucher discount (capped so
 *  discount ≤ subtotal); freeshipping → group shippingMinor = 0. Nothing is
 *  persisted here — redemption happens atomically at checkout/create. */
export function applyVoucherOutcomesToGroups<G extends { storeId: string; subtotalMinor: number; discountMinor: number; shippingMinor: number; totalMinor: number }>(
  groups: G[],
  outcomes: Array<{ storeId: string; valid: boolean; discountMinor: number; freeShipping: boolean }>
): { groups: G[]; totals: { subtotalMinor: number; discountMinor: number; shippingMinor: number; totalMinor: number } } {
  const byStore = new Map<string, { valid: boolean; discountMinor: number; freeShipping: boolean }>();
  for (const o of outcomes) {
    if (!byStore.has(o.storeId)) byStore.set(o.storeId, o); // first entry per store wins
  }
  const adjusted = groups.map((g) => {
    const o = byStore.get(g.storeId);
    if (!o || !o.valid) return g;
    const discountMinor = Math.min(g.discountMinor + Math.max(0, o.discountMinor), g.subtotalMinor);
    const shippingMinor = o.freeShipping ? 0 : g.shippingMinor;
    return { ...g, discountMinor, shippingMinor, totalMinor: Math.max(0, g.subtotalMinor - discountMinor + shippingMinor) };
  });
  const sum = (fn: (g: G) => number) => adjusted.reduce((s, g) => s + fn(g), 0);
  const subtotalMinor = sum((g) => g.subtotalMinor);
  const discountMinor = sum((g) => g.discountMinor);
  const shippingMinor = sum((g) => g.shippingMinor);
  return { groups: adjusted, totals: { subtotalMinor, discountMinor, shippingMinor, totalMinor: Math.max(0, subtotalMinor - discountMinor + shippingMinor) } };
}

/** Build outcomes for a checkout (quote or create) from voucher entries.
 *  `hard` (create): unknown/owned/unusable entries throw 409-style ApiErrors —
 *  the buyer must re-quote instead of silently losing their voucher.
 *
 *  PHASE 2 / A2: the per-entry wallet lookups (previously one sequential
 *  `userVoucher.findFirst` per entry) are batched into ONE `findMany` for the
 *  whole entry list — same rows (ids are unique; the userId filter is
 *  identical), same per-entry verdict math, same error order. */
export async function buildVoucherOutcomes(input: {
  entries: VoucherEntryInput[] | undefined | null;
  shopperId: string | null;
  groups: Array<{ storeId: string; subtotalMinor: number }>;
  addressState: string | null | undefined;
  hard?: boolean;
}): Promise<GroupVoucherOutcome[]> {
  const entries = Array.isArray(input.entries) ? input.entries : [];
  const outcomes: GroupVoucherOutcome[] = [];

  // Batched wallet read: one round-trip for every entry's userVoucher row.
  // Semantics identical to the previous per-entry findFirst({ id, userId }):
  // rows not owned by this shopper simply don't come back ("not in your wallet").
  const wantedIds = entries
    .map((e) => String(e?.userVoucherId ?? ""))
    .filter((id) => id.length > 0);
  const uvById = new Map<string, UserVoucherWithVoucher>();
  if (wantedIds.length > 0 && input.shopperId) {
    const rows = await db.userVoucher.findMany({
      where: { id: { in: [...new Set(wantedIds)] }, userId: input.shopperId },
      include: { voucher: { include: { store: { select: { fsPriceAdjustMinor: true } } } } },
    });
    for (const r of rows) uvById.set(r.id, r);
  }

  for (const entry of entries) {
    const storeId = String(entry.storeId ?? "");
    const userVoucherId = String(entry.userVoucherId ?? "");
    if (!storeId || !userVoucherId) {
      if (input.hard) throw new ApiError(400, "VALIDATION", "Each voucher needs storeId and userVoucherId");
      outcomes.push(failOutcome(entry, "Voucher selection is incomplete"));
      continue;
    }
    const group = input.groups.find((g) => g.storeId === storeId);
    if (!group) {
      if (input.hard) throw new ApiError(400, "VALIDATION", "A selected voucher seller is not part of this checkout");
      outcomes.push(failOutcome({ storeId, userVoucherId }, "That seller is not part of this checkout"));
      continue;
    }
    if (!input.shopperId) {
      outcomes.push(failOutcome({ storeId, userVoucherId }, "Sign in to use your vouchers"));
      continue;
    }
    // In-memory equivalent of resolveUserVoucherForGroup's lookup + status gates.
    const uv = uvById.get(userVoucherId);
    if (!uv) {
      const err = "That voucher is not in your wallet";
      if (input.hard) throw new ApiError(409, "VOUCHER_INVALID", err);
      outcomes.push(failOutcome({ storeId, userVoucherId }, err));
      continue;
    }
    if (uv.status === "USED") {
      const err = "That voucher has already been used";
      if (input.hard) throw new ApiError(409, "VOUCHER_INVALID", err);
      outcomes.push(failOutcome({ storeId, userVoucherId }, err));
      continue;
    }
    if (uv.status === "EXPIRED") {
      const err = "That voucher has expired";
      if (input.hard) throw new ApiError(409, "VOUCHER_INVALID", err);
      outcomes.push(failOutcome({ storeId, userVoucherId }, err));
      continue;
    }
    if (uv.status !== "AVAILABLE") {
      const err = "That voucher is not available for use";
      if (input.hard) throw new ApiError(409, "VOUCHER_INVALID", err);
      outcomes.push(failOutcome({ storeId, userVoucherId }, err));
      continue;
    }
    const verdict = validateVoucher(uv.voucher, group.subtotalMinor, input.addressState, storeId);
    if (!verdict.valid) {
      if (input.hard) throw new ApiError(409, "VOUCHER_INVALID", verdict.reason ?? "This voucher cannot be used");
      outcomes.push(failOutcome({ storeId, userVoucherId }, verdict.reason ?? "This voucher cannot be used"));
      continue;
    }
    outcomes.push({
      storeId,
      userVoucherId,
      valid: true,
      reason: null,
      code: uv.voucher.code,
      title: uv.voucher.title,
      kind: uv.voucher.kind,
      discountMinor: verdict.discountMinor,
      freeShipping: verdict.freeShipping,
      fsPriceAdjustMinor: verdict.fsPriceAdjustMinor,
    });
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Claim (shared by POST /api/me/vouchers and POST /api/me/vouchers/claim)
// ---------------------------------------------------------------------------

export type ClaimResult = {
  userVoucher: { id: string; status: string; claimedAt: Date };
  voucher: { id: string; code: string; title: string; kind: string; expiryAt: Date; scope: string };
};

/** Claim a pool voucher for a shopper by code or voucherId.
 *  404 unknown/inactive/expired/not-started · 409 ALREADY_HELD · 409 QUOTA_EXHAUSTED. */
export async function claimVoucherForShopper(shopperId: string, ref: { code?: string | null; voucherId?: string | null }): Promise<ClaimResult> {
  const code = (ref.code ?? "").trim().toUpperCase();
  const voucherId = (ref.voucherId ?? "").trim();
  if (!code && !voucherId) throw new ApiError(400, "VALIDATION", "A voucher code or voucherId is required");

  const voucher = code
    ? await db.voucher.findUnique({ where: { code } })
    : await db.voucher.findUnique({ where: { id: voucherId } });
  if (!voucher || !voucher.isActive) {
    throw new ApiError(404, "NOT_FOUND", "That voucher does not exist or is no longer available");
  }
  const now = new Date();
  if (voucher.expiryAt.getTime() < now.getTime()) {
    throw new ApiError(404, "NOT_FOUND", "That voucher has expired");
  }
  if (voucher.startsAt && voucher.startsAt.getTime() > now.getTime()) {
    throw new ApiError(404, "NOT_FOUND", "That voucher is not open for claims yet");
  }
  if (!SUPPORTED_VOUCHER_KINDS.includes(voucher.kind)) {
    throw new ApiError(404, "NOT_FOUND", "That voucher is not available");
  }
  if (voucher.scope === "STORE") {
    const store = voucher.storeId ? await db.store.findUnique({ where: { id: voucher.storeId }, select: { status: true } }) : null;
    if (!store || store.status !== "live") {
      throw new ApiError(404, "NOT_FOUND", "That voucher's store is no longer available");
    }
  }
  if (voucher.quota != null && voucher.claimedCount >= voucher.quota) {
    throw new ApiError(409, "QUOTA_EXHAUSTED", "All claims for this voucher have been redeemed");
  }

  const held = await db.userVoucher.findUnique({
    where: { userId_voucherId: { userId: shopperId, voucherId: voucher.id } },
  });
  if (held) throw new ApiError(409, "ALREADY_HELD", "You already have this voucher");

  try {
    const row = await db.userVoucher.create({
      data: { userId: shopperId, voucherId: voucher.id, status: "AVAILABLE" },
    });
    return {
      userVoucher: { id: row.id, status: row.status, claimedAt: row.claimedAt },
      voucher: {
        id: voucher.id,
        code: voucher.code,
        title: voucher.title,
        kind: voucher.kind,
        expiryAt: voucher.expiryAt,
        scope: voucher.scope,
      },
    };
  } catch (e) {
    // Race on @@unique([userId, voucherId]) — treat as already held.
    if (typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "P2002") {
      throw new ApiError(409, "ALREADY_HELD", "You already have this voucher");
    }
    throw e;
  }
}
