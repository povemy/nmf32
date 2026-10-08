import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { newSectionId, parsePageDoc } from "@/lib/sections";
import { toJson } from "@/lib/json";

export const dynamic = "force-dynamic";

async function ownPage(storeId: string, id: string) {
  const page = await db.cmsPage.findFirst({ where: { id, storeId } });
  if (!page) throw new ApiError(404, "NOT_FOUND", "Page not found");
  return page;
}

// PUT /api/store/pages/[id]/draft {sections: [{id, type, props}]}
export const PUT = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { me, store } = await requireActiveSellerStore();
  const { id } = await ctx.params;
  const page = await ownPage(store.id, id);
  const body = (await req.json().catch(() => ({}))) as { sections?: unknown };

  if (!Array.isArray(body.sections)) {
    throw new ApiError(400, "VALIDATION", "sections must be an array");
  }
  const sections = (body.sections as Record<string, unknown>[]).map((s) => ({
    id: s.id ? String(s.id) : newSectionId(),
    type: String(s.type ?? "rich_text"),
    props: (s.props ?? {}) as Record<string, unknown>,
  }));

  const doc = { sections, version: page.draftVersion + 1 };
  const updated = await db.cmsPage.update({
    where: { id: page.id },
    data: {
      draftJson: toJson(doc),
      draftVersion: page.draftVersion + 1,
      hasUnpublished: true,
    },
  });

  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "store.page.draft_saved",
    entityType: "cms_page",
    entityId: page.id,
    meta: { slug: page.slug, version: updated.draftVersion, sections: sections.length },
  });

  return ok({
    id: updated.id,
    slug: updated.slug,
    draftVersion: updated.draftVersion,
    hasUnpublished: updated.hasUnpublished,
    doc: parsePageDoc(updated.draftJson),
  });
});
