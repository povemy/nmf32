import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { parsePageDoc } from "@/lib/sections";

export const dynamic = "force-dynamic";

// GET /api/store/pages/[id] — full page with parsed draft + published docs.
// Added by Task 2-d (additive, read-only complement to the 2-b pages API):
// the builder needs the raw draft sections, which the list endpoint (summary
// only) and PUT-draft round-trip cannot provide without overwriting the draft.
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { store } = await requireActiveSellerStore();
  const { id } = await ctx.params;

  const page = await db.cmsPage.findFirst({ where: { OR: [{ id }, { slug: id }], storeId: store.id } });
  if (!page) throw new ApiError(404, "NOT_FOUND", "Page not found");

  return ok({
    page: {
      id: page.id,
      slug: page.slug,
      title: page.title,
      pageType: page.pageType,
      draftVersion: page.draftVersion,
      publishedVersion: page.publishedVersion,
      hasUnpublished: page.hasUnpublished,
      published: !!page.publishedJson && page.publishedVersion > 0,
    },
    draft: parsePageDoc(page.draftJson),
    published: page.publishedJson ? parsePageDoc(page.publishedJson) : null,
  });
});
