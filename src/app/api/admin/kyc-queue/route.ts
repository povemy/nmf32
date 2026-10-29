import { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api";
import { requireCap } from "@/lib/auth";
import { db } from "@/lib/db";

// GET /api/admin/kyc-queue — sellers pending review with docs + banks + product count
// F-26 (Phase 3): KYC queue bundles identity documents, bank accounts and
// wallet balances — money/PII read, now gated to the approval tier
// (`sellers.approve`: superadmin | ops), matching the approve/reject/KYC
// decision routes this view feeds. Previously bare requireAdmin (moderator
// could read every pending seller's documents and accounts).
export const GET = handle(async (req: NextRequest) => {
  await requireCap("sellers.approve");
  const sellers = await db.seller.findMany({
    where: { status: "pending_review" },
    include: {
      kycDocuments: { orderBy: { createdAt: "asc" } },
      bankAccounts: true,
      store: { include: { _count: { select: { products: true } } } },
      wallet: true,
    },
    orderBy: { submittedAt: "asc" },
  });

  const cards = sellers.map((s) => ({
    id: s.id,
    email: s.email,
    fullName: s.fullName,
    displayName: s.displayName,
    phone: s.phone,
    status: s.status,
    kycStatus: s.kycStatus,
    riskTier: s.riskTier,
    submittedAt: s.submittedAt,
    createdAt: s.createdAt,
    store: s.store ? { id: s.store.id, name: s.store.name, slug: s.store.slug, productCount: s.store._count.products } : null,
    docs: s.kycDocuments,
    docsApproved: s.kycDocuments.filter((d) => d.status === "approved").length,
    docsTotal: s.kycDocuments.length,
    banks: s.bankAccounts.map((b) => ({ id: b.id, bankName: b.bankName, holderName: b.holderName, accountNumberMasked: b.accountNumberMasked, verified: b.verified })),
    wallet: s.wallet,
  }));
  return ok(cards);
});
