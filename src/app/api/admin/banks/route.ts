import { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

// GET /api/admin/banks?verified=true|false|all
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const url = new URL(req.url);
  const verified = url.searchParams.get("verified");

  const where = verified && verified !== "all" ? { verified: verified === "true" } : {};

  const rows = await db.bankAccount.findMany({
    where,
    include: {
      seller: {
        select: { id: true, email: true, fullName: true, displayName: true, status: true, store: { select: { id: true, name: true, slug: true } } },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const data = rows.map((b) => ({
    id: b.id,
    holderName: b.holderName,
    bankName: b.bankName,
    accountNumberMasked: b.accountNumberMasked,
    verified: b.verified,
    verifiedAt: b.verifiedAt,
    createdAt: b.createdAt,
    sellerId: b.seller.id,
    sellerLegalName: b.seller.fullName,
    sellerEmail: b.seller.email,
    sellerStatus: b.seller.status,
    storeName: b.seller.store?.name ?? null,
  }));
  return ok(data);
});
