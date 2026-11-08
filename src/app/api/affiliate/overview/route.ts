import { handle, ok } from "@/lib/api";
import { requireAffiliate } from "@/lib/affiliate";
import { hubOverview } from "@/lib/affiliate-queries";
import type { OverviewData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/affiliate/overview?days=30 — the hub Overview section (spec §3.A).
// Estimated analytics and authoritative financial figures are separated in
// the payload — never merged into one unexplained commission figure.
export const GET = handle(async (req: Request) => {
  const aff = await requireAffiliate();
  const url = new URL(req.url);
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days") ?? 30) || 30));
  const data = await hubOverview(aff.id, days);
  const payload: OverviewData = { ...data, days };
  return ok(payload);
});
