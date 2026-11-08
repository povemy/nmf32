import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { parsePageDoc } from "@/lib/sections";
import { toJson } from "@/lib/json";
import type { SellerPageRevertData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/store/pages/[id]/revert — discard draft, restore published into draft.
export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const page = await db.cmsPage.findFirst({ where: { id, storeId: store.id } });
  if (!page) throw new ApiError(404, "NOT_FOUND", "Page not found");
  if (!page.publishedJson) {
    throw new ApiError(400, "NEVER_PUBLISHED", "Page has never been published — nothing to revert to");
  }

  // Keep the draft version counter monotonic while restoring published content.
  const published = parsePageDoc(page.publishedJson);
  const updated = await db.cmsPage.update({
    where: { id: page.id },
    data: {
      draftJson: toJson({ sections: published.sections, version: page.draftVersion }),
      hasUnpublished: false,
    },
  });

  const payload: SellerPageRevertData = {
    id: updated.id,
    slug: updated.slug,
    draftVersion: updated.draftVersion,
    hasUnpublished: updated.hasUnpublished,
    doc: parsePageDoc(updated.draftJson),
  };
  return ok(payload);
});
