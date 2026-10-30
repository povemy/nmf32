// ============================================================================
// AFFILIATE ATTRIBUTION — last eligible click wins, per PRODUCT, 30-day
// window, first-party + server-validated (spec §6).
//
// FLOW:
//   1. Visitor opens a promotional link `/?al={code}` → the shell calls
//      POST /api/affiliate/track {code} → resolveAffiliateLink() validates
//      the link (active, owned by an active affiliate, target exists),
//      records an AffiliateAttributionTouch keyed by the httpOnly visitor
//      cookie (nm_ins_vid — same identity the analytics stack uses), and
//      sets the advisory `nm_aff_last` cookie for event tagging.
//   2. At CHECKOUT CREATION, resolveAffiliateAttributionForCart() reads the
//      visitor cookie server-side and finds the LATEST unexpired touch whose
//      scope covers each cart line's product:
//        - product link  → productId match
//        - store link    → storeId match (scope = that store)
//        - collection    → scopeProductIds snapshot contains the product
//      Self-purchases (the affiliate's own account) are excluded here.
//   3. The resolved {affiliateId, sponsorId, linkId, rateBps} snapshot is
//      frozen onto OrderItem columns with the pool — never recomputed.
//
// SECURITY: the client NEVER supplies affiliate ids for money decisions —
// only the opaque link code, which is resolved server-side. Touches are
// keyed to the server-set httpOnly visitor cookie, not to client input.
// ============================================================================
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { randomToken } from "@/lib/password";
import { parseJson } from "@/lib/json";
import { getAffiliateSettings, effectiveAffiliateRateBps, affiliatePoolMinor } from "./affiliate";
import { resolveInsightsIdentity } from "./analytics/identity";

export const AFFILIATE_LAST_COOKIE = "nm_aff_last"; // advisory event tagging
export const ATTRIBUTION_POLICY = "v1:lc30d";

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "none" as const,
  secure: true,
  path: "/",
};

export type ResolvedAffiliateLink = {
  link: {
    id: string;
    type: string;
    code: string;
    channel: string;
    affiliateId: string;
    productId: string | null;
    storeId: string | null;
    collectionId: string | null;
  };
  affiliate: { id: string; displayName: string; slug: string };
  /** Client navigation target for the shell. */
  target:
    | { kind: "product"; storeSlug: string; productSlug: string }
    | { kind: "store"; storeSlug: string }
    | { kind: "collection"; collectionSlug: string }
    | { kind: "showcase"; affiliateSlug: string };
};

/** Resolve a promotional link code and record the attribution touch.
 *  Rate-limited at the route. Returns the navigation target + who shared it. */
export async function resolveAffiliateLink(code: string): Promise<ResolvedAffiliateLink> {
  const settings = await getAffiliateSettings();
  const normalized = code.trim().toLowerCase();
  if (!normalized || !/^[a-f0-9-]{6,32}$/i.test(normalized)) {
    throw new ApiError(404, "LINK_NOT_FOUND", "This link is not valid");
  }
  const link = await db.affiliateLink.findUnique({ where: { code: normalized } });
  if (!link || link.status !== "active") throw new ApiError(404, "LINK_NOT_FOUND", "This link is not valid");

  const affiliate = await db.affiliateProfile.findUnique({ where: { id: link.affiliateId } });
  if (!affiliate || affiliate.status !== "active") {
    throw new ApiError(404, "LINK_NOT_FOUND", "This link is not valid");
  }

  // Build the navigation target (validates the target still exists).
  let target: ResolvedAffiliateLink["target"];
  if (link.type === "product" && link.productId) {
    const product = await db.product.findUnique({
      where: { id: link.productId },
      select: { slug: true, status: true, store: { select: { slug: true, status: true } } },
    });
    if (!product || product.status !== "active" || !product.store || product.store.status !== "live") {
      throw new ApiError(404, "LINK_NOT_FOUND", "The product in this link is no longer available");
    }
    target = { kind: "product", storeSlug: product.store.slug, productSlug: product.slug };
  } else if (link.type === "store" && link.storeId) {
    const store = await db.store.findUnique({ where: { id: link.storeId }, select: { slug: true, status: true } });
    if (!store || store.status !== "live") throw new ApiError(404, "LINK_NOT_FOUND", "The store in this link is no longer available");
    target = { kind: "store", storeSlug: store.slug };
  } else if (link.type === "collection" && link.collectionId) {
    const collection = await db.affiliateCollection.findUnique({
      where: { id: link.collectionId },
      select: { slug: true, status: true },
    });
    if (!collection || collection.status !== "published") {
      throw new ApiError(404, "LINK_NOT_FOUND", "This collection is no longer available");
    }
    target = { kind: "collection", collectionSlug: collection.slug };
  } else if (link.type === "showcase") {
    target = { kind: "showcase", affiliateSlug: affiliate.slug };
  } else {
    throw new ApiError(404, "LINK_NOT_FOUND", "This link is not valid");
  }

  // Record the money-grade touch (visitor cookie identity — server-side).
  // Programme paused ⇒ link still navigates (never breaks shared URLs) but
  // no new attribution/commission liability is recorded.
  if (settings.enabled) {
    try {
      const identity = await resolveInsightsIdentity();
      const expiresAt = new Date(Date.now() + settings.attrWindowDays * 86400000);
      // Collection scope snapshot: the member product ids AT CLICK TIME with
      // the collection version — later membership edits never rewrite the
      // scope this touch validates against.
      let scopeProductIds: string | null = null;
      let collectionVersion: number | null = null;
      if (link.type === "collection" && link.collectionId) {
        const items = await db.affiliateCollectionItem.findMany({
          where: { collectionId: link.collectionId },
          select: { productId: true },
        });
        const collection = await db.affiliateCollection.findUnique({
          where: { id: link.collectionId },
          select: { version: true },
        });
        scopeProductIds = JSON.stringify(items.map((i) => i.productId));
        collectionVersion = collection?.version ?? null;
      }
      await db.affiliateAttributionTouch.create({
        data: {
          visitorId: identity.visitorId,
          affiliateId: affiliate.id,
          linkId: link.id,
          linkType: link.type,
          productId: link.type === "product" ? link.productId : null,
          storeId: link.type === "store" ? link.storeId : null,
          collectionId: link.collectionId,
          collectionVersion,
          scopeProductIds,
          channel: link.channel,
          expiresAt,
        },
      });
      // Denormalized click counter for cheap link performance reads.
      await db.affiliateLink.update({
        where: { id: link.id },
        data: { clicks: { increment: 1 }, lastClickAt: new Date() },
      });
      // Advisory cookie for AnalyticsEvent tagging (nm_aff_last).
      const store = await cookies();
      store.set(AFFILIATE_LAST_COOKIE, JSON.stringify({ affiliateId: affiliate.id, linkId: link.id }), {
        ...COOKIE_OPTS,
        maxAge: settings.attrWindowDays * 86400,
      });
    } catch {
      /* attribution is best-effort at click time — never block navigation */
    }
  }

  return {
    link: {
      id: link.id, type: link.type, code: link.code, channel: link.channel,
      affiliateId: affiliate.id, productId: link.productId, storeId: link.storeId, collectionId: link.collectionId,
    },
    affiliate: { id: affiliate.id, displayName: affiliate.displayName, slug: affiliate.slug },
    target,
  };
}

// ---------------------------------------------------------------------------
// Registration referral tracking — FIRST valid touch wins (spec §5).
// ---------------------------------------------------------------------------
/** Record a referral-link visit (?ref={code}). First-touch semantics: the
 *  nm_aff_ref cookie is only set when no VALID unexpired touch exists yet. */
export async function trackReferralVisit(code: string, channel?: string): Promise<{ displayName: string } | null> {
  const settings = await getAffiliateSettings();
  if (!settings.enabled) return null;
  const normalized = code.trim().toLowerCase();
  if (!normalized || !/^[a-f0-9-]{6,32}$/i.test(normalized)) return null;

  const affiliate = await db.affiliateProfile.findUnique({ where: { code: normalized } });
  if (!affiliate || affiliate.status !== "active") return null;

  try {
    const store = await cookies();
    const identity = await resolveInsightsIdentity();

    // FIRST-touch: only record + set the cookie when no valid touch exists.
    const existingRaw = store.get("nm_aff_ref")?.value;
    if (existingRaw) {
      const parsed = parseJson<{ code?: string }>(existingRaw, {});
      if (parsed?.code) {
        const prior = await db.affiliateReferralTouch.findFirst({
          where: { code: parsed.code, expiresAt: { gt: new Date() } },
          select: { code: true },
        });
        if (prior) return { displayName: affiliate.displayName }; // prior touch wins
      }
    }

    const expiresAt = new Date(Date.now() + settings.sponsorWindowDays * 86400000);
    await db.affiliateReferralTouch.create({
      data: {
        code: normalized,
        affiliateId: affiliate.id,
        visitorId: identity.visitorId,
        channel: channel?.slice(0, 32) ?? null,
        expiresAt,
      },
    });
    store.set("nm_aff_ref", JSON.stringify({ code: normalized }), {
      ...COOKIE_OPTS,
      maxAge: settings.sponsorWindowDays * 86400,
    });
    return { displayName: affiliate.displayName };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Checkout-time resolution — the ONLY money-grade attribution read.
// ---------------------------------------------------------------------------
export type CartAttribution = {
  variantId: string;
  productId: string | null;
  storeId: string;
  /** Resolved attribution for this line (null ⇒ unattributed). */
  affiliateDirectId?: string;
  affiliateSponsorId?: string;
  affiliateLinkId?: string;
};

type TouchRow = {
  id: string;
  affiliateId: string;
  linkId: string;
  linkType: string;
  productId: string | null;
  storeId: string | null;
  scopeProductIds: string | null;
  clickedAt: Date;
};

/** Resolve per-item affiliate attribution for a checkout. For every cart line,
 *  find the LATEST unexpired touch whose scope covers the line's product.
 *  Excludes: programme disabled, affiliate not active, product not enrolled,
 *  store not opted in, and SELF-PURCHASES (the buyer is the affiliate). */
export async function resolveAffiliateAttributionForCart(input: {
  /** Shopper placing the order (self-purchase exclusion). */
  shopperId: string;
  lines: { variantId: string; productId: string | null; storeId: string }[];
}): Promise<Map<string, { affiliateId: string; sponsorId: string | null; linkId: string; rateBps: number; poolBaseMinor: number }>> {
  const result = new Map<string, { affiliateId: string; sponsorId: string | null; linkId: string; rateBps: number; poolBaseMinor: number }>();
  const settings = await getAffiliateSettings();
  if (!settings.enabled || input.lines.length === 0) return result;

  // Visitor identity (httpOnly cookie, server-side read).
  let visitorId: string | null = null;
  try {
    const identity = await resolveInsightsIdentity();
    visitorId = identity.visitorId;
  } catch {
    visitorId = null;
  }
  if (!visitorId || visitorId.startsWith("eph_")) return result;

  const productIds = [...new Set(input.lines.map((l) => l.productId).filter((p): p is string => Boolean(p)))];
  const storeIds = [...new Set(input.lines.map((l) => l.storeId))];
  const now = new Date();

  // Candidate touches: product-scoped, store-scoped, or collection-scoped
  // (loaded broadly then scope-checked per line — bounded by the window).
  const touches: TouchRow[] = await db.affiliateAttributionTouch.findMany({
    where: {
      visitorId,
      expiresAt: { gt: now },
      OR: [{ productId: { in: productIds } }, { storeId: { in: storeIds } }, { productId: null, storeId: null, scopeProductIds: { not: null } }],
    },
    select: { id: true, affiliateId: true, linkId: true, linkType: true, productId: true, storeId: true, scopeProductIds: true, clickedAt: true },
    orderBy: { clickedAt: "desc" },
    take: 200,
  });
  if (touches.length === 0) return result;

  // Affiliate status snapshot (active only) + user mapping for self-purchase.
  const affiliateIds = [...new Set(touches.map((t) => t.affiliateId))];
  const affiliates = await db.affiliateProfile.findMany({
    where: { id: { in: affiliateIds } },
    select: { id: true, userId: true, status: true, sponsorId: true },
  });
  const affiliateById = new Map(affiliates.map((a) => [a.id, a]));
  const selfUserIds = new Set(affiliates.filter((a) => a.userId === input.shopperId).map((a) => a.id));

  // Product + store enrollment snapshot for the cart's products.
  const products = productIds.length
    ? await db.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, affiliateEnabled: true, affiliateRateBps: true, status: true, storeId: true, store: { select: { id: true, affiliateOptIn: true, affiliateDefaultRateBps: true, status: true } } },
      })
    : [];
  const productById = new Map(products.map((p) => [p.id, p]));

  for (const line of input.lines) {
    if (!line.productId) continue;
    const product = productById.get(line.productId);
    if (!product || product.status !== "active" || !product.store || product.store.status !== "live") continue;

    // Latest eligible touch whose scope covers this product.
    let chosen: TouchRow | null = null;
    for (const t of touches) {
      if (selfUserIds.has(t.affiliateId)) continue; // self-purchase: no commission
      const affiliate = affiliateById.get(t.affiliateId);
      if (!affiliate || affiliate.status !== "active") continue;
      const covers =
        (t.productId != null && t.productId === line.productId) ||
        (t.productId == null && t.storeId != null && t.storeId === line.storeId) ||
        (t.productId == null && t.storeId == null && t.scopeProductIds != null && parseJson<string[]>(t.scopeProductIds, []).includes(line.productId));
      if (covers) {
        chosen = t;
        break; // touches sorted desc by clickedAt — first match = last click
      }
    }
    if (!chosen) continue;

    const affiliate = affiliateById.get(chosen.affiliateId)!;
    const rateBps = effectiveAffiliateRateBps(settings, product.store, product);
    if (rateBps <= 0) continue; // product not enrolled / store opted out

    result.set(line.variantId, {
      affiliateId: affiliate.id,
      sponsorId: affiliate.sponsorId,
      linkId: chosen.linkId,
      rateBps,
      poolBaseMinor: 0, // computed by the caller with pricing context
    });
  }
  return result;
}

/** Helper for generating new link codes (unpredictable, URL-safe). */
export function newAffiliateLinkCode(): string {
  return randomToken(5);
}

/** Advisory affiliate tag for AnalyticsEvent rows — reads the httpOnly
 *  nm_aff_last cookie (set at promotional-link resolution). ADVISORY ONLY:
 *  money-grade attribution is resolved from the server-side touch table at
 *  checkout (resolveAffiliateAttributionForCart), never from this cookie. */
export async function resolveAffiliateEventTag(): Promise<{ affiliateId: string | null; linkId: string | null }> {
  try {
    const store = await cookies();
    const raw = store.get(AFFILIATE_LAST_COOKIE)?.value;
    if (!raw) return { affiliateId: null, linkId: null };
    const parsed = parseJson<{ affiliateId?: string; linkId?: string }>(raw, {});
    if (!parsed?.affiliateId || !/^[a-zA-Z0-9_-]{8,64}$/.test(parsed.affiliateId)) {
      return { affiliateId: null, linkId: null };
    }
    return {
      affiliateId: parsed.affiliateId,
      linkId: parsed.linkId && /^[a-zA-Z0-9_-]{8,64}$/.test(parsed.linkId) ? parsed.linkId : null,
    };
  } catch {
    return { affiliateId: null, linkId: null };
  }
}
