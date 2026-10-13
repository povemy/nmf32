import { z } from "zod";
import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";

export const dynamic = "force-dynamic";

function isExpired(v: { expiryAt: Date }): boolean {
  return v.expiryAt.getTime() < Date.now();
}

// GET /api/me/vouchers — the signed-in buyer's voucher wallet.
export const GET = handle(async () => {
  const me = await requireShopper();
  const rows = await db.userVoucher.findMany({
    where: { userId: me.id },
    orderBy: { claimedAt: "desc" },
    include: { voucher: true },
  });

  // Lazy expiry — rows past their expiry date flip to EXPIRED on read.
  const stale = rows.filter((r) => r.status === "AVAILABLE" && isExpired(r.voucher));
  if (stale.length > 0) {
    await db.userVoucher.updateMany({
      where: { id: { in: stale.map((r) => r.id) } },
      data: { status: "EXPIRED" },
    });
  }

  return ok({
    vouchers: rows.map((r) => ({
      id: r.id,
      status: r.status === "AVAILABLE" && isExpired(r.voucher) ? "EXPIRED" : r.status,
      claimedAt: r.claimedAt,
      usedAt: r.usedAt,
      voucher: {
        code: r.voucher.code,
        title: r.voucher.title,
        kind: r.voucher.kind,
        discountMinor: r.voucher.discountMinor,
        percentOff: r.voucher.percentOff,
        maxDiscountMinor: r.voucher.maxDiscountMinor,
        minSpendMinor: r.voucher.minSpendMinor,
        expiryAt: r.voucher.expiryAt,
      },
    })),
  });
});

const claimSchema = z.object({ code: z.string().trim().min(2).max(40) });

// POST /api/me/vouchers — claim a platform voucher from the pool by code.
export const POST = handle(async (req: Request) => {
  const me = await requireShopper();
  const parsed = claimSchema.safeParse((await req.json().catch(() => ({}))) as unknown);
  if (!parsed.success) throw new ApiError(400, "VALIDATION", "A voucher code is required");
  const code = parsed.data.code.toUpperCase();

  const voucher = await db.voucher.findUnique({ where: { code } });
  if (!voucher || !voucher.isActive) throw new ApiError(404, "NOT_FOUND", "That voucher code does not exist");
  if (isExpired(voucher)) throw new ApiError(410, "EXPIRED", "That voucher has expired");

  const held = await db.userVoucher.findUnique({
    where: { userId_voucherId: { userId: me.id, voucherId: voucher.id } },
  });
  if (held) throw new ApiError(409, "ALREADY_HELD", "You already have this voucher");

  const row = await db.userVoucher.create({
    data: { userId: me.id, voucherId: voucher.id, status: "AVAILABLE" },
    include: { voucher: true },
  });
  return ok({ voucher: { code: row.voucher.code, title: row.voucher.title }, status: "AVAILABLE" }, { status: 201 });
});
