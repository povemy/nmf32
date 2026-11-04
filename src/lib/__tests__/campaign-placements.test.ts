// ============================================================================
// WORK ORDER 14 unit tests — PURE logic coverage for the campaign
// merchandising + homepage-layout helpers (bun:test). NO database: placements,
// CTA destination tokens (write-side validation + read-side resolution),
// campaign ordering, archived-aware status derivation and the section-order
// normalizer are exercised here. The DB-backed flows (placements on the real
// homepage payload, cache invalidation, admin API auth) are covered by the
// live E2E suite scripts/readiness/homepage-campaign-e2e.ts against the
// running dev server.
// ============================================================================
import { describe, expect, test } from "bun:test";
import {
  campaignStatusOf,
  compareCampaigns,
  parsePlacement,
  resolveCampaignCta,
  validateCampaignCtaHref,
  validateCampaignImageUrl,
  CAMPAIGN_PLACEMENTS,
} from "@/lib/campaigns";
import {
  DEFAULT_SECTION_ORDER,
  normalizeSectionOrder,
  sectionOrderFromSetting,
} from "@/lib/home-layout";

// ---------------------------------------------------------------------------
// Placements
// ---------------------------------------------------------------------------

describe("parsePlacement — the homepage placement vocabulary", () => {
  test("accepts every known placement id", () => {
    for (const p of CAMPAIGN_PLACEMENTS) {
      expect(parsePlacement(p.id)).toBe(p.id);
    }
  });

  test("rejects unknown, empty and non-string values", () => {
    expect(parsePlacement("sidebar")).toBeNull();
    expect(parsePlacement("HERO")).toBeNull(); // case-sensitive
    expect(parsePlacement("")).toBeNull();
    expect(parsePlacement(null)).toBeNull();
    expect(parsePlacement(123)).toBeNull();
  });

  test("every placement declares a capacity ≥ 1 and admin copy", () => {
    for (const p of CAMPAIGN_PLACEMENTS) {
      expect(p.capacity).toBeGreaterThanOrEqual(1);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.hint.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// CTA destinations — write-side validation
// ---------------------------------------------------------------------------

describe("validateCampaignCtaHref — admin token validation", () => {
  test("accepts the bare tokens", () => {
    expect(validateCampaignCtaHref("search")).toEqual({ ok: true, value: "search" });
    expect(validateCampaignCtaHref("deals")).toEqual({ ok: true, value: "deals" });
    expect(validateCampaignCtaHref("vouchers")).toEqual({ ok: true, value: "vouchers" });
  });

  test("accepts keyword search and normalizes whitespace", () => {
    expect(validateCampaignCtaHref("search:raya")).toEqual({ ok: true, value: "search:raya" });
    expect(validateCampaignCtaHref("  search:  raya   mega  ")).toEqual({ ok: true, value: "search:raya mega" });
  });

  test("accepts valid category/store slugs", () => {
    expect(validateCampaignCtaHref("category:electronics")).toEqual({ ok: true, value: "category:electronics" });
    expect(validateCampaignCtaHref("store:bytebazaar")).toEqual({ ok: true, value: "store:bytebazaar" });
    expect(validateCampaignCtaHref("store:a-b-c-123")).toEqual({ ok: true, value: "store:a-b-c-123" });
  });

  test("rejects malformed slugs and empty keywords", () => {
    expect(validateCampaignCtaHref("search:").ok).toBe(false);
    expect(validateCampaignCtaHref("category:").ok).toBe(false);
    expect(validateCampaignCtaHref("category:Not A Slug").ok).toBe(false);
    expect(validateCampaignCtaHref("store:-leading-dash").ok).toBe(false);
    expect(validateCampaignCtaHref("category:UPPER").ok).toBe(false);
  });

  test("accepts only https external URLs, without credentials", () => {
    expect(validateCampaignCtaHref("https://example.com/sale").ok).toBe(true);
    expect(validateCampaignCtaHref("http://example.com/sale").ok).toBe(false); // no http downgrade
    expect(validateCampaignCtaHref("javascript:alert(1)").ok).toBe(false);
    expect(validateCampaignCtaHref("https://user:pass@example.com").ok).toBe(false);
    expect(validateCampaignCtaHref("https://").ok).toBe(false);
    expect(validateCampaignCtaHref("data:text/html,x").ok).toBe(false);
  });

  test("rejects junk and over-length values", () => {
    expect(validateCampaignCtaHref("").ok).toBe(false);
    expect(validateCampaignCtaHref("   ").ok).toBe(false);
    expect(validateCampaignCtaHref("browse").ok).toBe(false);
    expect(validateCampaignCtaHref(`search:${"x".repeat(61)}`).ok).toBe(false);
    expect(validateCampaignCtaHref(`https://example.com/${"x".repeat(500)}`).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CTA destinations — read-side resolution (defense in depth)
// ---------------------------------------------------------------------------

describe("resolveCampaignCta — public resolution of stored tokens", () => {
  test("resolves every valid token shape", () => {
    expect(resolveCampaignCta("search")).toEqual({ kind: "search", q: "" });
    expect(resolveCampaignCta("search:raya mega")).toEqual({ kind: "search", q: "raya mega" });
    expect(resolveCampaignCta("category:electronics")).toEqual({ kind: "category", slug: "electronics" });
    expect(resolveCampaignCta("store:bytebazaar")).toEqual({ kind: "store", slug: "bytebazaar" });
    expect(resolveCampaignCta("deals")).toEqual({ kind: "deals" });
    expect(resolveCampaignCta("vouchers")).toEqual({ kind: "vouchers" });
    expect(resolveCampaignCta("https://example.com/sale")).toEqual({ kind: "external", url: "https://example.com/sale" });
  });

  test("degrades INVALID stored tokens to null — never throws, never leaks", () => {
    expect(resolveCampaignCta(null)).toBeNull();
    expect(resolveCampaignCta(undefined)).toBeNull();
    expect(resolveCampaignCta("")).toBeNull();
    expect(resolveCampaignCta("javascript:alert(1)")).toBeNull();
    expect(resolveCampaignCta("http://insecure.example.com")).toBeNull();
    expect(resolveCampaignCta("category:BAD SLUG")).toBeNull();
    expect(resolveCampaignCta("search:")).toBeNull();
    expect(resolveCampaignCta("totally-unknown-token")).toBeNull();
    expect(resolveCampaignCta(`https://u:p@example.com`)).toBeNull();
    expect(resolveCampaignCta(`search:${"x".repeat(61)}`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Creative URL validation
// ---------------------------------------------------------------------------

describe("validateCampaignImageUrl — creative URL rules", () => {
  test("accepts site-relative paths (the /api/img and /uploads convention)", () => {
    expect(validateCampaignImageUrl("/api/img/campaign-raya?w=1400&h=480&label=Raya").ok).toBe(true);
    expect(validateCampaignImageUrl("/uploads/campaigns/campaign-x.png").ok).toBe(true);
    expect(validateCampaignImageUrl("/banners/hero-1.png").ok).toBe(true);
  });

  test("rejects protocol-relative, backslash-smuggled and control-char paths", () => {
    expect(validateCampaignImageUrl("//evil.com/x.png").ok).toBe(false);
    expect(validateCampaignImageUrl("/\\evil.com/x.png").ok).toBe(false);
    expect(validateCampaignImageUrl("/a b.png").ok).toBe(false);
    expect(validateCampaignImageUrl("/x\n.png").ok).toBe(false);
  });

  test("accepts https remote images only", () => {
    expect(validateCampaignImageUrl("https://cdn.example.com/banner.png").ok).toBe(true);
    expect(validateCampaignImageUrl("http://cdn.example.com/banner.png").ok).toBe(false);
    expect(validateCampaignImageUrl("https://u:p@cdn.example.com/x.png").ok).toBe(false);
    expect(validateCampaignImageUrl("not-a-url").ok).toBe(false);
    expect(validateCampaignImageUrl("").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ordering + status
// ---------------------------------------------------------------------------

describe("compareCampaigns — deterministic within-placement ordering", () => {
  const c = (id: string, priority: number, displayOrder: number, startAt: number) => ({
    id,
    priority,
    displayOrder,
    startAt: new Date(Date.UTC(2026, 0, startAt)),
  });

  test("priority DESC wins first", () => {
    expect(compareCampaigns(c("a", 1, 9, 1), c("b", 2, 0, 1))).toBeGreaterThan(0);
    expect(compareCampaigns(c("b", 2, 0, 1), c("a", 1, 9, 1))).toBeLessThan(0);
  });

  test("displayOrder ASC breaks priority ties", () => {
    expect(compareCampaigns(c("a", 5, 1, 1), c("b", 5, 2, 1))).toBeLessThan(0);
  });

  test("startAt DESC breaks remaining ties (newest campaign first)", () => {
    expect(compareCampaigns(c("a", 5, 1, 10), c("b", 5, 1, 5))).toBeLessThan(0);
  });

  test("id is the stable final tiebreak", () => {
    expect(compareCampaigns(c("a", 5, 1, 1), c("b", 5, 1, 1))).toBeLessThan(0);
    expect(compareCampaigns(c("b", 5, 1, 1), c("a", 5, 1, 1))).toBeGreaterThan(0);
    expect(compareCampaigns(c("a", 5, 1, 1), c("a", 5, 1, 1))).toBe(0);
  });
});

describe("campaignStatusOf — archived-aware derived status", () => {
  const base = { isPublished: true, startAt: new Date(Date.UTC(2026, 0, 1)), endAt: new Date(Date.UTC(2026, 0, 10)) };
  const now = new Date(Date.UTC(2026, 0, 5));

  test("draft/scheduled/live/ended unchanged for legacy rows (no archivedAt)", () => {
    expect(campaignStatusOf({ ...base, isPublished: false }, now)).toBe("draft");
    const future = { ...base, startAt: new Date(Date.UTC(2026, 0, 8)), endAt: new Date(Date.UTC(2026, 0, 12)) };
    expect(campaignStatusOf(future, now)).toBe("scheduled");
    expect(campaignStatusOf(base, now)).toBe("live");
    const past = { ...base, startAt: new Date(Date.UTC(2025, 0, 1)), endAt: new Date(Date.UTC(2025, 0, 2)) };
    expect(campaignStatusOf(past, now)).toBe("ended");
  });

  test("archivedAt dominates every other state", () => {
    expect(campaignStatusOf({ ...base, archivedAt: new Date() }, now)).toBe("archived");
    expect(campaignStatusOf({ ...base, isPublished: false, archivedAt: new Date() }, now)).toBe("archived");
  });
});

// ---------------------------------------------------------------------------
// Homepage section order
// ---------------------------------------------------------------------------

describe("normalizeSectionOrder — the single layout authority", () => {
  test("absent/unparseable input falls back to the documented default", () => {
    expect(normalizeSectionOrder(undefined)).toEqual(DEFAULT_SECTION_ORDER);
    expect(normalizeSectionOrder(null)).toEqual(DEFAULT_SECTION_ORDER);
    expect(normalizeSectionOrder("hero")).toEqual(DEFAULT_SECTION_ORDER);
    expect(normalizeSectionOrder({})).toEqual(DEFAULT_SECTION_ORDER);
    expect(normalizeSectionOrder([1, 2, 3])).toEqual(DEFAULT_SECTION_ORDER);
  });

  test("drops unknown ids and dedupes sections (first occurrence wins)", () => {
    expect(normalizeSectionOrder(["hero", "bogus", "quick_access", "quick_access"])).toEqual(["hero", "quick_access"]);
  });

  test("hero is mandatory and always forced to the front", () => {
    expect(normalizeSectionOrder(["quick_access", "trending", "hero"])).toEqual(["hero", "quick_access", "trending"]);
    expect(normalizeSectionOrder(["quick_access", "trending"])[0]).toBe("hero");
    const noHero = normalizeSectionOrder(["categories"]);
    expect(noHero[0]).toBe("hero");
    expect(noHero).toContain("categories");
  });

  test("inline slots are preserved positionally and capped at 3", () => {
    const out = normalizeSectionOrder(["hero", "inline", "trending", "inline", "featured", "inline"]);
    expect(out).toEqual(["hero", "inline", "trending", "inline", "featured", "inline"]);
    const capped = normalizeSectionOrder(["hero", "inline", "inline", "inline", "inline", "categories"]);
    expect(capped.filter((x) => x === "inline").length).toBe(3);
  });

  test("omitting a section hides it — no auto-append of core sections", () => {
    const out = normalizeSectionOrder(["hero", "showcase"]);
    expect(out).toEqual(["hero", "showcase"]);
    expect(out).not.toContain("trending");
  });

  test("sectionOrderFromSetting parses Setting valueJson and degrades safely", () => {
    expect(sectionOrderFromSetting(null)).toEqual(DEFAULT_SECTION_ORDER);
    expect(sectionOrderFromSetting(undefined)).toEqual(DEFAULT_SECTION_ORDER);
    expect(sectionOrderFromSetting("not json")).toEqual(DEFAULT_SECTION_ORDER);
    expect(sectionOrderFromSetting(JSON.stringify(["hero", "trending"]))).toEqual(["hero", "trending"]);
    expect(sectionOrderFromSetting(JSON.stringify({ nope: true }))).toEqual(DEFAULT_SECTION_ORDER);
  });
});
