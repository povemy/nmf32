import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity, notify } from "@/lib/api";
import { requireSeller } from "@/lib/auth";
import type { OnboardingBody, OnboardingData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/store/onboarding {action:"submit"} — seller submits for KYC review.
export const POST = handle(async (req: Request) => {
  const me = await requireSeller();
  const body = (await req.json().catch(() => ({}))) as OnboardingBody;
  if (body.action !== "submit") {
    throw new ApiError(400, "BAD_REQUEST", 'action must be "submit"');
  }
  // PHASE 2.3 select hygiene (C2.7): explicit fields EXCLUDING the
  // un-migrated Seller.emailVerifiedAt (default select → P2022 pre-
  // migration 20261107000000).
  const seller = await db.seller.findUnique({
    where: { id: me.id },
    select: { id: true, email: true, displayName: true, status: true },
  });
  if (!seller) throw new ApiError(401, "UNAUTHORIZED", "Seller not found");
  if (!["onboarding", "rejected"].includes(seller.status)) {
    throw new ApiError(409, "INVALID_STATUS", `Cannot submit from status '${seller.status}'`);
  }

  // Same hygiene for the write: update() would RETURN all scalars — select
  // only the fields the response uses.
  const updated = await db.seller.update({
    where: { id: seller.id },
    data: { status: "pending_review", submittedAt: new Date(), rejectReason: null },
    select: { status: true, submittedAt: true },
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

  // submittedAt was just written above — the read-back is always set.
  const payload: OnboardingData = { status: updated.status, submittedAt: updated.submittedAt!.toISOString() };
  return ok(payload);
});
