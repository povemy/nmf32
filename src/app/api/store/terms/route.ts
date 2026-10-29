import { handle, ok } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { getSellerTerms } from "@/lib/seller-terms";

export const dynamic = "force-dynamic";

// GET /api/store/terms — the seller's EFFECTIVE platform terms (commission %,
// clearing hold, payout minimum, moderation window). Values resolve seller
// override ?? admin global setting, so every admin change reflects here
// automatically. Read-only; store identity comes from the session, never
// client input.
export const GET = handle(async (req: Request) => {
  rateLimit(req, "seller-terms", 60, 60_000);
  const { me } = await requireActiveSellerStore();
  return ok(await getSellerTerms(me.id));
});
