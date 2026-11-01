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
  // PHASE 2.3 select hygiene (C2.7): explicit fields EXCLUDING the
  // un-migrated Seller.emailVerifiedAt (default/include select → P2022
  // pre-migration 20261107000000). Bank accounts are narrowed to
  // masked-display fields — the ciphertext (accountNumberEnc) is NEVER
  // returned by a read surface (C2.5).
  const sellers = await db.seller.findMany({
    where: { status: "pending_review" },
    select: {
      id: true,
      email: true,
      fullName: true,
      displayName: true,
      phone: true,
      status: true,
      kycStatus: true,
      riskTier: true,
      submittedAt: true,
      createdAt: true,
      kycDocuments: { orderBy: { createdAt: "asc" } },
      bankAccounts: {
        select: { id: true, bankName: true, holderName: true, accountNumberMasked: true, verified: true },
      },
      store: { select: { id: true, name: true, slug: true, _count: { select: { products: true } } } },
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
