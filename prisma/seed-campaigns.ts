// ============================================================================
// seed-campaigns.ts — Task 13-c (campaign engine rebuild). Idempotent demo
// data for the campaign engine. Safe to re-run at any time.
//
//   Run: bunx tsx prisma/seed-campaigns.ts   (or: bun prisma/seed-campaigns.ts)
//
// Creates:
//   1. "Raya Mega Sale (demo)"  — LIVE now (ends in ~5 days), Raya Aidilfitri
//      preset theme, published.
//   2. "12.12 Year-End Warm-Up (draft demo)" — unpublished draft using the
//      12.12 preset theme + nearest upcoming 12.12 window.
// Both upsert by name so re-runs refresh dates instead of duplicating rows.
// ============================================================================
import { PrismaClient } from "@prisma/client";
import {
  CAMPAIGN_PRESETS,
  campaignStatusOf,
  daysUntil,
  presetDateRange,
  serializeCampaignTheme,
  CampaignThemeT,
} from "../src/lib/campaigns";

const db = new PrismaClient();
const DAY_MS = 24 * 60 * 60 * 1000;

const LIVE_NAME = "Raya Mega Sale (demo)";
const DRAFT_NAME = "12.12 Year-End Warm-Up (draft demo)";

async function upsertCampaign(input: {
  name: string;
  presetId: string;
  theme: CampaignThemeT;
  isPublished: boolean;
  startAt: Date;
  endAt: Date;
}) {
  const { name, theme, ...rest } = input;
  const data = { ...rest, themeJson: serializeCampaignTheme(theme) };
  const existing = await db.campaign.findFirst({ where: { name } });
  if (existing) {
    const updated = await db.campaign.update({ where: { id: existing.id }, data });
    console.log(`[seed-campaigns] updated  "${name}" (${campaignStatusOf(updated)}, ends in ${daysUntil(updated.endAt)}d)`);
    return updated;
  }
  const created = await db.campaign.create({ data: { name, ...data } });
  console.log(`[seed-campaigns] created  "${name}" (${campaignStatusOf(created)}, ends in ${daysUntil(created.endAt)}d)`);
  return created;
}

async function main() {
  const now = new Date();

  // 1) Live demo campaign — Raya preset theme, live NOW, ends in ~5 days.
  const raya = CAMPAIGN_PRESETS.find((p) => p.id === "raya-aidilfitri");
  if (!raya) throw new Error("Raya preset missing from CAMPAIGN_PRESETS");
  await upsertCampaign({
    name: LIVE_NAME,
    presetId: raya.id,
    theme: raya.theme,
    isPublished: true,
    startAt: new Date(now.getTime() - 2 * DAY_MS),
    endAt: new Date(now.getTime() + 5 * DAY_MS),
  });

  // 2) Unpublished draft — 12.12 preset theme + nearest upcoming 12.12 window.
  const dd = CAMPAIGN_PRESETS.find((p) => p.id === "sale-1212");
  if (!dd) throw new Error("12.12 preset missing from CAMPAIGN_PRESETS");
  const range = presetDateRange(dd, now);
  if (!range) throw new Error("12.12 preset has no date windows");
  await upsertCampaign({
    name: DRAFT_NAME,
    presetId: dd.id,
    theme: dd.theme,
    isPublished: false,
    startAt: range.start,
    endAt: range.end,
  });

  console.log(`[seed-campaigns] theme JSON sample: ${serializeCampaignTheme(raya.theme).slice(0, 80)}...`);
  console.log("[seed-campaigns] done.");
}

main()
  .catch((e) => {
    console.error("[seed-campaigns] FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
