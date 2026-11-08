import { handle, ok } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import {
  validateUtmParams,
  hasAnyUtm,
  resolveCampaignToken,
  persistAttribution,
} from "@/lib/analytics/attribution";
import type { LandingBody, LandingData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/analytics/landing — same-origin attribution-capture beacon.
//
// The shopper SPA reads landing URL parameters (utm_* / nmcl / sf) exactly once
// at mount and fires this beacon. The server VALIDATES everything, resolves the
// campaign-link token against the LANDING STORE (fail-closed on cross-store
// tokens), and writes the httpOnly `nm_ins_attr` cookie (30-day window).
//
// Protections: CSRF proxy gate (same-origin POST + JSON-only for browsers),
// rate limit 30/min/IP, strict validation — nothing invalid is ever persisted.
// A beacon with no valid parameters is a no-op that leaves any prior
// attribution cookie untouched (last-touch is replaced only by a NEW valid
// tagged landing).
export const POST = handle(async (req: Request) => {
  rateLimit(req, "analytics-landing", 30, 60_000);

  // LandingBody & Record: the contract body shape intersected with the index
  // signature validateUtmParams' Record<string, unknown> parameter requires
  // (a bare interface carries no implicit index signature).
  let body: LandingBody & Record<string, unknown> = {};
  try {
    body = (await req.json()) as LandingBody & Record<string, unknown>;
    if (body == null || typeof body !== "object" || Array.isArray(body)) body = {};
  } catch {
    body = {};
  }

  const utm = validateUtmParams(body);
  const campaign = body.nmcl != null ? await resolveCampaignToken(body.nmcl, body.sf) : null;

  if (!campaign && !hasAnyUtm(utm)) {
    // Nothing valid to capture — 200 (idempotent no-op, never an error state
    // the client needs to handle).
    const payload: LandingData = { captured: false };
    return ok(payload);
  }

  // When the campaign token resolves, its canonical slug becomes the
  // utm_campaign fallback; explicit URL UTM values win when present.
  const attr = {
    campaignId: campaign?.id ?? null,
    campaignName: campaign?.name ?? null,
    utmSource: utm.utmSource ?? campaign?.defaultSource ?? null,
    utmMedium: utm.utmMedium ?? campaign?.defaultMedium ?? null,
    utmCampaign: utm.utmCampaign ?? campaign?.slug ?? null,
    utmTerm: utm.utmTerm,
    utmContent: utm.utmContent,
  };

  const persisted = await persistAttribution(attr);
  const payload: LandingData = { captured: persisted };
  return ok(payload);
});
