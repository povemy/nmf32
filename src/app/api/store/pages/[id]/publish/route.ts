import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";

export const dynamic = "force-dynamic";

// POST /api/store/pages/[id]/publish — draft becomes the published version.
export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { me, store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const page = await db.cmsPage.findFirst({ where: { id, storeId: store.id } });
  if (!page) throw new ApiError(404, "NOT_FOUND", "Page not found");

  const updated = await db.cmsPage.update({
    where: { id: page.id },
    data: {
      publishedJson: page.draftJson,
      publishedVersion: page.draftVersion,
      hasUnpublished: false,
    },
  });

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "store.page.published",
    entityType: "cms_page",
    entityId: page.id,
    meta: { slug: page.slug, publishedVersion: updated.publishedVersion },
  });

  return ok({
    id: updated.id,
    slug: updated.slug,
    publishedVersion: updated.publishedVersion,
    hasUnpublished: updated.hasUnpublished,
  });
});
