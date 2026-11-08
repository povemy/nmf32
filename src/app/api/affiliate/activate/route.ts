import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { activateAffiliate, resolveReferralCookie, getAffiliateSettings } from "@/lib/affiliate";
import type { ActivateBody, ActivateData, ActivateContextData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/affiliate/activate — join the affiliate programme (spec §5).
// Shopper-authenticated, rate-limited, sponsor assigned SERVER-SIDE only
// (first-touch referral cookie precedence, one-time manual code entry,
// explicit confirmation). The relationship locks permanently on activation.
export const POST = handle(async (req: Request) => {
  rateLimit(req, "affiliate-activate", 5);
  const me = await requireShopper();
  const body = (await req.json().catch(() => ({}))) as ActivateBody;
  if (body.termsAccepted !== true) {
    throw new ApiError(400, "TERMS_REQUIRED", "You must accept the affiliate programme terms to activate");
  }
  const result = await activateAffiliate({
    userId: me.id,
    email: me.email,
    fullName: me.fullName,
    displayName: body.displayName != null ? String(body.displayName).slice(0, 60) : undefined,
    bio: body.bio != null ? String(body.bio).slice(0, 500) : undefined,
    slug: body.slug != null ? String(body.slug).slice(0, 24) : undefined,
    sponsorCode: body.sponsorCode != null ? String(body.sponsorCode).trim() : undefined,
    sponsorConfirmed: body.sponsorConfirmed === true,
  });
  // activateAffiliate declares sponsorSource as string | null but only ever
  // assigns the two contract literals — narrowing keeps the payload honest.
  const sponsorSource: ActivateData["sponsorSource"] =
    result.sponsorSource === "referral_touch" || result.sponsorSource === "code_entry"
      ? result.sponsorSource
      : null;
  const payload: ActivateData = {
    profile: {
      id: result.profile.id, code: result.profile.code, slug: result.profile.slug,
      displayName: result.profile.displayName, status: result.profile.status,
      sponsorId: result.profile.sponsorId,
    },
    sponsor: result.sponsor,
    sponsorSource,
  };
  return ok(payload, { status: 201 });
});

// GET — pre-activation context: programme status + the pending sponsor the
// visitor's first-touch referral cookie resolves to (for the confirmation UI).
export const GET = handle(async () => {
  const settings = await getAffiliateSettings();
  const touch = await resolveReferralCookie();
  const payload: ActivateContextData = {
    enabled: settings.enabled,
    sponsorEnabled: settings.sponsorEnabled,
    maxRateBps: settings.maxRateBps,
    invitedBy: touch?.displayName ?? null,
    invitedByCode: touch?.code ?? null,
  };
  return ok(payload);
});
