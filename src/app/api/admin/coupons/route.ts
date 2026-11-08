import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { handle, ok, okPaged, getPagination, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin, requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, reqStr, str, optNum, optDate, optBool } from "@/app/api/admin/_helpers";
import type { AdminCouponDetail, AdminCouponRow, AdminCouponsQuery, CouponCreateBody } from "@/lib/types/api-contract";

type CouponRecord = {
  id: string;
  scope: string;
  storeId: string | null;
  code: string;
  description: string | null;
  type: string;
  percent: number | null;
  amountMinor: number | null;
  minSpendMinor: number;
  maxRedemptions: number | null;
  perCustomerLimit: number;
  startsAt: Date | null;
  endsAt: Date | null;
  isActive: boolean;
  timesUsed: number;
  createdAt: Date;
  updatedAt: Date;
};

/** Coupon DB row → contract AdminCouponDetail (Dates → ISO strings). */
function serializeCoupon(c: CouponRecord): AdminCouponDetail {
  return {
    id: c.id,
    scope: c.scope,
    storeId: c.storeId,
    code: c.code,
    description: c.description,
    type: c.type,
    percent: c.percent,
    amountMinor: c.amountMinor,
    minSpendMinor: c.minSpendMinor,
    maxRedemptions: c.maxRedemptions,
    perCustomerLimit: c.perCustomerLimit,
    startsAt: c.startsAt ? c.startsAt.toISOString() : null,
    endsAt: c.endsAt ? c.endsAt.toISOString() : null,
    isActive: c.isActive,
    timesUsed: c.timesUsed,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

// GET /api/admin/coupons
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const url = new URL(req.url);
  const { page, size, skip, take } = getPagination(url);
  const scope: AdminCouponsQuery["scope"] = url.searchParams.get("scope") ?? undefined;

  const where: Prisma.CouponWhereInput = scope && scope !== "all" ? { scope } : {};
  const [rows, total] = await Promise.all([
    db.coupon.findMany({ where, include: { store: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" }, skip, take }),
    db.coupon.count({ where }),
  ]);
  const data: AdminCouponRow[] = rows.map((r) => ({ ...serializeCoupon(r), store: r.store }));
  return okPaged(data, { page, size, total });
});

// POST /api/admin/coupons
// Phase 3 (§3.2 coupons row): platform coupons are honoured by server pricing
// (pricing.ts) — writing them is a marketing-tier money lever, now gated to
// `campaigns.manage` (superadmin | ops). Reads (GET above) stay admin-wide.
export const POST = handle(async (req: NextRequest) => {
  const admin = await requireCap("campaigns.manage");
  const body = (await readBody(req)) as CouponCreateBody & Record<string, unknown>;

  const code = reqStr(body, "code", "code").toUpperCase();
  const exists = await db.coupon.findUnique({ where: { code } });
  if (exists) throw new ApiError(409, "CONFLICT", `Coupon code ${code} already exists`);

  const type = str(body, "type") ?? "percent";
  if (!["percent", "fixed", "freeship"].includes(type)) throw new ApiError(400, "VALIDATION", "type must be percent | fixed | freeship");
  const percent = optNum(body, "percent");
  if (percent != null && (percent < 0 || percent > 100)) throw new ApiError(400, "VALIDATION", "percent must be 0..100");
  const amountMinor = optNum(body, "amountMinor");
  if (amountMinor != null && amountMinor < 0) throw new ApiError(400, "VALIDATION", "amountMinor must be >= 0");
  if (type === "percent" && percent == null) throw new ApiError(400, "VALIDATION", "percent is required for percent coupons");
  if (type === "fixed" && amountMinor == null) throw new ApiError(400, "VALIDATION", "amountMinor is required for fixed coupons");

  const storeId = typeof body.storeId === "string" && body.storeId !== "" ? body.storeId : null;
  if (storeId) {
    const store = await db.store.findUnique({ where: { id: storeId } });
    if (!store) throw new ApiError(404, "NOT_FOUND", "Store not found");
  }

  const created = await db.coupon.create({
    data: {
      scope: storeId ? "store" : "platform",
      storeId,
      code,
      description: str(body, "description") ?? null,
      type,
      percent: percent ?? null,
      amountMinor: amountMinor != null ? Math.round(amountMinor) : null,
      minSpendMinor: Math.round(optNum(body, "minSpendMinor") ?? 0),
      maxRedemptions: optNum(body, "maxRedemptions") != null ? Math.round(optNum(body, "maxRedemptions") as number) : null,
      perCustomerLimit: Math.round(optNum(body, "perCustomerLimit") ?? 1),
      startsAt: optDate(body, "startsAt") ?? null,
      endsAt: optDate(body, "endsAt") ?? null,
      isActive: optBool(body, "isActive") ?? true,
    },
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "coupon.create",
    entityType: "coupon",
    entityId: created.id,
    after: { code, type, percent, amountMinor, scope: created.scope },
  });

  const payload: AdminCouponDetail = serializeCoupon(created);
  return ok(payload);
});
