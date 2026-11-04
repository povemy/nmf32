// Work order 14 — shared write-side validation for campaign merchandising
// fields, used by POST /api/admin/campaigns and PATCH /api/admin/campaigns/[id].
// Private helper module (underscore prefix = never a route), same convention
// as _helpers.ts.
import { ApiError } from "@/lib/api";
import { optNum } from "./_helpers";
import {
  CAMPAIGN_PLACEMENTS,
  parsePlacement,
  validateCampaignCtaHref,
  validateCampaignImageUrl,
  type CampaignPlacement,
} from "@/lib/campaigns";

export const CAMPAIGN_FIELD_LIMITS = {
  descriptionMax: 280,
  ctaLabelMax: 40,
  productQueryMax: 60,
  priorityMin: -100,
  priorityMax: 100,
  displayOrderMax: 9999,
} as const;

export type CampaignMerchFields = {
  description?: string | null;
  placement?: CampaignPlacement;
  priority?: number;
  displayOrder?: number;
  ctaLabel?: string | null;
  ctaHref?: string | null;
  bannerDesktopUrl?: string | null;
  bannerMobileUrl?: string | null;
  thumbnailUrl?: string | null;
  productQuery?: string | null;
};

/** null/"" clears an optional string; a non-empty string must validate. */
function optUrlField(body: Record<string, unknown>, key: string): { value?: string | null; provided: boolean } {
  if (!(key in body)) return { provided: false };
  const raw = body[key];
  if (raw == null || raw === "") return { value: null, provided: true };
  if (typeof raw !== "string") throw new ApiError(400, "VALIDATION", `${key} must be a string`);
  const verdict = validateCampaignImageUrl(raw);
  if (!verdict.ok) throw new ApiError(400, "VALIDATION", `${key}: ${verdict.error}`);
  return { value: verdict.value, provided: true };
}

/** Parse + validate every merchandising field PRESENT in the body (absent
 *  fields are left untouched — partial PATCH semantics). Throws 400 VALIDATION
 *  with a human-readable error per offending field. */
export function parseCampaignMerchFields(body: Record<string, unknown>): CampaignMerchFields {
  const L = CAMPAIGN_FIELD_LIMITS;
  const out: CampaignMerchFields = {};

  if ("description" in body) {
    const raw = body.description;
    if (raw == null || raw === "") out.description = null;
    else {
      if (typeof raw !== "string") throw new ApiError(400, "VALIDATION", "description must be a string");
      const v = raw.trim();
      if (v.length > L.descriptionMax) throw new ApiError(400, "VALIDATION", `description must be ≤ ${L.descriptionMax} characters`);
      out.description = v === "" ? null : v;
    }
  }

  if ("placement" in body) {
    const p = parsePlacement(body.placement);
    if (body.placement != null && body.placement !== "" && !p) {
      throw new ApiError(
        400,
        "VALIDATION",
        `Unknown placement '${String(body.placement)}'. Valid: ${CAMPAIGN_PLACEMENTS.map((x) => x.id).join(", ")}`
      );
    }
    out.placement = p ?? "showcase";
  }

  if ("priority" in body) {
    const n = optNum(body, "priority");
    if (n == null) throw new ApiError(400, "VALIDATION", "priority must be a number");
    if (n < L.priorityMin || n > L.priorityMax || !Number.isInteger(n)) {
      throw new ApiError(400, "VALIDATION", `priority must be a whole number between ${L.priorityMin} and ${L.priorityMax}`);
    }
    out.priority = n;
  }

  if ("displayOrder" in body) {
    const n = optNum(body, "displayOrder");
    if (n == null) throw new ApiError(400, "VALIDATION", "displayOrder must be a number");
    if (n < 0 || n > L.displayOrderMax || !Number.isInteger(n)) {
      throw new ApiError(400, "VALIDATION", `displayOrder must be a whole number between 0 and ${L.displayOrderMax}`);
    }
    out.displayOrder = n;
  }

  if ("ctaLabel" in body) {
    const raw = body.ctaLabel;
    if (raw == null || raw === "") out.ctaLabel = null;
    else {
      if (typeof raw !== "string") throw new ApiError(400, "VALIDATION", "ctaLabel must be a string");
      const v = raw.trim();
      if (v.length > L.ctaLabelMax) throw new ApiError(400, "VALIDATION", `ctaLabel must be ≤ ${L.ctaLabelMax} characters`);
      out.ctaLabel = v;
    }
  }

  if ("ctaHref" in body) {
    const raw = body.ctaHref;
    if (raw == null || raw === "") out.ctaHref = null;
    else {
      if (typeof raw !== "string") throw new ApiError(400, "VALIDATION", "ctaHref must be a string");
      const verdict = validateCampaignCtaHref(raw);
      if (!verdict.ok) throw new ApiError(400, "VALIDATION", `ctaHref: ${verdict.error}`);
      out.ctaHref = verdict.value;
    }
  }

  for (const key of ["bannerDesktopUrl", "bannerMobileUrl", "thumbnailUrl"] as const) {
    const { value, provided } = optUrlField(body, key);
    if (provided) out[key] = value ?? null;
  }

  if ("productQuery" in body) {
    const raw = body.productQuery;
    if (raw == null || raw === "") out.productQuery = null;
    else {
      if (typeof raw !== "string") throw new ApiError(400, "VALIDATION", "productQuery must be a string");
      const v = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
      if (v.length > L.productQueryMax) throw new ApiError(400, "VALIDATION", `productQuery must be ≤ ${L.productQueryMax} characters`);
      out.productQuery = v === "" ? null : v;
    }
  }

  return out;
}
