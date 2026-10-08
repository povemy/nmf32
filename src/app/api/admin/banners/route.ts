import { NextRequest } from "next/server";
import { handle, ok, auditAdmin } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, reqStr, str, optNum, optBool } from "@/app/api/admin/_helpers";

// GET /api/admin/banners
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const rows = await db.marketplaceBanner.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }] });
  return ok(rows);
});

// POST /api/admin/banners
export const POST = handle(async (req: NextRequest) => {
  const admin = await requireAdmin();
  const body = await readBody(req);
  const title = reqStr(body, "title", "title");
  const imageUrl = str(body, "imageUrl") ?? "/api/img/banner-new?w=1600&h=520&label=Banner";

  const created = await db.marketplaceBanner.create({
    data: {
      title,
      imageUrl,
      linkUrl: str(body, "linkUrl") ?? null,
      sortOrder: Math.round(optNum(body, "sortOrder") ?? 0),
      isActive: optBool(body, "isActive") ?? true,
    },
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "banner.create",
    entityType: "marketplace_banner",
    entityId: created.id,
    after: { title, imageUrl, linkUrl: created.linkUrl },
  });

  return ok(created);
});
