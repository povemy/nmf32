import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, logActivity } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, reqStr } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string; docId: string }> };

// POST /api/admin/sellers/[id]/kyc/[docId] {decision: approved|rejected, reason?}
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const admin = await requireCap("sellers.approve");
  const { id, docId } = await ctx.params;
  const body = await readBody(req);
  const decision = reqStr(body, "decision", "decision");
  if (!["approved", "rejected"].includes(decision)) throw new ApiError(400, "VALIDATION", "decision must be approved | rejected");
  const reason = typeof body.reason === "string" ? body.reason : null;
  if (decision === "rejected" && !reason) throw new ApiError(400, "VALIDATION", "reason is required when rejecting a document");

  const doc = await db.kycDocument.findUnique({ where: { id: docId } });
  if (!doc || doc.sellerId !== id) throw new ApiError(404, "NOT_FOUND", "KYC document not found for this seller");
  if (doc.status === decision) throw new ApiError(409, "CONFLICT", `Document already ${doc.status}`);

  const updatedDoc = await db.kycDocument.update({
    where: { id: docId },
    data: {
      status: decision,
      rejectReason: decision === "rejected" ? reason : null,
      reviewedBy: admin.email,
      reviewedAt: new Date(),
    },
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: `kyc.doc.${decision}`,
    entityType: "kyc_document",
    entityId: docId,
    before: { status: doc.status, docType: doc.docType, sellerId: id },
    after: { status: decision, reason, reviewedBy: admin.email },
  });

  // Auto-rule: all docs approved + ≥1 verified bank + ≥1 product ⇒ seller kycStatus approved.
  let sellerKycStatus: string | null = null;
  if (decision === "approved") {
    const seller = await db.seller.findUnique({
      where: { id },
      include: {
        kycDocuments: true,
        bankAccounts: true,
        store: { include: { _count: { select: { products: true } } } },
      },
    });
    if (seller && seller.kycDocuments.length > 0) {
      const allDocsApproved = seller.kycDocuments.every((d) => d.status === "approved");
      const bankVerified = seller.bankAccounts.some((b) => b.verified);
      const hasProduct = (seller.store?._count.products ?? 0) >= 1;
      if (allDocsApproved && bankVerified && hasProduct && seller.kycStatus !== "approved") {
        await db.seller.update({ where: { id }, data: { kycStatus: "approved" } });
        sellerKycStatus = "approved";
        await logActivity({
          actorType: "system",
          action: "seller.kyc.auto_approved",
          entityType: "seller",
          entityId: id,
          meta: { triggerDocId: docId, by: admin.email },
        });
      }
    }
  }

  return ok({ doc: updatedDoc, sellerKycStatus });
});
