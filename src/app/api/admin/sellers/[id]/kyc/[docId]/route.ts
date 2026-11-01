import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, logActivity } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, reqStr } from "@/app/api/admin/_helpers";

type Ctx = { params: Promise<{ id: string; docId: string }> };

// POST /api/admin/sellers/[id]/kyc/[docId] {decision: approved|rejected, reason?}
//
// PHASE 2.3 KYC HONESTY (C2.7 audit): a KycDocument row is METADATA ONLY
// (docType, fileName, status, reviewer, timestamps) — no document bytes are
// ingested or stored anywhere in this codebase, and no route creates these
// rows (they can only appear via out-of-band seeding). Reviewing here means
// an admin examined the submitted metadata and made a human judgment call;
// nothing in the response claims the document itself was received, stored
// securely, or cryptographically verified. Real document ingestion (object
// storage + retention policy) and provider-managed KYC are OPEN OWNER
// decisions — see docs/phase23/seller-verification.md.
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

  // Auto-rule (KEPT — this is a REAL verification in the only sense that
  // exists today): when the reviewer approves the last document AND ≥1 bank
  // account is admin-verified AND ≥1 product exists, seller.kycStatus flips
  // to "approved". "approved" means EXACTLY "an admin with the
  // sellers.approve capability reviewed the submitted KYC metadata, the
  // verified-bank flag and the store, and accepted the seller" — a human
  // review decision, not a cryptographic identity attestation. It is the
  // same tier of verification as the admin approve route. kycStatus is
  // DISPLAY-ONLY and is never enforced by any gate.
  let sellerKycStatus: string | null = null;
  if (decision === "approved") {
    // PHASE 2.3 select hygiene (C2.7): explicit fields EXCLUDING the
    // un-migrated Seller.emailVerifiedAt (default/include select → P2022
    // pre-migration 20261107000000).
    const seller = await db.seller.findUnique({
      where: { id },
      select: {
        kycStatus: true,
        kycDocuments: { select: { status: true } },
        bankAccounts: { select: { verified: true } },
        store: { select: { _count: { select: { products: true } } } },
      },
    });
    if (seller && seller.kycDocuments.length > 0) {
      const allDocsApproved = seller.kycDocuments.every((d) => d.status === "approved");
      const bankVerified = seller.bankAccounts.some((b) => b.verified);
      const hasProduct = (seller.store?._count.products ?? 0) >= 1;
      if (allDocsApproved && bankVerified && hasProduct && seller.kycStatus !== "approved") {
        // Same hygiene for the write: update() would RETURN all scalars —
        // select only what is (not) used; kycStatus is echoed from the
        // variable below, never from the returned row.
        await db.seller.update({ where: { id }, data: { kycStatus: "approved" }, select: { id: true } });
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
