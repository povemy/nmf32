// ============================================================================
// AFFILIATE HUB & ONE-LEVEL SPONSOR REFERRAL SYSTEM — core domain library.
// docs/affiliate/*.md are the authoritative design docs.
//
// COMMERCIAL MODEL (fixed, spec §1/§8):
//   • Seller-funded commission pool per eligible OrderItem: P = B × R (bps,
//     integer sen). The pool is carved OUT of seller proceeds at checkout
//     (sellerNet already subtracts it — see computeOrderCommissions).
//   • Split of the POOL: S = floor(P × 10 / 100) to the direct affiliate's
//     ONE-LEVEL sponsor; D = P − S to the direct affiliate. No sponsor ⇒
//     D = P, S = 0. D + S = P ALWAYS (never exceeds the pool).
//   • Attribution travels UP exactly one generation. No recruitment bonuses,
//     no click rewards, no registration rewards — liabilities only ever
//     originate from genuine eligible paid sales.
//
// INTEGRITY CONTRACTS:
//   • Pool snapshots freeze on OrderItem at checkout (commission contract).
//   • AffiliateCommission rows post EXACTLY ONCE per order item at payment
//     confirmation (unique orderItemId; duplicate webhooks are no-ops).
//   • The 90/10 SPLIT is computed at POSTING time from the then-current
//     sponsor-override flag + sponsor eligibility, then never rewritten —
//     so the override can be disabled without corrupting existing records.
//   • Every money mutation rides the immutable ledger (lib/ledger.ts).
// ============================================================================
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { randomToken } from "@/lib/password";
import { divHalfUp } from "@/lib/money";
import { getSession } from "@/lib/auth";
import { parseJson, toJson } from "@/lib/json";
import type { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// Settings (Setting rows, registry-rendered in admin System → Settings).
// Sandbox defaults keep the programme demonstrable; the PRODUCTION launch
// gate (docs/affiliate/rollout-checklist.md) requires explicitly reviewing
// affiliate.enabled / affiliate.sponsor_enabled before enabling live.
// ---------------------------------------------------------------------------
export const AFFILIATE_SETTING_KEYS = {
  enabled: "affiliate.enabled",
  sponsorEnabled: "affiliate.sponsor_enabled",
  maxRateBps: "affiliate.max_rate_bps",
  attrWindowDays: "affiliate.attr_window_days",
  sponsorWindowDays: "affiliate.sponsor_window_days",
  reviewDays: "affiliate.review_days",
  minPayoutMinor: "affiliate.min_payout_minor",
} as const;

export type AffiliateSettings = {
  enabled: boolean;
  sponsorEnabled: boolean;
  maxRateBps: number;
  attrWindowDays: number;
  sponsorWindowDays: number;
  reviewDays: number;
  minPayoutMinor: number;
};

const DEFAULTS: AffiliateSettings = {
  enabled: true,
  // FAIL-CLOSED production posture (docs/affiliate/rollout-checklist.md Gate 5):
  // the sponsor override stays OFF until legal clearance (DSA 1993 / KPDN) is
  // documented and an admin explicitly enables it in System → Settings.
  sponsorEnabled: false,
  maxRateBps: 1000, // 10% launch ceiling per commission-definitions.md
  attrWindowDays: 30,
  sponsorWindowDays: 30,
  reviewDays: 14,
  minPayoutMinor: 1000, // RM 10.00
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export async function getAffiliateSettings(): Promise<AffiliateSettings> {
  const rows = await db.setting.findMany({ where: { key: { in: Object.values(AFFILIATE_SETTING_KEYS) } } });
  const map = new Map(rows.map((r) => [r.key, r.valueJson]));
  const bool = (k: string, d: boolean) => {
    const v = parseJson<unknown>(map.get(k) ?? null, d);
    return typeof v === "boolean" ? v : d;
  };
  return {
    enabled: bool(AFFILIATE_SETTING_KEYS.enabled, DEFAULTS.enabled),
    sponsorEnabled: bool(AFFILIATE_SETTING_KEYS.sponsorEnabled, DEFAULTS.sponsorEnabled),
    maxRateBps: clampInt(parseJson<unknown>(map.get(AFFILIATE_SETTING_KEYS.maxRateBps) ?? null, DEFAULTS.maxRateBps), 0, 10000, DEFAULTS.maxRateBps),
    attrWindowDays: clampInt(parseJson<unknown>(map.get(AFFILIATE_SETTING_KEYS.attrWindowDays) ?? null, DEFAULTS.attrWindowDays), 1, 365, DEFAULTS.attrWindowDays),
    sponsorWindowDays: clampInt(parseJson<unknown>(map.get(AFFILIATE_SETTING_KEYS.sponsorWindowDays) ?? null, DEFAULTS.sponsorWindowDays), 1, 365, DEFAULTS.sponsorWindowDays),
    reviewDays: clampInt(parseJson<unknown>(map.get(AFFILIATE_SETTING_KEYS.reviewDays) ?? null, DEFAULTS.reviewDays), 0, 365, DEFAULTS.reviewDays),
    minPayoutMinor: clampInt(parseJson<unknown>(map.get(AFFILIATE_SETTING_KEYS.minPayoutMinor) ?? null, DEFAULTS.minPayoutMinor), 0, 10_000_000, DEFAULTS.minPayoutMinor),
  };
}

/** Effective seller affiliate rate (bps) for a product, honouring every gate.
 *  0 ⇒ not enrolled (no commission). Product override ?? store default,
 *  clamped to the platform max; programme master switch must be on. */
export function effectiveAffiliateRateBps(
  s: AffiliateSettings,
  store: { affiliateOptIn: boolean; affiliateDefaultRateBps: number },
  product: { affiliateEnabled: boolean; affiliateRateBps: number | null }
): number {
  if (!s.enabled || !store.affiliateOptIn || !product.affiliateEnabled) return 0;
  const rate = product.affiliateRateBps ?? store.affiliateDefaultRateBps;
  return Math.max(0, Math.min(rate, s.maxRateBps));
}

// ---------------------------------------------------------------------------
// Commission math — the spec's exact formulas (§8).
// ---------------------------------------------------------------------------
/** Pool P = B × R in integer sen, half-up rounding (platform convention). */
export function affiliatePoolMinor(baseMinor: number, rateBps: number): number {
  if (baseMinor <= 0 || rateBps <= 0) return 0;
  return divHalfUp(baseMinor * rateBps, 10000);
}

/** 90/10 split of the POOL: S = floor(P × 10 / 100); D = P − S (D + S = P). */
export function splitAffiliatePool(poolMinor: number): { directMinor: number; sponsorMinor: number } {
  if (poolMinor <= 0) return { directMinor: 0, sponsorMinor: 0 };
  const sponsorMinor = Math.floor((poolMinor * 10) / 100);
  return { directMinor: poolMinor - sponsorMinor, sponsorMinor };
}

// ---------------------------------------------------------------------------
// Identity & authorization.
// ---------------------------------------------------------------------------
export type AffiliateCtx = {
  id: string;
  userId: string;
  status: string;
  code: string;
  slug: string;
  displayName: string;
  bio: string | null;
  sponsorId: string | null;
};

/** Session → active affiliate profile. Throws 401/403 style ApiErrors. */
export async function requireAffiliate(): Promise<AffiliateCtx> {
  const sess = await getSession();
  if (!sess || sess.userType !== "shopper") {
    throw new ApiError(401, "UNAUTHORIZED", "Affiliate session required");
  }
  const profile = await db.affiliateProfile.findUnique({ where: { userId: sess.userId } });
  if (!profile) throw new ApiError(403, "NOT_AFFILIATE", "Activate your affiliate account first");
  if (profile.status === "suspended") {
    throw new ApiError(403, "AFFILIATE_SUSPENDED", "This affiliate account is suspended");
  }
  if (profile.status === "terminated") {
    throw new ApiError(403, "AFFILIATE_TERMINATED", "This affiliate account is terminated");
  }
  return {
    id: profile.id, userId: profile.userId, status: profile.status, code: profile.code,
    slug: profile.slug, displayName: profile.displayName, bio: profile.bio, sponsorId: profile.sponsorId,
  };
}

// ---------------------------------------------------------------------------
// Activation + one-level sponsor assignment (spec §4/§5).
// ---------------------------------------------------------------------------
export const AFFILIATE_TERMS_VERSION = 1;
const REFERRAL_COOKIE = "nm_aff_ref";

function slugifyAffiliate(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return base || "affiliate";
}

async function uniqueSlug(base: string): Promise<string> {
  let candidate = base;
  for (let i = 0; i < 20; i++) {
    const clash = await db.affiliateProfile.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!clash) return candidate;
    candidate = `${base}-${randomToken(2)}`;
  }
  return `aff-${randomToken(4)}`;
}

/** Read the FIRST-TOUCH referral cookie and validate it against the touch
 *  table (unexpired, unconsumed). Returns the sponsor profile or null. */
export async function resolveReferralCookie(): Promise<{ affiliateId: string; displayName: string; code: string } | null> {
  try {
    const store = await cookies();
    const raw = store.get(REFERRAL_COOKIE)?.value;
    if (!raw) return null;
    const parsed = parseJson<{ code?: string }>(raw, {});
    if (!parsed?.code) return null;
    const touch = await db.affiliateReferralTouch.findFirst({
      where: { code: parsed.code, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { touchedAt: "desc" },
      select: { affiliateId: true, code: true },
    });
    const profile = touch
      ? await db.affiliateProfile.findUnique({ where: { id: touch.affiliateId }, select: { id: true, displayName: true, code: true, status: true } })
      : null;
    if (!profile || profile.status !== "active") return null;
    return { affiliateId: profile.id, displayName: profile.displayName, code: profile.code };
  } catch {
    return null;
  }
}

/** Validate a sponsor candidate by referral code — used by activation (cookie
 *  touch OR one-time manual entry) and by the admin correction route. */
export async function findAffiliateByCode(code: string) {
  const normalized = code.trim().toLowerCase();
  if (!normalized) return null;
  const byCode = await db.affiliateProfile.findUnique({ where: { code: normalized } });
  if (byCode) return byCode;
  return null;
}

export type ActivationInput = {
  userId: string;
  email: string;
  fullName: string;
  displayName?: string;
  bio?: string;
  slug?: string;
  /** One-time manual sponsor code entry (only valid when NO referral touch). */
  sponsorCode?: string;
  /** Explicit confirmation that the sponsor relationship was shown & accepted. */
  sponsorConfirmed?: boolean;
};

/** Activate the current shopper as an affiliate. Idempotent (already-active →
 *  error with the existing profile). Sponsor precedence (spec §5):
 *  1. Valid first-touch referral cookie (30-day window, unconsumed);
 *  2. Else a one-time manual code entry — confirmed explicitly;
 *  3. Else no sponsor (recorded permanently as none).
 *  The relationship locks forever after activation: no click, seller or admin
 *  tool can casually change it (admin corrections are separately audited). */
export async function activateAffiliate(input: ActivationInput) {
  const settings = await getAffiliateSettings();
  if (!settings.enabled) {
    throw new ApiError(403, "AFFILIATE_DISABLED", "The affiliate programme is currently paused");
  }

  const existing = await db.affiliateProfile.findUnique({ where: { userId: input.userId } });
  if (existing) {
    throw new ApiError(409, "ALREADY_AFFILIATE", "This account is already an affiliate");
  }

  // ---- Sponsor resolution (server-side only) -----------------------------
  let sponsor: { id: string; displayName: string } | null = null;
  let sponsorSource: string | null = null;

  const touch = await resolveReferralCookie();
  if (touch) {
    const profile = await db.affiliateProfile.findUnique({ where: { id: touch.affiliateId } });
    if (profile && profile.status === "active" && profile.userId !== input.userId) {
      sponsor = { id: profile.id, displayName: profile.displayName };
      sponsorSource = "referral_touch";
    }
  }
  if (!sponsor && input.sponsorCode) {
    const candidate = await findAffiliateByCode(input.sponsorCode);
    if (!candidate) throw new ApiError(400, "INVALID_SPONSOR_CODE", "That referral code was not found");
    if (candidate.userId === input.userId) {
      throw new ApiError(400, "SELF_REFERRAL", "You cannot refer yourself");
    }
    if (candidate.status !== "active") {
      throw new ApiError(400, "SPONSOR_INACTIVE", "That sponsor is not currently eligible");
    }
    if (!input.sponsorConfirmed) {
      throw new ApiError(400, "SPONSOR_CONFIRMATION_REQUIRED", "Confirm the sponsor relationship before activating");
    }
    sponsor = { id: candidate.id, displayName: candidate.displayName };
    sponsorSource = "code_entry";
  }

  const code = randomToken(5); // 10-hex-char referral code, unpredictable
  const slug = await uniqueSlug(slugifyAffiliate(input.slug || input.displayName || input.fullName));

  const profile = await db.$transaction(async (tx) => {
    // Re-check inside the tx (concurrent double-submit).
    const dupe = await tx.affiliateProfile.findUnique({ where: { userId: input.userId } });
    if (dupe) throw new ApiError(409, "ALREADY_AFFILIATE", "This account is already an affiliate");

    const created = await tx.affiliateProfile.create({
      data: {
        userId: input.userId,
        code,
        slug,
        displayName: (input.displayName || input.fullName).slice(0, 60),
        bio: input.bio?.slice(0, 500) ?? null,
        status: "active",
        termsVersion: AFFILIATE_TERMS_VERSION,
        termsAcceptedAt: new Date(),
        activatedAt: new Date(),
        sponsorId: sponsor?.id ?? null,
        sponsorAssignedAt: sponsor ? new Date() : null,
        sponsorSource,
      },
    });

    // Consume the referral touch exactly once (relationship now recorded).
    if (sponsor && sponsorSource === "referral_touch" && touch) {
      await tx.affiliateReferralTouch.updateMany({
        where: { code: touch.code, consumedAt: null },
        data: { consumedAt: new Date(), consumedUserId: input.userId },
      });
    }
    return created;
  });

  return { profile, sponsor, sponsorSource };
}

/** Admin-only sponsor correction — audited, with documented reason. Cycle
 *  guard: with one-level relationships a 2-cycle (A↔B) is the only possible
 *  loop; rejecting `newSponsor.sponsorId === affiliateId` kills it. */
export async function correctSponsor(input: {
  affiliateId: string;
  newSponsorId: string | null;
  reason: string;
  adminId: string;
}) {
  if (!input.reason || input.reason.trim().length < 10) {
    throw new ApiError(400, "VALIDATION", "A documented reason (≥10 chars) is required for sponsor corrections");
  }
  const affiliate = await db.affiliateProfile.findUnique({ where: { id: input.affiliateId } });
  if (!affiliate) throw new ApiError(404, "NOT_FOUND", "Affiliate not found");
  if (input.newSponsorId === affiliate.id) {
    throw new ApiError(400, "SELF_REFERRAL", "An affiliate cannot sponsor themselves");
  }
  if (input.newSponsorId) {
    const sponsor = await db.affiliateProfile.findUnique({ where: { id: input.newSponsorId } });
    if (!sponsor) throw new ApiError(404, "NOT_FOUND", "New sponsor not found");
    if (sponsor.sponsorId === affiliate.id) {
      throw new ApiError(400, "SPONSOR_CYCLE", "This correction would create a sponsor cycle");
    }
  }
  return db.$transaction(async (tx) => {
    const updated = await tx.affiliateProfile.update({
      where: { id: input.affiliateId },
      data: {
        sponsorId: input.newSponsorId,
        sponsorAssignedAt: input.newSponsorId ? new Date() : null,
        sponsorSource: "admin_correction",
      },
    });
    await tx.affiliateSponsorAudit.create({
      data: {
        affiliateId: input.affiliateId,
        fromSponsorId: affiliate.sponsorId,
        toSponsorId: input.newSponsorId,
        reason: input.reason.trim(),
        actorType: "admin",
        actorId: input.adminId,
      },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Commission posting — called from the payment-confirmation transaction
// (webhooks/payments/process.ts). EXACTLY ONCE per order item.
// ---------------------------------------------------------------------------
type Tx = Prisma.TransactionClient;

/** Post AffiliateCommission rows for one paid order. Idempotent: unique
 *  orderItemId + find-first guard. Split computed HERE (posting time) from
 *  the then-current sponsor flag + sponsor eligibility. */
export async function postAffiliateCommissionsForOrder(
  tx: Tx,
  order: { id: string; orderNumber: string; storeId: string; items: { id: string; productId?: string | null; affiliateDirectId: string | null; affiliateSponsorId: string | null; affiliateLinkId: string | null; affiliateRateBps: number | null; affiliatePoolMinor: number; breakdownJson: string }[] },
  paidAt: Date
): Promise<number> {
  const attributed = order.items.filter((i) => i.affiliateDirectId && i.affiliatePoolMinor > 0);
  if (attributed.length === 0) return 0;

  const settings = await getAffiliateSettings();
  if (!settings.enabled) return 0; // kill switch: no NEW liabilities

  // Sponsor profiles snapshot (status at posting decides hold vs pending).
  const sponsorIds = [...new Set(attributed.map((i) => i.affiliateSponsorId).filter((s): s is string => Boolean(s)))];
  const sponsors = sponsorIds.length
    ? new Map((await tx.affiliateProfile.findMany({ where: { id: { in: sponsorIds } }, select: { id: true, status: true } })).map((p) => [p.id, p.status]))
    : new Map<string, string>();

  // Link metadata snapshot (linkType + channel for reporting — spec §14).
  const linkIds = [...new Set(attributed.map((i) => i.affiliateLinkId).filter((s): s is string => Boolean(s)))];
  const links = linkIds.length
    ? new Map((await tx.affiliateLink.findMany({ where: { id: { in: linkIds } }, select: { id: true, type: true, channel: true } })).map((l) => [l.id, l]))
    : new Map<string, { type: string; channel: string }>();

  let posted = 0;
  for (const item of attributed) {
    const existing = await tx.affiliateCommission.findUnique({ where: { orderItemId: item.id }, select: { id: true } });
    if (existing) continue; // idempotent replay

    const pool = item.affiliatePoolMinor;
    let sponsorMinor = 0;
    let sponsorHeld = false;
    if (item.affiliateSponsorId && settings.sponsorEnabled) {
      const status = sponsors.get(item.affiliateSponsorId) ?? "missing";
      if (status === "active") {
        sponsorMinor = Math.floor((pool * 10) / 100);
      } else {
        // Sponsor under review / gone: HOLD the 10% separately — the direct
        // promoter's 90% must NOT absorb it and must NOT be penalised.
        sponsorMinor = Math.floor((pool * 10) / 100);
        sponsorHeld = true;
      }
    }
    const directMinor = pool - sponsorMinor; // D + S = P always
    const bd = parseJson<{ base?: number }>(item.breakdownJson, {});

    const commission = await tx.affiliateCommission.create({
      data: {
        orderItemId: item.id,
        orderId: order.id,
        orderNumber: order.orderNumber,
        storeId: order.storeId,
        productId: item.productId ?? null,
        affiliateId: item.affiliateDirectId!,
        sponsorId: item.affiliateSponsorId ?? null,
        linkId: item.affiliateLinkId ?? null,
        linkType: item.affiliateLinkId ? (links.get(item.affiliateLinkId)?.type ?? null) : null,
        channel: item.affiliateLinkId ? (links.get(item.affiliateLinkId)?.channel ?? null) : null,
        commissionableBaseMinor: Math.max(0, bd.base ?? 0),
        rateBps: item.affiliateRateBps ?? 0,
        poolMinor: pool,
        status: "pending",
        breakdownJson: item.breakdownJson,
      },
    });

    await tx.affiliateCommissionEntry.create({
      data: {
        commissionId: commission.id,
        beneficiaryAffiliateId: item.affiliateDirectId!,
        role: "direct",
        amountMinor: directMinor,
        status: "pending",
      },
    });
    if (item.affiliateSponsorId && sponsorMinor > 0) {
      await tx.affiliateCommissionEntry.create({
        data: {
          commissionId: commission.id,
          beneficiaryAffiliateId: item.affiliateSponsorId,
          role: "sponsor",
          amountMinor: sponsorMinor,
          status: sponsorHeld ? "held" : "pending",
          holdReason: sponsorHeld ? "sponsor_under_review" : null,
        },
      });
    }
    posted++;
  }
  return posted;
}

// ---------------------------------------------------------------------------
// Lifecycle: pending → approved (order delivered/completed) → available
// (review window elapsed) → paid. Reversals from refunds. Holds from review.
// ---------------------------------------------------------------------------
/** Approve an order's pending entries (authoritative delivered/completed). */
export async function approveAffiliateCommissionsForOrder(orderId: string, tx?: Tx): Promise<number> {
  const client = tx ?? db;
  const commissions = await client.affiliateCommission.findMany({
    where: { orderId, status: "pending" },
    select: { id: true },
  });
  if (commissions.length === 0) return 0;
  const settings = await getAffiliateSettings();
  const now = new Date();
  const availableAt = new Date(now.getTime() + settings.reviewDays * 86400000);
  let approved = 0;
  for (const c of commissions) {
    const res = await client.affiliateCommissionEntry.updateMany({
      where: { commissionId: c.id, status: "pending" },
      data: { status: "approved", availableAt },
    });
    if (res.count > 0) {
      await client.affiliateCommission.update({ where: { id: c.id }, data: { status: "approved", approvedAt: now } });
      approved += res.count;
    }
  }
  return approved;
}

/** Batch sweep (cron): approve commissions on delivered/completed orders +
 *  mature approved entries whose review window elapsed. Bounded batches. */
export async function sweepAffiliateLifecycle(): Promise<{ approved: number; matured: number }> {
  const settings = await getAffiliateSettings();
  if (!settings.enabled) return { approved: 0, matured: 0 };

  // 1) Orders delivered/completed with pending commissions → approve.
  const pendingCommissions = await db.affiliateCommission.findMany({
    where: { status: "pending" },
    select: { orderId: true },
    distinct: ["orderId"],
    take: 50,
  });
  let approved = 0;
  if (pendingCommissions.length > 0) {
    const orderIds = pendingCommissions.map((c) => c.orderId);
    const eligible = await db.order.findMany({
      where: { id: { in: orderIds }, status: { in: ["delivered", "completed"] } },
      select: { id: true },
    });
    for (const o of eligible) {
      approved += await approveAffiliateCommissionsForOrder(o.id);
    }
  }

  // 2) Matured approved entries → available (clock transition, CAS-guarded).
  const now = new Date();
  const matured = await db.affiliateCommissionEntry.updateMany({
    where: { status: "approved", availableAt: { lte: now } },
    data: { status: "available" },
  });
  if (matured.count > 0) {
    await db.affiliateCommission.updateMany({
      where: { status: "approved", entries: { some: { status: "available" } } },
      data: { status: "available" },
    });
  }
  return { approved, matured: matured.count };
}

// ---------------------------------------------------------------------------
// Balances (affiliate-side truth = AffiliateCommissionEntry rows; the ledger
// mirrors totals on PLATFORM:AFFILIATE_LIABILITY for double-entry integrity).
// ---------------------------------------------------------------------------
export type AffiliateBalances = {
  pendingMinor: number;
  approvedMinor: number; // approved but review window not elapsed
  availableMinor: number; // matured, not yet claimed by a payout
  payoutInFlightMinor: number; // claimed by requested/processing payouts
  paidMinor: number;
  reversedMinor: number;
  heldMinor: number;
  recoveryMinor: number; // reversals booked against already-paid entries
  requestableMinor: number; // available − recovery, floored at 0
};

export async function affiliateBalances(affiliateId: string): Promise<AffiliateBalances> {
  const entries = await db.affiliateCommissionEntry.findMany({
    where: { beneficiaryAffiliateId: affiliateId },
    select: { status: true, amountMinor: true, reversedMinor: true, availableAt: true, payoutId: true },
  });
  const now = Date.now();
  const b: AffiliateBalances = {
    pendingMinor: 0, approvedMinor: 0, availableMinor: 0, payoutInFlightMinor: 0,
    paidMinor: 0, reversedMinor: 0, heldMinor: 0, recoveryMinor: 0, requestableMinor: 0,
  };
  for (const e of entries) {
    const matured = (e.availableAt?.getTime() ?? 0) <= now;
    switch (e.status) {
      case "pending":
      case "approved":
        if (e.status === "pending" || !matured) {
          if (e.status === "pending") b.pendingMinor += e.amountMinor - e.reversedMinor;
          else b.approvedMinor += e.amountMinor - e.reversedMinor;
          break;
        }
        // fallthrough: matured approved
      case "available":
        if (e.payoutId) b.payoutInFlightMinor += e.amountMinor - e.reversedMinor;
        else b.availableMinor += e.amountMinor - e.reversedMinor;
        break;
      case "paid":
        b.paidMinor += e.amountMinor;
        b.recoveryMinor += e.reversedMinor; // late refund after payout
        break;
      case "reversed":
        b.reversedMinor += e.amountMinor;
        break;
      case "held":
        b.heldMinor += e.amountMinor - e.reversedMinor;
        break;
    }
  }
  b.requestableMinor = Math.max(0, b.availableMinor - b.recoveryMinor);
  return b;
}

// ---------------------------------------------------------------------------
// Refund reversals — proportional against the ORIGINAL immutable allocations
// (spec §11). Shipping-only refunds book no product-commission reversal (the
// pool base excluded shipping by construction). Late refunds after payout
// become recovery entries: reversedMinor accumulates on the PAID entry and
// offsets future earnings — the original payout history is never rewritten.
// ---------------------------------------------------------------------------
export async function reverseAffiliateForRefund(
  tx: Tx,
  input: {
    refundId: string;
    orderId: string;
    refundAmountMinor: number;
    /** Fresh order items (with affiliate snapshots) under the lock. */
    items: { id: string; lineSubtotalMinor: number; refundedMinor: number; breakdownJson: string; affiliatePoolMinor: number }[];
    /** Σ affiliateReversalMinor of prior PROCESSED refunds on this order. */
    priorAffiliateReversalMinor: number;
  }
): Promise<{ affiliateReversalMinor: number; rule: string }> {
  const attributed = input.items.filter((i) => i.affiliatePoolMinor > 0);
  if (attributed.length === 0) return { affiliateReversalMinor: 0, rule: "no_affiliate" };

  // Customer-paid gross per item (breakdown-proportional, mirroring
  // deriveCommissionReversal's allocation family).
  const grossArr = attributed.map((it) => {
    const bd = parseJson<{ discount_allocated?: number; shipping_allocated?: number }>(it.breakdownJson, {});
    return Math.max(0, it.lineSubtotalMinor - (bd.discount_allocated ?? 0) + (bd.shipping_allocated ?? 0));
  });
  const allocs: number[] = [];
  {
    // floor + remainder-to-largest (same as allocateProportionally)
    const totalGross = grossArr.reduce((s, v) => s + v, 0);
    if (totalGross <= 0) {
      attributed.forEach(() => allocs.push(0));
    } else {
      let allocated = 0;
      for (let i = 0; i < attributed.length; i++) {
        const a = Math.floor((input.refundAmountMinor * grossArr[i]) / totalGross);
        allocs.push(a);
        allocated += a;
      }
      let rem = input.refundAmountMinor - allocated;
      while (rem > 0) {
        let maxIdx = 0;
        for (let i = 1; i < grossArr.length; i++) if (grossArr[i] > grossArr[maxIdx]) maxIdx = i;
        allocs[maxIdx] += 1;
        rem -= 1;
      }
    }
  }

  // Per-item affiliate reversal, clamped to the remaining reversible pool.
  const orderPool = attributed.reduce((s, it) => s + it.affiliatePoolMinor, 0);
  const remainingReversible = Math.max(0, orderPool - input.priorAffiliateReversalMinor);
  let total = 0;
  const perItem: { item: (typeof attributed)[number]; reversal: number }[] = [];
  for (let i = 0; i < attributed.length; i++) {
    if (grossArr[i] <= 0 || allocs[i] <= 0) {
      perItem.push({ item: attributed[i], reversal: 0 });
      continue;
    }
    const r = Math.min(divHalfUp(allocs[i] * attributed[i].affiliatePoolMinor, grossArr[i]), attributed[i].affiliatePoolMinor);
    perItem.push({ item: attributed[i], reversal: r });
    total += r;
  }
  total = Math.min(Math.max(0, total), input.refundAmountMinor, remainingReversible);

  // Apply to the commission + entries (proportional split within each pool).
  if (total > 0) {
    // Scale per-item reversals down proportionally if the clamp reduced total.
    const rawTotal = perItem.reduce((s, p) => s + p.reversal, 0);
    const scale = rawTotal > 0 ? total / rawTotal : 0;
    let applied = 0;
    for (const p of perItem) {
      const itemReversal = p.reversal === 0 ? 0 : Math.min(p.reversal, Math.round(p.reversal * scale));
      if (itemReversal <= 0) continue;
      const commission = await tx.affiliateCommission.findUnique({ where: { orderItemId: p.item.id }, include: { entries: true } });
      if (!commission) continue; // pre-affiliate legacy rows: nothing to reverse
      const direct = commission.entries.find((e) => e.role === "direct");
      const sponsor = commission.entries.find((e) => e.role === "sponsor");
      // Split proportionally to the frozen allocation shares.
      const directShare = direct ? Math.min(direct.amountMinor - direct.reversedMinor, divHalfUp(itemReversal * direct.amountMinor, commission.poolMinor)) : 0;
      const sponsorShare = sponsor ? Math.min(sponsor.amountMinor - sponsor.reversedMinor, itemReversal - directShare) : 0;
      for (const [entry, share] of [[direct, directShare], [sponsor, sponsorShare]] as const) {
        if (!entry || share <= 0) continue;
        const newReversed = Math.min(entry.amountMinor, entry.reversedMinor + share);
        const fullyReversed = newReversed >= entry.amountMinor;
        await tx.affiliateCommissionEntry.update({
          where: { id: entry.id },
          data: {
            reversedMinor: newReversed,
            // PAID entries stay paid — the reversal is a recovery entry that
            // offsets future earnings (spec §11 late refunds); pending/
            // approved/available entries flip to reversed.
            ...(entry.status !== "paid" && fullyReversed ? { status: "reversed" as const } : {}),
          },
        });
      }
      const anyLive = commission.entries.some((e) => e.status !== "reversed");
      if (!anyLive) {
        await tx.affiliateCommission.update({
          where: { id: commission.id },
          data: { status: "reversed", reversedAt: new Date() },
        });
      }
      applied += itemReversal;
    }
    void applied;
  }

  return { affiliateReversalMinor: total, rule: "breakdown_snapshot_proportional" };
}
export async function requestAffiliatePayout(affiliateId: string): Promise<{ payoutId: string; amountMinor: number }> {
  const settings = await getAffiliateSettings();
  if (!settings.enabled) throw new ApiError(403, "AFFILIATE_DISABLED", "The affiliate programme is currently paused");

  return db.$transaction(async (tx) => {
    // One open request per affiliate — re-checked INSIDE the transaction so a
    // concurrent double-submit cannot create two claims.
    const open = await tx.affiliatePayout.findFirst({
      where: { affiliateId, status: { in: ["requested", "processing"] } },
      select: { id: true },
    });
    if (open) throw new ApiError(409, "PAYOUT_OPEN", "You already have a payout request in progress");

    const balances = await affiliateBalances(affiliateId);
    if (balances.requestableMinor < settings.minPayoutMinor) {
      throw new ApiError(400, "BELOW_MIN_PAYOUT", `Minimum payout is RM ${(settings.minPayoutMinor / 100).toFixed(2)}`);
    }

    const amountMinor = balances.requestableMinor;
    const now = new Date();
    // Claim every matured, unclaimed entry; bind to the payout row we create.
    const toClaim = await tx.affiliateCommissionEntry.findMany({
      where: {
        beneficiaryAffiliateId: affiliateId,
        status: { in: ["approved", "available"] },
        availableAt: { lte: now },
        payoutId: null,
      },
      select: { id: true, amountMinor: true, reversedMinor: true, commissionId: true },
    });
    const payout = await tx.affiliatePayout.create({
      data: { affiliateId, amountMinor, status: "requested", method: "manual_bank" },
    });
    if (toClaim.length > 0) {
      await tx.affiliateCommissionEntry.updateMany({
        where: { id: { in: toClaim.map((e) => e.id) } },
        data: { payoutId: payout.id },
      });
    }
    // Ledger-derived statement (schema contract: built from entries at
    // request time, never hand-edited) — order references + balance snapshot.
    const orderRefs = toClaim.length
      ? await tx.affiliateCommission.findMany({
          where: { id: { in: [...new Set(toClaim.map((e) => e.commissionId))] } },
          select: { id: true, orderNumber: true, productId: true, storeId: true },
        })
      : [];
    const refMap = new Map(orderRefs.map((c) => [c.id, c]));
    await tx.affiliatePayout.update({
      where: { id: payout.id },
      data: {
        statementJson: toJson({
          builtAt: now.toISOString(),
          balances: balances,
          entries: toClaim.map((e) => ({
            entryId: e.id,
            commissionId: e.commissionId,
            orderNumber: refMap.get(e.commissionId)?.orderNumber ?? null,
            amountMinor: e.amountMinor,
            reversedMinor: e.reversedMinor,
          })),
        }),
      },
    });
    return { payoutId: payout.id, amountMinor };
  });
}
