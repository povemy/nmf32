import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { parsePageDoc } from "@/lib/sections";

export const dynamic = "force-dynamic";

// GET /api/store/pages — list with publish state.
export const GET = handle(async () => {
  const { store } = await requireActiveSellerStore();
  const pages = await db.cmsPage.findMany({
    where: { storeId: store.id },
    orderBy: [{ pageType: "asc" }, { slug: "asc" }],
  });
  return ok(
    pages.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      pageType: p.pageType,
      draftVersion: p.draftVersion,
      publishedVersion: p.publishedVersion,
      hasUnpublished: p.hasUnpublished,
      published: !!p.publishedJson && p.publishedVersion > 0,
      sectionCount: parsePageDoc(p.draftJson).sections.length,
      updatedAt: p.updatedAt,
    }))
  );
});
