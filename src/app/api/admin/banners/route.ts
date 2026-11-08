import { NextRequest } from "next/server";
import { handle, ok, auditAdmin } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, reqStr, str, optNum, optBool } from "@/app/api/admin/_helpers";
import type { AdminBannerRow, BannerCreateBody } from "@/lib/types/api-contract";

/** MarketplaceBanner DB row → contract AdminBannerRow (Dates → ISO strings). */
function serializeBanner(
  b: {
    id: string;
    title: string;
    imageUrl: string;
    linkUrl: string | null;
    sortOrder: number;
    isActive: boolean;
    createdAt: Date;
  }
): AdminBannerRow {
  return {
    id: b.id,
    title: b.title,
    imageUrl: b.imageUrl,
    linkUrl: b.linkUrl,
    sortOrder: b.sortOrder,
    isActive: b.isActive,
    createdAt: b.createdAt.toISOString(),
  };
}

// GET /api/admin/banners
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const rows = await db.marketplaceBanner.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }] });
  const data: AdminBannerRow[] = rows.map(serializeBanner);
  return ok(data);
});

// POST /api/admin/banners
export const POST = handle(async (req: NextRequest) => {
  const admin = await requireAdmin();
  const body = (await readBody(req)) as BannerCreateBody & Record<string, unknown>;
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

  const payload: AdminBannerRow = serializeBanner(created);
  return ok(payload);
});
