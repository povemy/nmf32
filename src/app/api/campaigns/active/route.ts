import { handle, ok } from "@/lib/api";
import { resolveActiveCampaign } from "@/lib/campaigns";
import type { MarketActiveCampaignData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/campaigns/active — PUBLIC.
// Returns the single published campaign whose window contains `now`
// (latest startAt wins), or `null` when none is running. Shape:
// { id, name, presetId, isPublished, startAt, endAt, theme, daysLeft }.
export const GET = handle(async () => {
  const campaign: MarketActiveCampaignData | null = await resolveActiveCampaign();
  return ok(campaign);
});
