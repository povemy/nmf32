import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin, requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, reqStr, optNum, optDate } from "@/app/api/admin/_helpers";

// GET /api/admin/commission/overrides
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope");

  const rows = await db.commissionOverride.findMany({
    where: scope ? { scope } : {},
    orderBy: { createdAt: "desc" },
  });
  // names resolved manually (no relations declared on override model)
  const categoryIds = rows.map((r) => r.categoryId).filter((x): x is string => !!x);
  const sellerIds = rows.map((r) => r.sellerId).filter((x): x is string => !!x);
  const productIds = rows.map((r) => r.productId).filter((x): x is string => !!x);
  const [categories, sellers, products] = await Promise.all([
    categoryIds.length ? db.category.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } }) : [] as { id: string; name: string }[],
    sellerIds.length ? db.seller.findMany({ where: { id: { in: sellerIds } }, select: { id: true, displayName: true, email: true } }) : [] as { id: string; displayName: string; email: string }[],
    productIds.length ? db.product.findMany({ where: { id: { in: productIds } }, select: { id: true, title: true } }) : [] as { id: string; title: string }[],
  ]);
  const cMap = new Map(categories.map((c) => [c.id, c.name] as const));
  const sMap = new Map(sellers.map((s) => [s.id, s] as const));
  const pMap = new Map(products.map((p) => [p.id, p.title] as const));
  const data = rows.map((r) => ({
    ...r,
    categoryName: r.categoryId ? cMap.get(r.categoryId) ?? null : null,
    sellerName: r.sellerId ? sMap.get(r.sellerId)?.displayName ?? null : null,
    sellerEmail: r.sellerId ? sMap.get(r.sellerId)?.email ?? null : null,
    productName: r.productId ? pMap.get(r.productId) ?? null : null,
  }));
  return ok(data);
});

// POST /api/admin/commission/overrides (RBAC commission.manage)
export const POST = handle(async (req: NextRequest) => {
  const admin = await requireCap("commission.manage");
  const body = await readBody(req);

  const scope = reqStr(body, "scope", "scope");
  if (!["category", "seller", "product"].includes(scope)) {
    throw new ApiError(400, "VALIDATION", "scope must be category | seller | product");
  }
  const categoryId = typeof body.categoryId === "string" && body.categoryId !== "" ? body.categoryId : null;
  const sellerId = typeof body.sellerId === "string" && body.sellerId !== "" ? body.sellerId : null;
  const productId = typeof body.productId === "string" && body.productId !== "" ? body.productId : null;
  if (scope === "category" && !categoryId) throw new ApiError(400, "VALIDATION", "categoryId required for category scope");
  if (scope === "seller" && !sellerId) throw new ApiError(400, "VALIDATION", "sellerId required for seller scope");
  if (scope === "product" && !productId) throw new ApiError(400, "VALIDATION", "productId required for product scope");

  const percent = optNum(body, "percent");
  if (percent != null && (percent < 0 || percent > 100)) throw new ApiError(400, "VALIDATION", "percent must be 0..100");
  const fixedFeeMinor = optNum(body, "fixedFeeMinor");
  if (fixedFeeMinor != null && fixedFeeMinor < 0) throw new ApiError(400, "VALIDATION", "fixedFeeMinor must be >= 0");
  const holdDays = optNum(body, "holdDays");
  if (holdDays != null && (holdDays < 0 || holdDays > 60)) throw new ApiError(400, "VALIDATION", "holdDays must be 0..60");
  const validFrom = optDate(body, "validFrom") ?? null;
  const validTo = optDate(body, "validTo") ?? null;
  if (validFrom && validTo && validFrom > validTo) throw new ApiError(400, "VALIDATION", "validFrom must be before validTo");

  const created = await db.commissionOverride.create({
    data: {
      scope,
      categoryId,
      sellerId,
      productId,
      percent: percent ?? null,
      fixedFeeMinor: fixedFeeMinor != null ? Math.round(fixedFeeMinor) : null,
      holdDays: holdDays != null ? Math.round(holdDays) : null,
      validFrom,
      validTo,
      createdBy: admin.id,
    },
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "commission.override.create",
    entityType: "commission_override",
    entityId: created.id,
    after: { scope, categoryId, sellerId, productId, percent, fixedFeeMinor, holdDays },
  });

  return ok(created);
});
