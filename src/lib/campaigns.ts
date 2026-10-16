// ============================================================================
// Campaign engine (Task 10-e / rebuild 13-c) — festive campaign presets,
// theme parsing/validation, active-campaign resolution.
//
// CLIENT-SAFE MODULE: Wave 2 shopper/admin UI imports the presets + theme
// helpers from this file, so the Prisma client is NEVER imported at module
// top level. resolveActiveCampaign() loads it lazily via `await import("./db")`
// (Turbopack duplicates module instances per route — the active-campaign cache
// therefore lives on globalThis, not in module scope).
//
// All preset windows are anchored to Asia/Kuala_Lumpur time (UTC+8, no DST).
// Dates crossing the wire are ISO strings.
// ============================================================================

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export type CampaignThemeT = {
  /** Main festive accent (hex). Drives --campaign-accent and CTAs. */
  accent: string;
  /** Soft tint of the accent for chips/badges/backgrounds (hex). */
  accentSoft: string;
  /** Campaign banner gradient start (hex). */
  gradientFrom: string;
  /** Campaign banner gradient end (hex). */
  gradientTo: string;
  /** Greeting copy (EN). */
  greeting: string;
  /** Greeting copy (light BM). */
  greetingBm: string;
  /** Tagline copy (EN). */
  tagline: string;
  /** Tagline copy (light BM). */
  taglineBm: string;
  /** Festive ornament token (emoji / short decoration hint). */
  ornament: string;
};

export const DEFAULT_CAMPAIGN_THEME: CampaignThemeT = {
  accent: "#0D9488",
  accentSoft: "#CCFBF1",
  gradientFrom: "#0D9488",
  gradientTo: "#115E59",
  greeting: "Shop the campaign",
  greetingBm: "Belanja sekarang",
  tagline: "Deals from sellers across Malaysia",
  taglineBm: "Tawaran dari penjual seluruh Malaysia",
  ornament: "✨",
};

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const COLOR_FIELDS: (keyof CampaignThemeT)[] = ["accent", "accentSoft", "gradientFrom", "gradientTo"];
const COPY_FIELDS: (keyof CampaignThemeT)[] = ["greeting", "greetingBm", "tagline", "taglineBm"];
const COPY_MAX_LEN = 160;
const ORNAMENT_MAX_CHARS = 4; // code points (emojis are multi-code-unit)

/** Parse arbitrary JSON (Campaign.themeJson / request body) into a fully
 *  populated CampaignThemeT. Accepts an already-parsed object OR a JSON
 *  string. Unknown fields are dropped; every field falls back to its safe
 *  default individually — never throws. */
export function parseCampaignTheme(raw: unknown): CampaignThemeT {
  const out: CampaignThemeT = { ...DEFAULT_CAMPAIGN_THEME };
  let obj: unknown = raw;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return out;
    }
  }
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return out;
  const o = obj as Record<string, unknown>;
  for (const field of COLOR_FIELDS) {
    const v = o[field];
    if (typeof v === "string" && HEX_RE.test(v.trim())) out[field] = v.trim().toLowerCase();
  }
  for (const field of COPY_FIELDS) {
    const v = o[field];
    if (typeof v === "string" && v.trim() !== "") out[field] = v.trim().slice(0, COPY_MAX_LEN);
  }
  const ornament = o.ornament;
  if (typeof ornament === "string" && ornament.trim() !== "") {
    out.ornament = Array.from(ornament.trim()).slice(0, ORNAMENT_MAX_CHARS).join("");
  }
  return out;
}

/** Server-side validation for admin mutations. Unlike parseCampaignTheme
 *  (which silently defaults), this REPORTS bad fields so the admin UI can
 *  surface them. `theme` always contains a usable value (defaults filled in
 *  for the offending fields). */
export function validateCampaignTheme(input: unknown): {
  ok: boolean;
  errors: string[];
  theme: CampaignThemeT;
} {
  const theme = parseCampaignTheme(input);
  const errors: string[] = [];
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: true, errors, theme }; // absent/invalid theme → safe defaults
  }
  const obj = input as Record<string, unknown>;
  for (const field of COLOR_FIELDS) {
    const v = obj[field];
    if (v == null || v === "") continue; // missing → default (fine)
    if (typeof v !== "string" || !HEX_RE.test(v.trim())) {
      errors.push(`theme.${field} must be a hex colour like #10B981`);
    }
  }
  for (const field of COPY_FIELDS) {
    const v = obj[field];
    if (v == null || v === "") continue;
    if (typeof v !== "string") errors.push(`theme.${field} must be a string`);
    else if (v.trim() !== "" && v.length > COPY_MAX_LEN) errors.push(`theme.${field} must be ≤ ${COPY_MAX_LEN} characters`);
  }
  const ornament = obj.ornament;
  if (ornament != null && ornament !== "") {
    if (typeof ornament !== "string") errors.push("theme.ornament must be a string (emoji or short text)");
    else if (Array.from(ornament.trim()).length > ORNAMENT_MAX_CHARS) errors.push(`theme.ornament must be ≤ ${ORNAMENT_MAX_CHARS} characters`);
  }
  return { ok: errors.length === 0, errors, theme };
}

/** Serialize a theme for Campaign.themeJson. */
export function serializeCampaignTheme(theme: CampaignThemeT): string {
  return JSON.stringify(theme);
}

// ---------------------------------------------------------------------------
// Presets — 10 Malaysian festive / mega-sale campaigns
// ---------------------------------------------------------------------------

/** Date window. `start`/`end` are "MM-DD" strings in Asia/Kuala_Lumpur time
 *  (end inclusive, evaluated at 23:59:59.999 local). Windows WITHOUT `year`
 *  recur every Gregorian year; lunar/festival windows carry an explicit year
 *  for each known occurrence (2025 + 2026 per spec). */
export type CampaignPresetWindow = {
  /** Anchor year for one-off festival windows. Omit for recurring windows. */
  year?: number;
  /** "MM-DD" (MYT), inclusive. */
  start: string;
  /** "MM-DD" (MYT), inclusive. */
  end: string;
};

export type CampaignPreset = {
  id: string;
  name: string;
  /** Base theme applied when an admin picks the preset (fully editable). */
  theme: CampaignThemeT;
  windows: CampaignPresetWindow[];
};

export const CAMPAIGN_PRESETS: CampaignPreset[] = [
  {
    id: "raya-aidilfitri",
    name: "Hari Raya Aidilfitri",
    theme: {
      accent: "#10B981",
      accentSoft: "#D1FAE5",
      gradientFrom: "#10B981",
      gradientTo: "#065F46",
      greeting: "Selamat Hari Raya Aidilfitri",
      greetingBm: "Salam Aidilfitri — maaf zahir & batin",
      tagline: "Raya Mega Sale — festive deals up to 70% off",
      taglineBm: "Jualan Raya — tawaran istimewa sehingga 70%",
      ornament: "🌙",
    },
    // 1 Syawal: 31 Mar 2025 (MY) · expected 21 Mar 2026 (MY, astronomical est.)
    windows: [
      { year: 2025, start: "03-21", end: "04-07" },
      { year: 2026, start: "03-10", end: "03-28" },
    ],
  },
  {
    id: "cny",
    name: "Chinese New Year",
    theme: {
      accent: "#DC2626",
      accentSoft: "#FDE68A", // gold accent for chips/badges
      gradientFrom: "#DC2626",
      gradientTo: "#991B1B",
      greeting: "Gong Xi Fa Cai",
      greetingBm: "Selamat Tahun Baru Cina",
      tagline: "Prosperity deals — huat ah!",
      taglineBm: "Tawaran makmur sepanjang perayaan",
      ornament: "🏮",
    },
    // CNY: 29 Jan 2025 (Chap Goh Meh 12 Feb) · 17 Feb 2026 (Chap Goh Meh 3 Mar)
    windows: [
      { year: 2025, start: "01-20", end: "02-12" },
      { year: 2026, start: "02-08", end: "03-03" },
    ],
  },
  {
    id: "deepavali",
    name: "Deepavali",
    theme: {
      accent: "#7C3AED",
      accentSoft: "#EDE9FE",
      gradientFrom: "#7C3AED",
      gradientTo: "#4C1D95",
      greeting: "Happy Deepavali",
      greetingBm: "Selamat Hari Deepavali",
      tagline: "Festival of lights, festival of deals",
      taglineBm: "Tawaran ceria sepanjang Deepavali",
      ornament: "🪔",
    },
    // Deepavali (MY): 20 Oct 2025 · 8 Nov 2026
    windows: [
      { year: 2025, start: "10-13", end: "10-27" },
      { year: 2026, start: "11-01", end: "11-15" },
    ],
  },
  {
    id: "merdeka",
    name: "Merdeka Sale",
    theme: {
      accent: "#16A34A",
      accentSoft: "#DCFCE7",
      gradientFrom: "#16A34A",
      gradientTo: "#14532D",
      greeting: "Selamat Hari Merdeka",
      greetingBm: "Merdeka! Merdeka! Merdeka!",
      tagline: "Celebrate 31 August with homegrown deals",
      taglineBm: "Tawaran produk tempatan sepanjang Ogos",
      ornament: "🇲🇾",
    },
    windows: [{ start: "08-17", end: "08-31" }],
  },
  {
    id: "malaysia-day",
    name: "Malaysia Day Sale",
    theme: {
      accent: "#DC2626",
      accentSoft: "#FEE2E2",
      gradientFrom: "#DC2626",
      gradientTo: "#166534",
      greeting: "Selamat Hari Malaysia",
      greetingBm: "Selamat Hari Malaysia, 16 September",
      tagline: "One Malaysia, one big sale — Sabah & Sarawak included",
      taglineBm: "Jualan bersama seluruh Malaysia",
      ornament: "🇲🇾",
    },
    windows: [{ start: "09-09", end: "09-16" }],
  },
  {
    id: "ramadan-early-bird",
    name: "Ramadan Early-Bird",
    theme: {
      accent: "#0F766E",
      accentSoft: "#CCFBF1",
      gradientFrom: "#0F766E",
      gradientTo: "#134E4A",
      greeting: "Salam Ramadan",
      greetingBm: "Salam Ramadan al-Mubarak",
      tagline: "Early-bird Raya prep — baju, decor & hampers",
      taglineBm: "Belian awal persiapan Raya",
      ornament: "🌙",
    },
    // 1 Ramadan (MY): 18 Feb 2025 · expected 19 Feb 2026 (astronomical est.)
    windows: [
      { year: 2025, start: "02-18", end: "03-30" },
      { year: 2026, start: "02-19", end: "03-20" },
    ],
  },
  {
    id: "sale-99",
    name: "9.9 Mega Sale",
    theme: {
      accent: "#E11D48",
      accentSoft: "#FFE4E6",
      gradientFrom: "#E11D48",
      gradientTo: "#9F1239",
      greeting: "9.9 Super Shopping Day",
      greetingBm: "Jualan 9.9 bermula!",
      tagline: "Nine-nine deals, all week long",
      taglineBm: "Tawaran 9.9 sepanjang minggu",
      ornament: "🔥",
    },
    windows: [{ start: "09-01", end: "09-09" }],
  },
  {
    id: "sale-1010",
    name: "10.10 Mega Sale",
    theme: {
      accent: "#D97706",
      accentSoft: "#FEF3C7",
      gradientFrom: "#D97706",
      gradientTo: "#92400E",
      greeting: "10.10 Brand Fiesta",
      greetingBm: "Jualan 10.10 bermula!",
      tagline: "Perfect-ten deals from top brands",
      taglineBm: "Tawaran 10.10 dari jenama terkenal",
      ornament: "⚡",
    },
    windows: [{ start: "10-01", end: "10-10" }],
  },
  {
    id: "sale-1111",
    name: "11.11 Mega Sale",
    theme: {
      accent: "#EA580C",
      accentSoft: "#FFEDD5",
      gradientFrom: "#EA580C",
      gradientTo: "#9A3412",
      greeting: "11.11 Biggest One-Day Sale",
      greetingBm: "Jualan terbesar 11.11!",
      tagline: "Singles' Day savings across the marketplace",
      taglineBm: "Jimat besar sepanjang 11.11",
      ornament: "🎁",
    },
    windows: [{ start: "11-01", end: "11-11" }],
  },
  {
    id: "sale-1212",
    name: "12.12 Year-End Sale",
    theme: {
      accent: "#DB2777",
      accentSoft: "#FCE7F3",
      gradientFrom: "#DB2777",
      gradientTo: "#9D174D",
      greeting: "12.12 Year-End Wardrobe Sale",
      greetingBm: "Jualan hujung tahun 12.12!",
      tagline: "Close the year with the biggest cart",
      taglineBm: "Tamatkan tahun dengan tawaran terbaik",
      ornament: "🎉",
    },
    windows: [{ start: "12-01", end: "12-12" }],
  },
];

export function findCampaignPreset(presetId: string | null | undefined): CampaignPreset | undefined {
  if (!presetId) return undefined;
  return CAMPAIGN_PRESETS.find((p) => p.id === presetId);
}

// ---------------------------------------------------------------------------
// Date windows (Asia/Kuala_Lumpur = UTC+8, no DST)
// ---------------------------------------------------------------------------

const MYT_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar year of `d` when observed in MYT. */
function myYear(d: Date): number {
  return new Date(d.getTime() + MYT_MS).getUTCFullYear();
}

/** "MM-DD" + MYT year → Date at local midnight (00:00:00.000 MYT). */
function mytStart(year: number, mmdd: string): Date {
  const [m, d] = mmdd.split("-").map((n) => parseInt(n, 10));
  return new Date(Date.UTC(year, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0) - MYT_MS);
}

/** "MM-DD" + MYT year → Date at local end-of-day (23:59:59.999 MYT). */
function mytEnd(year: number, mmdd: string): Date {
  const [m, d] = mmdd.split("-").map((n) => parseInt(n, 10));
  return new Date(Date.UTC(year, (m ?? 1) - 1, d ?? 1, 23, 59, 59, 999) - MYT_MS);
}

export type CampaignDateRange = { start: Date; end: Date };

/** Nearest upcoming (or currently running) window for a preset, in MYT.
 *
 *  - Returns the window CONTAINING `now` when one is running (prefers the
 *    latest start if overlapping).
 *  - Otherwise the nearest window whose start is in the future.
 *  - Recurring (month/day) windows are materialised for the current and next
 *    MYT year, which handles the December → January year wrap.
 *  - If every hard-coded festival window is in the past (calendar exhausted),
 *    the windows are rolled forward by whole years so a "next occurrence"
 *    always exists.
 *  - `end` is inclusive (23:59:59.999 MYT). Returns null only if the preset
 *    has no windows at all. */
export function presetDateRange(preset: CampaignPreset, now: Date = new Date()): CampaignDateRange | null {
  if (!preset.windows.length) return null;
  const yNow = myYear(now);

  type Candidate = { start: Date; end: Date; recurring: boolean; anchorYear: number; mmStart: string; mmEnd: string };
  const candidates: Candidate[] = [];

  for (const w of preset.windows) {
    if (typeof w.year === "number") {
      candidates.push({
        start: mytStart(w.year, w.start),
        end: mytEnd(w.year, w.end),
        recurring: false,
        anchorYear: w.year,
        mmStart: w.start,
        mmEnd: w.end,
      });
    } else {
      for (const y of [yNow, yNow + 1]) {
        candidates.push({
          start: mytStart(y, w.start),
          end: mytEnd(y, w.end),
          recurring: true,
          anchorYear: y,
          mmStart: w.start,
          mmEnd: w.end,
        });
      }
    }
  }

  const containing = candidates
    .filter((c) => c.start <= now && now <= c.end)
    .sort((a, b) => b.start.getTime() - a.start.getTime()); // latest start wins
  if (containing.length > 0) {
    const c = containing[0]!;
    return { start: c.start, end: c.end };
  }

  const upcoming = candidates
    .filter((c) => c.start > now)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  if (upcoming.length > 0) {
    const c = upcoming[0]!;
    return { start: c.start, end: c.end };
  }

  // All hard-coded windows are past (festival presets only). Roll each window
  // forward by whole years until it is upcoming, then take the earliest.
  const rolled = candidates.map((c) => {
    const shift = Math.max(1, yNow - c.anchorYear + 1);
    const y = c.anchorYear + shift;
    return { start: mytStart(y, c.mmStart), end: mytEnd(y, c.mmEnd) };
  });
  rolled.sort((a, b) => a.start.getTime() - b.start.getTime());
  return rolled[0] ?? null;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

export type CampaignStatusT = "draft" | "scheduled" | "live" | "ended";

/** Derived status: unpublished → draft; published but not started → scheduled;
 *  published and inside the window → live; published after the window → ended. */
export function campaignStatusOf(
  c: { isPublished: boolean; startAt: Date | string | number; endAt: Date | string | number },
  now: Date = new Date()
): CampaignStatusT {
  if (!c.isPublished) return "draft";
  const startAt = new Date(c.startAt);
  const endAt = new Date(c.endAt);
  if (now < startAt) return "scheduled";
  if (now > endAt) return "ended";
  return "live";
}

/** Whole days from `now` until `target` (ceil; negative once past). */
export function daysUntil(target: Date | string | number, now: Date = new Date()): number {
  return Math.ceil((new Date(target).getTime() - now.getTime()) / DAY_MS);
}

// ---------------------------------------------------------------------------
// Active campaign resolution (60s cache on globalThis)
// ---------------------------------------------------------------------------

export type ActiveCampaign = {
  id: string;
  name: string;
  presetId: string | null;
  isPublished: boolean;
  /** ISO timestamps (client-safe). */
  startAt: string;
  endAt: string;
  theme: CampaignThemeT;
  /** Whole days remaining (ceil) while the campaign is live. */
  daysLeft: number;
};

const CAMPAIGN_CACHE_KEY = "__nomofee_active_campaign_cache";
const CAMPAIGN_CACHE_TTL_MS = 60_000;

type CampaignCache = { data: ActiveCampaign | null; expiresAt: number };

function campaignCache(): CampaignCache | undefined {
  return (globalThis as unknown as Record<string, CampaignCache | undefined>)[CAMPAIGN_CACHE_KEY];
}

function setCampaignCache(data: ActiveCampaign | null): void {
  (globalThis as unknown as Record<string, CampaignCache | undefined>)[CAMPAIGN_CACHE_KEY] = {
    data,
    expiresAt: Date.now() + CAMPAIGN_CACHE_TTL_MS,
  };
}

/** Drop the memoised active campaign. Every admin mutation MUST call this. */
export function invalidateCampaignCache(): void {
  delete (globalThis as unknown as Record<string, unknown>)[CAMPAIGN_CACHE_KEY];
}

/** The single published campaign whose window contains `now` (latest startAt
 *  first), or null. Memoised for 60s on globalThis; DB import is lazy so
 *  client components can safely import this module's presets/helpers. */
export async function resolveActiveCampaign(now: Date = new Date()): Promise<ActiveCampaign | null> {
  const cached = campaignCache();
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const { db } = await import("./db");
  const row = await db.campaign.findFirst({
    where: { isPublished: true, startAt: { lte: now }, endAt: { gte: now } },
    orderBy: { startAt: "desc" },
    take: 1,
  });

  const data: ActiveCampaign | null = row
    ? {
        id: row.id,
        name: row.name,
        presetId: row.presetId,
        isPublished: row.isPublished,
        startAt: row.startAt.toISOString(),
        endAt: row.endAt.toISOString(),
        theme: parseCampaignTheme(row.themeJson),
        daysLeft: daysUntil(row.endAt, now),
      }
    : null;

  setCampaignCache(data);
  return data;
}
