import { handle, ok } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { getPlatformTermsPublic } from "@/lib/seller-terms";

export const dynamic = "force-dynamic";

// GET /api/platform/terms — PUBLIC global platform terms for the pre-auth
// seller portal (landing copy + registration terms). Exposes only
// business-policy values already printed on that public screen (commission %,
// hold days, fee flags + amounts, payout minimum, moderation window) — no PII,
// no seller-specific data. Backed by a 60 s TTL cache; rate-limited per IP.
export const GET = handle(async (req: Request) => {
  rateLimit(req, "platform-terms", 120, 60_000);
  return ok(await getPlatformTermsPublic());
});
