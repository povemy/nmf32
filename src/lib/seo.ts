// SEO structured-data builders (Phase 9) — JSON-LD for product pages + breadcrumbs.
// Data comes ONLY from real stored records (spec §9.1: no invented attributes).
import type { ProductCardT } from "@/components/shopper/ui-bits";

export function origin(): string {
  if (typeof window !== "undefined") return window.location.origin;
  return process.env.PUBLIC_APP_ORIGIN || "";
}

export function productJsonLd(input: {
  title: string;
  description?: string | null;
  image?: string | null;
  priceMinor: number;
  currency: string;
  storeName: string;
  storeSlug: string;
  productSlug: string;
  ratingAvg?: number;
  ratingCount?: number;
  stock?: number | null;
  urlPath?: string;
}) {
  const o = origin();
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: input.title,
    description: (input.description ?? input.title).slice(0, 500),
    image: input.image ? [input.image.startsWith("http") ? input.image : `${o}${input.image}`] : undefined,
    brand: { "@type": "Brand", name: input.storeName },
    offers: {
      "@type": "Offer",
      url: `${o}${input.urlPath ?? `/?sf=${input.storeSlug}&sp=${input.productSlug}`}`,
      priceCurrency: input.currency,
      price: (input.priceMinor / 100).toFixed(2),
      availability: input.stock === null || (input.stock ?? 1) > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      seller: { "@type": "Organization", name: input.storeName },
    },
  };
  if (input.ratingCount && input.ratingCount > 0 && input.ratingAvg && input.ratingAvg > 0) {
    data.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: input.ratingAvg.toFixed(1),
      reviewCount: input.ratingCount,
    };
  }
  return data;
}

export function breadcrumbJsonLd(items: { name: string; urlPath: string }[]) {
  const o = origin();
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: `${o}${it.urlPath}`,
    })),
  };
}

/** Inject (or replace) a JSON-LD script tag in the document head. */
export function injectJsonLd(id: string, data: Record<string, unknown> | null) {
  if (typeof document === "undefined") return;
  const existing = document.getElementById(id);
  if (existing) existing.remove();
  if (!data) return;
  const el = document.createElement("script");
  el.type = "application/ld+json";
  el.id = id;
  el.textContent = JSON.stringify(data);
  document.head.appendChild(el);
}

/** Client-side meta tag update for the single-route storefront. */
export function setMeta(title: string, description?: string | null, canonicalPath?: string, noindex = false) {
  if (typeof document === "undefined") return;
  document.title = title;
  const setTag = (attr: "name" | "property", key: string, content: string) => {
    let el = document.head.querySelector(`meta[${attr}="${key}"]`);
    if (!el) {
      el = document.createElement("meta");
      el.setAttribute(attr, key);
      document.head.appendChild(el);
    }
    el.setAttribute("content", content);
  };
  if (description !== undefined && description !== null) {
    setTag("name", "description", description.slice(0, 160));
    setTag("property", "og:description", description.slice(0, 160));
  }
  setTag("property", "og:title", title);
  setTag("name", "robots", noindex ? "noindex, nofollow" : "index, follow");
  if (canonicalPath) {
    let link = document.head.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.rel = "canonical";
      document.head.appendChild(link);
    }
    link.href = `${origin()}${canonicalPath}`;
  }
}

export type { ProductCardT };
