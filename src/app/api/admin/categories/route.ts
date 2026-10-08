import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin, slugify } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, reqStr, optNum } from "@/app/api/admin/_helpers";

// GET /api/admin/categories — nested tree (parents with children)
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const all = await db.category.findMany({
    include: { _count: { select: { products: true } } },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  const byParent = new Map<string | null, typeof all>();
  for (const c of all) {
    const key = c.parentId ?? null;
    const list = byParent.get(key) ?? [];
    list.push(c);
    byParent.set(key, list);
  }
  const build = (parentId: string | null): unknown[] =>
    (byParent.get(parentId) ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      commissionPercent: c.commissionPercent,
      imageUrl: c.imageUrl,
      sortOrder: c.sortOrder,
      productCount: c._count.products,
      children: build(c.id),
    }));
  return ok(build(null));
});

// POST /api/admin/categories {name, parentId?, commissionPercent?}
export const POST = handle(async (req: NextRequest) => {
  const admin = await requireAdmin();
  const body = await readBody(req);
  const name = reqStr(body, "name", "name");
  const parentId = typeof body.parentId === "string" && body.parentId !== "" ? body.parentId : null;
  const commissionPercent = optNum(body, "commissionPercent");
  if (commissionPercent != null && (commissionPercent < 0 || commissionPercent > 100)) {
    throw new ApiError(400, "VALIDATION", "commissionPercent must be 0..100");
  }
  if (parentId) {
    const parent = await db.category.findUnique({ where: { id: parentId } });
    if (!parent) throw new ApiError(404, "NOT_FOUND", "Parent category not found");
  }

  const base = slugify(name) || "category";
  let slug = base;
  let n = 2;
  while (await db.category.findUnique({ where: { slug } })) slug = `${base}-${n++}`;

  const created = await db.category.create({ data: { name, slug, parentId, commissionPercent: commissionPercent ?? null } });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "category.create",
    entityType: "category",
    entityId: created.id,
    after: { name, slug, parentId, commissionPercent: commissionPercent ?? null },
  });

  return ok(created);
});
