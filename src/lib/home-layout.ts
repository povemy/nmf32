// ============================================================================
// Homepage section layout (work order 14) — the ADMIN-CONTROLLED order of
// homepage sections, stored as Setting "home.section_order" (JSON array of
// section ids). The shopper homepage renders sections in THIS order; "inline"
// entries are slots that consume the next live inline campaign (banner or
// product shelf).
//
// PURE + CLIENT-SAFE (no server imports) so the admin Homepage Layout view,
// the public market-home API and unit tests all share ONE normalizer —
// the same rules everywhere, no drift between admin validation and public
// rendering.
//
// Rules (enforced by normalizeSectionOrder — the single authority):
//   • Only known section ids survive; anything else is dropped.
//   • "hero" is mandatory and always renders FIRST (prepended if missing) —
//     the primary banner area is never accidentally hidden or buried.
//   • Every other section is optional: omitting it HIDES it (that is how
//     admins manage section visibility — no separate show/hide flags).
//   • Duplicate non-inline entries are dropped (first occurrence wins).
//   • "inline" may appear multiple times (each slot consumes the NEXT live
//     inline campaign in priority order), capped at 3 slots.
//   • An absent/unparseable Setting row falls back to DEFAULT_SECTION_ORDER.
// ============================================================================

export type HomeSectionId =
  | "hero"
  | "quick_access"
  | "showcase"
  | "flash_deals"
  | "categories"
  | "trending"
  | "featured"
  | "stores"
  | "new_arrivals"
  | "inline";

export type HomeSectionMeta = {
  id: HomeSectionId;
  /** Admin-facing label. */
  label: string;
  /** What the section renders (admin hint). */
  description: string;
  /** Data dependency — hidden automatically when the marketplace has no data. */
  requires: string;
};

export const HOME_SECTIONS: HomeSectionMeta[] = [
  { id: "hero", label: "Hero carousel", description: "Campaign hero slides (+ banner fallback) with CTAs.", requires: "Always shown (default banner when empty)" },
  { id: "quick_access", label: "Quick access", description: "Permanent marketplace shortcuts + admin promo tiles.", requires: "Always shown" },
  { id: "showcase", label: "Campaign showcase", description: "Festive & seasonal campaign cards.", requires: "Live showcase campaigns" },
  { id: "flash_deals", label: "Flash deals", description: "Genuinely discounted products + campaign countdown.", requires: "Products with a real compare-at price" },
  { id: "categories", label: "Category discovery", description: "Product category grid with icons.", requires: "Active categories" },
  { id: "trending", label: "Trending now", description: "Best-selling products (salesCount).", requires: "Active products" },
  { id: "featured", label: "Featured picks", description: "Admin-featured product slots.", requires: "Featured slots" },
  { id: "stores", label: "Featured stores", description: "Live marketplace stores.", requires: "Live stores" },
  { id: "new_arrivals", label: "New arrivals", description: "Latest active products.", requires: "Active products" },
  { id: "inline", label: "Inline promo slot", description: "Next live inline campaign — banner or product shelf.", requires: "Live inline campaigns" },
];

export const DEFAULT_SECTION_ORDER: HomeSectionId[] = [
  "hero",
  "quick_access",
  "showcase",
  "flash_deals",
  "categories",
  "trending",
  "featured",
  "stores",
  "new_arrivals",
];

const INLINE_MAX = 3;

const KNOWN = new Set<HomeSectionId>(HOME_SECTIONS.map((s) => s.id));

/** The single normalizer — admin save side, public read side, tests. */
export function normalizeSectionOrder(input: unknown): HomeSectionId[] {
  if (!Array.isArray(input)) return [...DEFAULT_SECTION_ORDER];
  const seen = new Set<string>();
  const out: HomeSectionId[] = [];
  let inlineCount = 0;
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const id = raw as HomeSectionId;
    if (!KNOWN.has(id)) continue;
    if (id === "inline") {
      if (inlineCount >= INLINE_MAX) continue;
      inlineCount += 1;
      out.push(id);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  // Hero is mandatory and always first.
  if (!seen.has("hero")) out.unshift("hero");
  else {
    const heroIdx = out.indexOf("hero");
    if (heroIdx > 0) {
      out.splice(heroIdx, 1);
      out.unshift("hero");
    }
  }
  // Nothing recognizable survived (e.g. an array of numbers / all-unknown
  // ids) — serve the documented default rather than a hero-only page.
  if (out.length <= 1 && inlineCount === 0) return [...DEFAULT_SECTION_ORDER];
  return out;
}

/** Parse a Setting row valueJson (unknown JSON) into a section order. */
export function sectionOrderFromSetting(valueJson: string | null | undefined): HomeSectionId[] {
  if (valueJson == null) return [...DEFAULT_SECTION_ORDER];
  try {
    return normalizeSectionOrder(JSON.parse(valueJson));
  } catch {
    return [...DEFAULT_SECTION_ORDER];
  }
}

export const HOME_SECTION_ORDER_KEY = "home.section_order";

/** Admin-curated featured-store ids (ordered JSON array) — written by
 *  PUT /api/admin/featured-stores, read by the public market-home payload.
 *  Shared here (client-safe, no server imports) so the admin route and the
 *  public route can never drift on the key name. */
export const FEATURED_STORES_KEY = "home.featured_stores";

/** Parse a Setting row valueJson (unknown JSON) into an ordered id list —
 *  tolerant of missing/malformed rows (returns []). */
export function idListFromSetting(valueJson: string | null | undefined): string[] {
  if (valueJson == null) return [];
  try {
    const v: unknown = JSON.parse(valueJson);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
  } catch {
    return [];
  }
}
