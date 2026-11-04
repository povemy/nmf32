// ============================================================================
// seed-campaigns.ts — Task 13-c campaign engine + work order 14 homepage
// placement demo data. Idempotent, safe to re-run at any time.
//
//   Run: bunx tsx prisma/seed-campaigns.ts   (or: bun prisma/seed-campaigns.ts)
//
// Creates (upsert by name so re-runs refresh instead of duplicating):
//   1. "Raya Mega Sale (demo)"              — LIVE, placement HERO (desktop +
//      mobile banner variants, CTA → flash deals), priority 10.
//   2. "Ramadan Early-Bird (demo)"          — LIVE, placement HERO_SECONDARY.
//   3. "CNY Lantern Preview (demo)"         — LIVE, placement SHOWCASE (card
//      thumbnail + description + CTA).
//   4. "Merdeka Home Essentials (demo)"     — LIVE, placement INLINE with a
//      product-query shelf ("set" — real seeded products).
//   5. "11.11 Sneak Peek (demo)"            — LIVE, placement PROMO_TILE.
//   6. "12.12 Year-End Warm-Up (draft demo)" — DRAFT (showcase) — never
//      visible to shoppers until published (the e2e suite also relies on it).
// All creative uses the deterministic /api/img placeholder service (the
// codebase's standard convention for seeded art).
// ============================================================================
import { PrismaClient } from "@prisma/client";
import {
  CAMPAIGN_PRESETS,
  campaignStatusOf,
  daysUntil,
  findCampaignPreset,
  presetDateRange,
  serializeCampaignTheme,
  type CampaignPlacement,
  type CampaignThemeT,
} from "../src/lib/campaigns";

const db = new PrismaClient();
const DAY_MS = 24 * 60 * 60 * 1000;

async function upsertCampaign(input: {
  name: string;
  presetId: string;
  theme: CampaignThemeT;
  isPublished: boolean;
  startAt: Date;
  endAt: Date;
  placement: CampaignPlacement;
  priority?: number;
  displayOrder?: number;
  description?: string | null;
  ctaLabel?: string | null;
  ctaHref?: string | null;
  bannerDesktopUrl?: string | null;
  bannerMobileUrl?: string | null;
  thumbnailUrl?: string | null;
  productQuery?: string | null;
}) {
  const { name, theme, ...rest } = input;
  const data = { ...rest, themeJson: serializeCampaignTheme(theme) };
  const existing = await db.campaign.findFirst({ where: { name } });
  if (existing) {
    const updated = await db.campaign.update({ where: { id: existing.id }, data });
    console.log(`[seed-campaigns] updated  "${name}" (${updated.placement}, ${campaignStatusOf(updated)}, ends in ${daysUntil(updated.endAt)}d)`);
    return updated;
  }
  const created = await db.campaign.create({ data: { name, ...data } });
  console.log(`[seed-campaigns] created  "${name}" (${created.placement}, ${campaignStatusOf(created)}, ends in ${daysUntil(created.endAt)}d)`);
  return created;
}

async function main() {
  const now = new Date();
  const preset = (id: string) => {
    const p = findCampaignPreset(id);
    if (!p) throw new Error(`preset ${id} missing from CAMPAIGN_PRESETS`);
    return p;
  };

  // 1) Live HERO campaign — Raya preset, desktop + mobile creative variants,
  //    CTA scrolls shoppers to the flash-deals section (a REAL destination).
  const raya = preset("raya-aidilfitri");
  await upsertCampaign({
    name: "Raya Mega Sale (demo)",
    presetId: raya.id,
    theme: raya.theme,
    isPublished: true,
    startAt: new Date(now.getTime() - 2 * DAY_MS),
    endAt: new Date(now.getTime() + 5 * DAY_MS),
    placement: "hero",
    priority: 10,
    displayOrder: 0,
    description: "Festive bundle deals across home, fashion & beauty — while the Raya window runs.",
    ctaLabel: "Shop Raya deals",
    ctaHref: "deals",
    bannerDesktopUrl: "/api/img/campaign-raya-hero?w=1400&h=480&label=Raya%20Mega%20Sale",
    bannerMobileUrl: "/api/img/campaign-raya-mobile?w=800&h=480&label=Raya%20Mega%20Sale",
    thumbnailUrl: "/api/img/campaign-raya-tile?w=600&h=420&label=Raya",
  });

  // 2) Live HERO_SECONDARY tile — Ramadan preset.
  const ramadan = preset("ramadan-early-bird");
  await upsertCampaign({
    name: "Ramadan Early-Bird (demo)",
    presetId: ramadan.id,
    theme: ramadan.theme,
    isPublished: true,
    startAt: new Date(now.getTime() - 1 * DAY_MS),
    endAt: new Date(now.getTime() + 4 * DAY_MS),
    placement: "hero_secondary",
    priority: 5,
    description: "Early-bird Raya prep — baju, decor & hampers.",
    ctaLabel: "Browse early",
    ctaHref: "search",
    bannerDesktopUrl: "/api/img/campaign-ramadan-tile?w=600&h=400&label=Ramadan%20Early-Bird",
    bannerMobileUrl: "/api/img/campaign-ramadan-tile?w=800&h=400&label=Ramadan",
  });

  // 3) Live SHOWCASE card — CNY preset.
  const cny = preset("cny");
  await upsertCampaign({
    name: "CNY Lantern Preview (demo)",
    presetId: cny.id,
    theme: cny.theme,
    isPublished: true,
    startAt: new Date(now.getTime() - 1 * DAY_MS),
    endAt: new Date(now.getTime() + 6 * DAY_MS),
    placement: "showcase",
    priority: 3,
    description: "Prosperity picks for the season — huat ah!",
    ctaLabel: "See the picks",
    ctaHref: "search",
    thumbnailUrl: "/api/img/campaign-cny-tile?w=600&h=420&label=CNY%20Lantern",
  });

  // 4) Live INLINE module with a product shelf — Merdeka preset. The query
  //    "set" matches real seeded active products (mug set, towel set, spoon
  //    set) — a CURATED shelf, never a price rule.
  const merdeka = preset("merdeka");
  await upsertCampaign({
    name: "Merdeka Home Essentials (demo)",
    presetId: merdeka.id,
    theme: merdeka.theme,
    isPublished: true,
    startAt: new Date(now.getTime() - 12 * 60 * 60 * 1000),
    endAt: new Date(now.getTime() + 3 * DAY_MS),
    placement: "inline",
    priority: 2,
    description: "Homegrown essentials for the merdeka week — curated sets from local sellers.",
    ctaLabel: "Shop the sets",
    ctaHref: "search:set",
    bannerDesktopUrl: "/api/img/campaign-merdeka-inline?w=1400&h=360&label=Merdeka%20Home%20Essentials",
    productQuery: "set",
  });

  // 5) Live PROMO_TILE — 11.11 preset.
  const s1111 = preset("sale-1111");
  await upsertCampaign({
    name: "11.11 Sneak Peek (demo)",
    presetId: s1111.id,
    theme: s1111.theme,
    isPublished: true,
    startAt: new Date(now.getTime() - 12 * 60 * 60 * 1000),
    endAt: new Date(now.getTime() + 7 * DAY_MS),
    placement: "promo_tile",
    priority: 1,
    ctaHref: "deals",
  });

  // 6) Unpublished DRAFT (showcase) — 12.12 preset + nearest upcoming window.
  //    Never visible to shoppers until published.
  const dd = preset("sale-1212");
  const range = presetDateRange(dd, now);
  if (!range) throw new Error("12.12 preset has no date windows");
  await upsertCampaign({
    name: "12.12 Year-End Warm-Up (draft demo)",
    presetId: dd.id,
    theme: dd.theme,
    isPublished: false,
    startAt: range.start,
    endAt: range.end,
    placement: "showcase",
    description: "Draft — publish when the year-end plan is final.",
  });

  console.log(`[seed-campaigns] presets available: ${CAMPAIGN_PRESETS.length}`);
  console.log("[seed-campaigns] done.");
}

main()
  .catch((e) => {
    console.error("[seed-campaigns] FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
