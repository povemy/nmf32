import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { parsePageDoc, parseTheme } from "@/lib/sections";
import { parseSocial, cardStyleFor } from "../../_shared/product-card";

export const dynamic = "force-dynamic";

// GET /api/sf/[slug] — public storefront home (published page + theme + store info).
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ slug: string }> }) => {
  const { slug } = await ctx.params;
  const store = await db.store.findUnique({ where: { slug } });
  if (!store || store.status !== "live") {
    throw new ApiError(404, "STORE_NOT_FOUND", "Store not found");
  }

  let home = await db.cmsPage.findFirst({ where: { storeId: store.id, slug: "home" } });
  if (!home) home = await db.cmsPage.findFirst({ where: { storeId: store.id, pageType: "home" } });
  if (!home || !home.publishedJson) {
    throw new ApiError(404, "STORE_NOT_PUBLISHED", "Storefront has no published home page");
  }

  const doc = parsePageDoc(home.publishedJson);
  const followers = await db.storeFollow.count({ where: { storeId: store.id } }); // Task 10-d
  const cardStyle = await cardStyleFor(store.id);

  return ok({
    store: {
      id: store.id,
      name: store.name,
      slug: store.slug,
      tagline: store.tagline,
      logoUrl: store.logoUrl,
      bannerUrl: store.bannerUrl,
      description: store.description,
      theme: parseTheme(store.themeJson),
      whatsapp: store.whatsapp,
      supportEmail: store.supportEmail,
      supportPhone: store.supportPhone,
      social: parseSocial(store.socialJson),
      followers,
      cardStyle,
    },
    page: {
      id: home.id,
      title: home.title,
      slug: home.slug,
      sections: doc.sections,
      publishedVersion: home.publishedVersion,
    },
  });
});
