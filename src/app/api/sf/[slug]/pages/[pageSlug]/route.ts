import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { parsePageDoc, parseTheme } from "@/lib/sections";
import { cardStyleFor } from "../../../../_shared/product-card";
import type { SfPageData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// GET /api/sf/[slug]/pages/[pageSlug] — published CMS page (about/contact/policies).
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ slug: string; pageSlug: string }> }) => {
  const { slug, pageSlug } = await ctx.params;

  // C1.3 defense-in-depth (V-F7 fix): live store + admin-approved seller —
  // an inactive seller's storefront surfaces 404 fail closed (sf/[slug] pattern).
  const store = await db.store.findFirst({ where: { slug, status: "live", seller: { is: { status: "active" } } } });
  if (!store) throw new ApiError(404, "STORE_NOT_FOUND", "Store not found");

  const page = await db.cmsPage.findFirst({ where: { storeId: store.id, slug: pageSlug } });
  if (!page || !page.publishedJson) throw new ApiError(404, "PAGE_NOT_PUBLISHED", "Page not found");

  const doc = parsePageDoc(page.publishedJson);
  const cardStyle = await cardStyleFor(store.id);

  const payload: SfPageData = {
    store: {
      id: store.id,
      name: store.name,
      slug: store.slug,
      tagline: store.tagline,
      logoUrl: store.logoUrl,
      whatsapp: store.whatsapp,
      supportEmail: store.supportEmail,
      theme: parseTheme(store.themeJson),
      cardStyle,
    },
    page: {
      id: page.id,
      title: page.title,
      slug: page.slug,
      pageType: page.pageType,
      publishedVersion: page.publishedVersion,
    },
    sections: doc.sections,
  };
  return ok(payload);
});
