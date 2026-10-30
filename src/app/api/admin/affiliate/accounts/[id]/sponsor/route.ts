import { handle, ok, ApiError } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { auditAdmin } from "@/lib/api";
import { correctSponsor, findAffiliateByCode } from "@/lib/affiliate";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// POST /api/admin/affiliate/accounts/[id]/sponsor {sponsorCode?|null, reason}
// — the ONLY path that can change a sponsor relationship after activation
// (spec §4 rule 8: administrative correction with authorised audit logging
// and a documented reason). Sponsor snapshot on EXISTING OrderItems/commissions
// is never rewritten — only future attributions follow the correction.
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  rateLimit(req, "admin-aff-sponsor", 20);
  const admin = await requireCap("affiliate.manage");
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const reason = String(body.reason ?? "");
  const sponsorCode = body.sponsorCode != null ? String(body.sponsorCode).trim() : null;

  let newSponsorId: string | null = null;
  if (sponsorCode) {
    const sponsor = await findAffiliateByCode(sponsorCode);
    if (!sponsor) throw new ApiError(404, "NOT_FOUND", "No affiliate with that referral code");
    newSponsorId = sponsor.id;
  }

  const updated = await correctSponsor({ affiliateId: id, newSponsorId, reason, adminId: admin.id });
  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "affiliate.sponsor_correct",
    entityType: "affiliate_profile",
    entityId: id,
    before: { sponsorId: updated.sponsorId },
    after: { sponsorId: newSponsorId, reason },
  });
  return ok({ sponsorId: updated.sponsorId });
});
