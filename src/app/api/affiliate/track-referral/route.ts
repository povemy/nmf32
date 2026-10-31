import { handle, ok } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { trackReferralVisit } from "@/lib/affiliate-attribution";

export const dynamic = "force-dynamic";

// POST /api/affiliate/track-referral {code, channel?} — PUBLIC referral-link
// visit (the `/?ref={code}` landing). First valid touch wins: the server only
// records + sets the nm_aff_ref cookie when NO valid touch exists yet; a
// competing sponsor link can never overwrite the first touch (spec §5).
// Returns {invitedBy} so the landing can show "You were invited by @x".
export const POST = handle(async (req: Request) => {
  rateLimit(req, "affiliate-track-ref", 30);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const code = String(body.code ?? "").trim();
  if (!code) return ok({ invitedBy: null });
  const result = await trackReferralVisit(code, body.channel != null ? String(body.channel) : undefined);
  return ok({ invitedBy: result?.displayName ?? null });
});
