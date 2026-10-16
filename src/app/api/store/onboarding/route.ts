import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity, notify } from "@/lib/api";
import { requireSeller } from "@/lib/auth";

export const dynamic = "force-dynamic";

// POST /api/store/onboarding {action:"submit"} — seller submits for KYC review.
export const POST = handle(async (req: Request) => {
  const me = await requireSeller();
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== "submit") {
    throw new ApiError(400, "BAD_REQUEST", 'action must be "submit"');
  }
  const seller = await db.seller.findUnique({ where: { id: me.id } });
  if (!seller) throw new ApiError(401, "UNAUTHORIZED", "Seller not found");
  if (!["onboarding", "rejected"].includes(seller.status)) {
    throw new ApiError(409, "INVALID_STATUS", `Cannot submit from status '${seller.status}'`);
  }

  const updated = await db.seller.update({
    where: { id: seller.id },
    data: { status: "pending_review", submittedAt: new Date(), rejectReason: null },
  });

  await notify({
    event: "kyc.submitted",
    channel: "email",
    recipient: "admin@nomofee.io",
    subject: `KYC review requested: ${seller.displayName}`,
  });
  await logActivity({
    actorType: "seller",
    actorId: seller.id,
    actorLabel: seller.email,
    action: "seller.onboarding.submitted",
    entityType: "seller",
    entityId: seller.id,
  });

  return ok({ status: updated.status, submittedAt: updated.submittedAt });
});
