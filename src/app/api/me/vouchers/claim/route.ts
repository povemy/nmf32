import { handle, ok, ApiError } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { claimVoucherForShopper } from "@/lib/vouchers";
import type { ClaimVoucherBody, ClaimVoucherData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/me/vouchers/claim — claim a pool voucher by {code} OR {voucherId}.
// 201 + {voucher, status:"AVAILABLE"} on success.
// 409 ALREADY_HELD (already in the wallet) · 409 QUOTA_EXHAUSTED (redeemable
// pool used up) · 404 unknown / inactive / expired / not started / dormant kind
// or store.
export const POST = handle(async (req: Request) => {
  const me = await requireShopper();
  const body = (await req.json().catch(() => ({}))) as ClaimVoucherBody;
  const code = typeof body.code === "string" ? body.code : null;
  const voucherId = typeof body.voucherId === "string" ? body.voucherId : null;
  if (!code?.trim() && !voucherId?.trim()) {
    throw new ApiError(400, "VALIDATION", "A voucher code or voucherId is required");
  }
  const res = await claimVoucherForShopper(me.id, { code, voucherId });
  const payload: ClaimVoucherData = {
    voucher: {
      id: res.voucher.id,
      code: res.voucher.code,
      title: res.voucher.title,
      kind: res.voucher.kind,
      scope: res.voucher.scope,
      expiryAt: res.voucher.expiryAt.toISOString(),
    },
    userVoucherId: res.userVoucher.id,
    status: res.userVoucher.status,
  };
  return ok(payload, { status: 201 });
});
