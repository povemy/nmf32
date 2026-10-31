import { handle, ok, ApiError } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { resolveAffiliateLink } from "@/lib/affiliate-attribution";

export const dynamic = "force-dynamic";

// POST /api/affiliate/track {code} — PUBLIC promotional-link resolution (the
// `/?al={code}` landing). Rate-limited 60/min/IP. Server-side: validates the
// link, records the money-grade attribution touch keyed to the httpOnly
// visitor cookie, bumps the click counter, sets the advisory event cookie,
// and returns the navigation target + who shared it. Invalid/tampered codes
// fail closed (404) — no attribution is ever created from client input.
export const POST = handle(async (req: Request) => {
  rateLimit(req, "affiliate-track", 60);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const code = String(body.code ?? "").trim();
  if (!code) throw new ApiError(400, "VALIDATION", "code is required");
  const resolved = await resolveAffiliateLink(code);
  return ok({
    target: resolved.target,
    sharedBy: resolved.affiliate.displayName,
    linkType: resolved.link.type,
    channel: resolved.link.channel,
  });
});
