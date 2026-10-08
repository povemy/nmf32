import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";

export const dynamic = "force-dynamic";

function parseDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

// GET /api/store/coupons
export const GET = handle(async () => {
  const { store } = await requireActiveSellerStore();
  const coupons = await db.coupon.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: "desc" },
  });
  return ok(coupons);
});

// POST /api/store/coupons {code, type: percent|fixed|freeship, ...}
export const POST = handle(async (req: Request) => {
  const { me, store } = await requireActiveSellerStore();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const code = String(body.code ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,24}$/.test(code)) {
    throw new ApiError(400, "VALIDATION", "code must be 3-24 chars (A-Z, 0-9, - or _)");
  }
  const type = String(body.type ?? "percent");
  if (!["percent", "fixed", "freeship"].includes(type)) {
    throw new ApiError(400, "VALIDATION", "type must be percent | fixed | freeship");
  }
  const exists = await db.coupon.findUnique({ where: { code } });
  if (exists) throw new ApiError(409, "CODE_TAKEN", "Coupon code already exists");

  const percent = body.percent != null ? Number(body.percent) : null;
  const amountMinor = body.amountMinor != null ? Math.max(0, Math.round(Number(body.amountMinor))) : null;
  if (type === "percent" && (percent == null || percent <= 0 || percent > 100)) {
    throw new ApiError(400, "VALIDATION", "percent must be 1..100 for percent coupons");
  }
  if (type === "fixed" && (amountMinor == null || amountMinor <= 0)) {
    throw new ApiError(400, "VALIDATION", "amountMinor must be positive for fixed coupons");
  }

  const coupon = await db.coupon.create({
    data: {
      scope: "store",
      storeId: store.id,
      code,
      description: body.description != null ? String(body.description) : null,
      type,
      percent: type === "percent" ? percent : null,
      amountMinor: type === "fixed" ? amountMinor : null,
      minSpendMinor: body.minSpendMinor != null ? Math.max(0, Math.round(Number(body.minSpendMinor))) : 0,
      maxRedemptions: body.maxRedemptions != null ? Math.max(1, Math.round(Number(body.maxRedemptions))) : null,
      perCustomerLimit: body.perCustomerLimit != null ? Math.max(1, Math.round(Number(body.perCustomerLimit))) : 1,
      startsAt: parseDate(body.startsAt),
      endsAt: parseDate(body.endsAt),
      isActive: body.isActive === undefined ? true : !!body.isActive,
    },
  });

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "coupon.created",
    entityType: "coupon",
    entityId: coupon.id,
    meta: { code, type },
  });

  return ok(coupon, { status: 201 });
});
