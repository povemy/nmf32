import { handle, ok, ApiError } from "@/lib/api";
import { parseTheme } from "@/lib/sections";
import { db } from "@/lib/db";
import { parseJson } from "@/lib/json";
import { productCardInclude, toProductCard, minVariant, type ProductWithRelations } from "../../../_shared/product-card";

export const dynamic = "force-dynamic";

// GET /api/sf/[slug]/cart-settings — public: the store's cart drawer
// configuration + the resolved upsell product cards. Read-only shaping for
// the shopper-facing drawer; contains no seller-private fields.
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ slug: string }> }) => {
  const { slug } = await ctx.params;
  const store = await db.store.findUnique({ where: { slug }, select: { id: true, name: true, slug: true, status: true, themeJson: true } });
  if (!store || store.status !== "live") throw new ApiError(404, "STORE_NOT_FOUND", "Store not found");

  const settings = await db.cartSettings.findUnique({ where: { storeId: store.id } });

  // Best-seller fallback (Task 30) — resolved for EVERY live store regardless
  // of config. The drawer's cross-vendor AOV strip uses it for stores that
  // have NO cart-experience config yet, so a 2-vendor cart surfaces
  // recommendations from BOTH sellers instead of only the configured one.
  const toUpsellCard = (p: ProductWithRelations) => {
    const card = toProductCard(p);
    const mv = minVariant(p.variants);
    return { ...card, variantId: mv?.id ?? null, stock: mv?.stock ?? 0 };
  };
  const bestSellerProducts = await db.product.findMany({
    where: { storeId: store.id, status: "active" },
    include: productCardInclude,
    orderBy: [{ salesCount: "desc" }, { ratingCount: "desc" }],
    take: 4,
  });
  const bestSellers = bestSellerProducts.map(toUpsellCard);

  // No config yet → drawer runs on platform defaults (null settings); the
  // best-seller fallback still ships so multi-vendor carts can represent
  // this store in the cross-vendor strip.
  if (!settings) {
    return ok({ store: { id: store.id, name: store.name, slug: store.slug, theme: parseTheme(store.themeJson) }, settings: null, upsell: [], bestSellers });
  }

  // Resolve upsell products: manual picks first, otherwise the store's
  // best-selling active products (auto mode). Always in-stock, always this
  // store, capped at upsellLimit + 2 so the drawer can hide items already
  // in the cart and still show a full strip.
  let products: ProductWithRelations[] = [];
  if (settings.upsellEnabled) {
    if (settings.upsellMode === "manual") {
      const ids = parseJson<string[]>(settings.upsellProductIdsJson, []);
      if (ids.length > 0) {
        products = await db.product.findMany({
          where: { storeId: store.id, id: { in: ids }, status: "active" },
          include: productCardInclude,
          take: settings.upsellLimit + 2,
        });
        // preserve the seller's chosen order
        const byId = new Map(products.map((p) => [p.id, p]));
        products = ids.map((id) => byId.get(id)).filter((p): p is ProductWithRelations => Boolean(p));
      }
    } else {
      products = await db.product.findMany({
        where: { storeId: store.id, status: "active" },
        include: productCardInclude,
        orderBy: [{ salesCount: "desc" }, { ratingCount: "desc" }],
        take: settings.upsellLimit + 2,
      });
    }
  }

  return ok({
    store: { id: store.id, name: store.name, slug: store.slug, theme: parseTheme(store.themeJson) },
    settings: {
      layout: settings.layout,
      showFreeShippingBar: settings.showFreeShippingBar,
      freeShipThresholdMinor: settings.freeShipThresholdMinor,
      upsellEnabled: settings.upsellEnabled,
      upsellMode: settings.upsellMode,
      upsellTitle: settings.upsellTitle,
      upsellLimit: settings.upsellLimit,
      urgencyStockEnabled: settings.urgencyStockEnabled,
      urgencyStockThreshold: settings.urgencyStockThreshold,
      urgencyViewersEnabled: settings.urgencyViewersEnabled,
      urgencyViewersMin: settings.urgencyViewersMin,
      urgencyViewersMax: settings.urgencyViewersMax,
      urgencyCountdownEnabled: settings.urgencyCountdownEnabled,
      urgencyCountdownMinutes: settings.urgencyCountdownMinutes,
      showOrderNote: settings.showOrderNote,
      showDiscountHint: settings.showDiscountHint,
      checkoutLabel: settings.checkoutLabel,
      showContinueShopping: settings.showContinueShopping,
      stickyCta: settings.stickyCta,
      trustBadges: parseJson<string[]>(settings.trustBadgesJson, []),
    },
    upsell: products.map(toUpsellCard),
    bestSellers,
  });
});
