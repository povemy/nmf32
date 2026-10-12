// Fixture connector (Phase 5) — DEMO ONLY, clearly labelled by the import engine.
// It exists so the full generate→claim→publish→checkout pipeline can be verified
// end-to-end in this environment without marketplace credentials. Every import
// produced through it is stamped isFixture=true and surfaced as "Demo data" in the
// UI. It is NOT a marketplace integration and never presented as one.
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import type { AuthStatus, MarketplaceConnector, NormalizedProduct, NormalizedShop, ResolvedUrl } from "./types";

const LOCAL_IMAGES = fs.existsSync(path.join(process.cwd(), "public", "products"))
  ? fs
      .readdirSync(path.join(process.cwd(), "public", "products"))
      .filter((f) => f.endsWith(".png"))
      .map((f) => `/products/${f}`)
  : [];

const TEMPLATE_CATEGORIES = ["Home & Living", "Gadgets", "Fashion", "Beauty & Personal Care", "Kitchen", "Snacks"];

const PRODUCT_TEMPLATES: { name: string; category: string; blurb: string; base: number }[] = [
  { name: "Signature Ceramic Mug", category: "Kitchen", blurb: "Hand-glazed stoneware mug with a soft matte finish.", base: 3900 },
  { name: "Everyday Canvas Tote", category: "Fashion", blurb: "Durable cotton canvas tote with an inner pocket.", base: 4500 },
  { name: "Minimal Desk Organizer", category: "Gadgets", blurb: "Steel desk organizer with a felt-lined base.", base: 5900 },
  { name: "Aroma Soy Candle", category: "Home & Living", blurb: "Hand-poured soy candle with a 40-hour burn time.", base: 2900 },
  { name: "Bamboo Serving Tray", category: "Kitchen", blurb: "Food-safe bamboo tray with cut-out handles.", base: 4900 },
  { name: "Hydrating Face Mist", category: "Beauty & Personal Care", blurb: "Alcohol-free facial mist with cucumber extract.", base: 3500 },
  { name: "Linen Cushion Cover", category: "Home & Living", blurb: "Stone-washed linen cover, 45×45cm, hidden zip.", base: 4200 },
  { name: "Wireless Earbuds Lite", category: "Gadgets", blurb: "Bluetooth 5.3 earbuds with a compact charging case.", base: 8900 },
  { name: "Weekender Duffel Bag", category: "Fashion", blurb: "Water-resistant weekend bag with shoe compartment.", base: 11900 },
];

const COLOR_OPTS = ["Ivory", "Sage", "Charcoal"];
const SIZE_OPTS = ["Standard", "Large"];

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function titleCase(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** Deterministic demo catalogue for a shop slug (6–9 products). */
export function generateFixtureCatalogue(shopSlug: string): { shop: NormalizedShop; products: NormalizedProduct[] } {
  const seed = hashStr(shopSlug);
  const count = 6 + (seed % 4);
  const products: NormalizedProduct[] = [];
  for (let i = 0; i < count; i++) {
    const tpl = PRODUCT_TEMPLATES[(seed + i * 3) % PRODUCT_TEMPLATES.length];
    const img = LOCAL_IMAGES.length > 0 ? LOCAL_IMAGES[(seed + i * 7) % LOCAL_IMAGES.length] : null;
    const id = `fx-${(seed % 100000) + i}`;
    const hasVariants = i % 2 === 0;
    const variants: NormalizedProduct["variants"] = [];
    const basePrice = tpl.base + ((seed + i) % 10) * 100;
    if (hasVariants) {
      const colors = COLOR_OPTS.slice(0, 2 + (i % 2));
      const sizes = tpl.category === "Fashion" ? SIZE_OPTS : [null];
      for (const c of colors) {
        for (const s of sizes) {
          if (s === null && sizes.length === 1 && tpl.category !== "Fashion") {
            // single non-size dimension
          }
          const opts = [{ name: "Colour", value: c }];
          if (s) opts.push({ name: "Size", value: s });
          variants.push({
            sourceModelId: `${id}-m${variants.length + 1}`,
            sourceSku: `${shopSlug.toUpperCase().slice(0, 4)}-${i}-${variants.length + 1}`,
            options: opts,
            priceMinor: basePrice + (s === "Large" ? 800 : 0) + variants.length * 100,
            compareAtPriceMinor: variants.length === 0 ? basePrice + 1500 : null,
            stock: 8 + ((seed + variants.length * 13) % 90),
            imageUrl: img,
            isAvailable: true,
          });
        }
      }
    }
    products.push({
      sourceProductId: id,
      title: `${tpl.name}${i > 4 ? ` — ${tpl.category.split(" ")[0]} Edition` : ""}`,
      descriptionHtml: `<p>${tpl.blurb}</p><p>Imported demo catalogue entry for <strong>${titleCase(shopSlug)}</strong>. Contents shown here are demo fixture data, not a live marketplace listing.</p>`,
      brand: titleCase(shopSlug),
      categoryHint: tpl.category,
      images: [
        { url: img ?? `/api/img/${id}?w=800&h=800&label=${encodeURIComponent(tpl.name)}`, sortOrder: 0, alt: tpl.name },
      ],
      variants: hasVariants
        ? variants
        : [
            {
              sourceModelId: `${id}-default`,
              sourceSku: `${shopSlug.toUpperCase().slice(0, 4)}-${i}-1`,
              options: [],
              priceMinor: basePrice,
              compareAtPriceMinor: (seed + i) % 3 === 0 ? basePrice + 2000 : null,
              stock: 15 + (seed % 50),
              imageUrl: img,
              isAvailable: true,
            },
          ],
      currency: "MYR",
      sourceStatus: "ACTIVE",
      sourceUrl: `https://demo.shopmesh.fixture/shop/${shopSlug}/product/${shopSlug}/${id}`,
      isAvailable: true,
      warnings: [],
    });
  }
  const shop: NormalizedShop = {
    sourceShopId: shopSlug,
    name: titleCase(shopSlug),
    logoUrl: null,
    region: "MY",
    productCountHint: products.length,
  };
  return { shop, products };
}

function prettyCategory(name: string): string {
  return TEMPLATE_CATEGORIES.includes(name) ? name : name;
}

export const fixtureConnector: MarketplaceConnector = {
  platform: "fixture",

  detect(url: URL) {
    if (url.hostname === "demo.shopmesh.fixture" || url.hostname.endsWith(".fixture.import")) return { platform: "fixture" as const };
    return null;
  },

  async resolve(url: URL): Promise<ResolvedUrl> {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "shop" && parts[1]) {
      return { platform: "fixture", urlType: "shop", shopId: parts[1], normalizedUrl: url.toString() };
    }
    if (parts[0] === "product" && parts[1] && parts[2]) {
      return { platform: "fixture", urlType: "product", shopId: parts[1], productId: parts[2], normalizedUrl: url.toString() };
    }
    if (parts[0]) return { platform: "fixture", urlType: "shop", shopId: parts[0], normalizedUrl: url.toString() };
    return { platform: "fixture", urlType: "unknown", normalizedUrl: url.toString() };
  },

  async authStatus(): Promise<AuthStatus> {
    return { envConfigured: true, connected: true, needsAuthorisation: false, missing: [] };
  },

  async beginAuthorisation() {
    return null; // fixture needs no authorisation
  },

  async exchangeCode() {
    throw new Error("Fixture connector does not support OAuth.");
  },

  async refreshIfNeeded() {},

  async getShop(_connectionId): Promise<NormalizedShop> {
    const conn = await db.marketplaceConnection.findUnique({ where: { id: _connectionId } });
    const slug = conn?.shopId ?? "demo-store";
    return { sourceShopId: slug, name: titleCase(slug), region: "MY" };
  },

  async listProductsPage(connectionId) {
    const conn = await db.marketplaceConnection.findUnique({ where: { id: connectionId } });
    const { products } = generateFixtureCatalogue(conn?.shopId ?? "demo-store");
    return { products: products.map((p) => ({ sourceProductId: p.sourceProductId })), nextCursor: null };
  },

  async getProduct(connectionId, sourceProductId) {
    const conn = await db.marketplaceConnection.findUnique({ where: { id: connectionId } });
    const { products } = generateFixtureCatalogue(conn?.shopId ?? "demo-store");
    const found = products.find((p) => p.sourceProductId === sourceProductId);
    if (!found) throw new Error(`Fixture product ${sourceProductId} not found`);
    return { ...found, categoryHint: found.categoryHint ? prettyCategory(found.categoryHint) : null };
  },
};
