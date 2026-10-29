// Seller Insights & Marketing Intelligence — campaign attribution core.
//
// ATTRIBUTION MODEL (explicit definition — docs/seller-insights/metric-definitions.md §11):
//   Last-touch first-party association. The most recent VALIDATED tagged
//   landing (UTM parameters and/or a seller campaign-link token `nmcl`) within
//   a 30-day window is the "current attribution". It is:
//     • stamped on every tracked AnalyticsEvent at event time,
//     • frozen onto the Order at checkout creation (constant snapshot columns),
//     • NEVER backfilled for pre-feature history, and NEVER claimed to CAUSE a
//       sale — a tagged visit is associated with the campaign, nothing more.
//   Ad-platform-reported conversions are a different measurement and are not
//   shown anywhere in this pipeline. No spend exists in first-party data, so
//   no ROAS / CPC / CPA is computed.
//
// CAPTURE FLOW:
//   Landing URL `/?sf={slug}&utm_…&nmcl={code}` → shopper shell reads the params
//   once at mount → POST /api/analytics/landing (same-origin beacon, CSRF-gated
//   by src/proxy.ts) → this module validates → httpOnly cookie `nm_ins_attr`
//   (30 days from the captured landing, NOT sliding on events — the attribution
//   window is defined by landings) → events + checkout read it server-side.
//
// PRIVACY: the cookie carries only short validated strings (no PII, no full
// URLs, no identifiers). Anonymous shoppers are never identified to sellers.
import { cookies } from "next/headers";
import { db } from "@/lib/db";

export const ATTRIBUTION_COOKIE = "nm_ins_attr";
/** Attribution window: a captured landing is trusted for 30 days. */
export const ATTR_WINDOW_S = 30 * 24 * 60 * 60;

const UTM_LIMITS: Record<UtmKey, number> = {
  utmSource: 100,
  utmMedium: 50,
  utmCampaign: 100,
  utmTerm: 100,
  utmContent: 100,
};

export type UtmKey = "utmSource" | "utmMedium" | "utmCampaign" | "utmTerm" | "utmContent";

export type Attribution = {
  campaignId: string | null;
  campaignName: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
};

/** Strip control characters, collapse whitespace, clamp to the field limit.
 *  Returns null for empty/whitespace-only input. Display-safe: React escapes
 *  on render and the CSV export quotes cells — this is input hygiene, not the
 *  only defense. */
function sanitizeUtm(raw: unknown, maxLen: number): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen)
    .trim();
  return cleaned === "" ? null : cleaned;
}

const UTM_PARAM_TO_KEY: Record<string, UtmKey> = {
  utm_source: "utmSource",
  utm_medium: "utmMedium",
  utm_campaign: "utmCampaign",
  utm_term: "utmTerm",
  utm_content: "utmContent",
};

/** Validate raw UTM parameters (e.g. from a Request body or URLSearchParams).
 *  Returns only keys present AND valid — invalid/oversized values are dropped
 *  (fail-closed to "not captured", never an error into the host request). */
export function validateUtmParams(
  params: Record<string, unknown> | URLSearchParams
): Pick<Attribution, UtmKey> {
  const out: Pick<Attribution, UtmKey> = {
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmTerm: null,
    utmContent: null,
  };
  const get = (k: string): unknown =>
    params instanceof URLSearchParams ? params.get(k) : params[k];
  for (const [param, key] of Object.entries(UTM_PARAM_TO_KEY)) {
    const v = sanitizeUtm(get(param), UTM_LIMITS[key]);
    if (v) out[key] = v;
  }
  return out;
}

export function hasAnyUtm(utm: Pick<Attribution, UtmKey>): boolean {
  return Object.values(utm).some((v) => v != null);
}

/** Resolve a campaign-link token (`nmcl`) for a landing storefront.
 *  Fail-closed rules: the campaign must exist, be active, and BELONG to the
 *  landing store (a token from another store is ignored — no cross-store
 *  attribution pollution). Returns the campaign row or null. */
export async function resolveCampaignToken(
  code: unknown,
  landingStoreSlug: unknown
): Promise<{ id: string; name: string; slug: string; defaultSource: string | null; defaultMedium: string | null } | null> {
  try {
    if (typeof code !== "string" || code.length === 0 || code.length > 64) return null;
    if (typeof landingStoreSlug !== "string" || landingStoreSlug.length === 0) return null;
    const store = await db.store.findUnique({ where: { slug: landingStoreSlug }, select: { id: true } });
    if (!store) return null;
    // Single query — the storeId clause IS the ownership check.
    return await db.sellerCampaign.findFirst({
      where: { code, status: "active", storeId: store.id },
      select: { id: true, name: true, slug: true, defaultSource: true, defaultMedium: true },
    });
  } catch {
    return null; // never break the landing request
  }
}

const cookieOptions = {
  httpOnly: true,
  sameSite: "none" as const, // matches the nm_ins_* posture (iframe preview panel)
  secure: true,
  path: "/",
};

/** Read + validate the CURRENT attribution from the request cookies.
 *  Never throws — cookie-access problems return null (untagged). */
export async function resolveAttribution(): Promise<Attribution | null> {
  try {
    const store = await cookies();
    const raw = store.get(ATTRIBUTION_COOKIE)?.value;
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    if (o.v !== 1) return null;
    const utm = validateUtmParams({
      utm_source: o.utmSource,
      utm_medium: o.utmMedium,
      utm_campaign: o.utmCampaign,
      utm_term: o.utmTerm,
      utm_content: o.utmContent,
    });
    const campaignId = typeof o.campaignId === "string" && o.campaignId.length > 0 ? o.campaignId : null;
    const campaignName = typeof o.campaignName === "string" ? sanitizeUtm(o.campaignName, 120) : null;
    if (!campaignId && !hasAnyUtm(utm)) return null;
    return {
      campaignId,
      campaignName,
      utmSource: utm.utmSource,
      utmMedium: utm.utmMedium,
      utmCampaign: utm.utmCampaign,
      utmTerm: utm.utmTerm,
      utmContent: utm.utmContent,
    };
  } catch {
    return null;
  }
}

/** Write the attribution cookie (called by the landing beacon only). */
export async function persistAttribution(attr: Attribution): Promise<boolean> {
  try {
    const store = await cookies();
    store.set(
      ATTRIBUTION_COOKIE,
      JSON.stringify({
        v: 1,
        campaignId: attr.campaignId,
        campaignName: attr.campaignName,
        utmSource: attr.utmSource,
        utmMedium: attr.utmMedium,
        utmCampaign: attr.utmCampaign,
        utmTerm: attr.utmTerm,
        utmContent: attr.utmContent,
      }),
      { ...cookieOptions, maxAge: ATTR_WINDOW_S }
    );
    return true;
  } catch {
    return false;
  }
}

/** Shareable campaign link PATH for a store + campaign (origin prepended
 *  client-side — the API never guesses the public origin). Carries standard
 *  UTM parameters AND the canonical `nmcl` token so the link keeps resolving
 *  even when a platform strips UTMs. */
export function campaignLinkPath(
  storeSlug: string,
  campaign: { slug: string; code: string; defaultSource: string | null; defaultMedium: string | null }
): string {
  const p = new URLSearchParams();
  p.set("utm_campaign", campaign.slug);
  if (campaign.defaultSource) p.set("utm_source", campaign.defaultSource);
  if (campaign.defaultMedium) p.set("utm_medium", campaign.defaultMedium);
  p.set("nmcl", campaign.code);
  return `/?sf=${encodeURIComponent(storeSlug)}&${p.toString()}`;
}

// ---------------------------------------------------------------------------
// Channel derivation — a tagged visit classifies its channel from the
// validated utm_source (keyword match), because the SPA's same-origin fetches
// make the Referer header useless for external landings (audit finding §1.3).
// Untagged traffic keeps the legacy referrer classification + its caveats.
// ---------------------------------------------------------------------------

const SOCIAL_KEYWORDS = [
  "facebook", "fb", "instagram", "ig", "tiktok", "twitter", "x.com", "pinterest",
  "youtube", "youtu", "reddit", "linkedin", "threads", "whatsapp", "wa.me", "t.me", "telegram",
];
const SEARCH_KEYWORDS = [
  "google", "bing", "duckduckgo", "ecosia", "brave", "yahoo", "search", "baidu", "yandex",
];

/** Channel for an attributed event, derived from utm_source by keyword match.
 *  Returns null when nothing mapable exists — the caller then falls back to
 *  the legacy referrer classification (with its documented SPA caveat). */
export function channelFromAttribution(attr: Attribution | null): string | null {
  if (!attr) return null;
  const source = (attr.utmSource ?? "").toLowerCase();
  if (source === "") return null;
  if (SOCIAL_KEYWORDS.some((k) => source.includes(k))) return "social";
  if (SEARCH_KEYWORDS.some((k) => source.includes(k))) return "search";
  return "other";
}
