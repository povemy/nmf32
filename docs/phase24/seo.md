# SEO — storefront delivery status + plan (Phase 2.4)

**Current state (verified):** the storefront is a client-rendered single-route SPA (`/`).
Product "pages" are `/?sf=<store>&sp=<product>` served by JSON APIs
(`/api/sf/[slug]/products/[pSlug]`); there are NO server-rendered product pages, so no
`generateMetadata` per product exists. Crawlers that don't execute JS see only the static
site metadata from `src/app/layout.tsx`.

**What exists today:** `pdp.tsx` sets title/description/OG/canonical via `setMeta()`
(`src/lib/seo.ts`) and injects schema.org Product (with offers/aggregateRating) +
BreadcrumbList JSON-LD client-side; storefront.tsx sets store meta + canonical;
`sitemap.ts` lists live stores of active sellers + active products with lastmod;
`robots.ts` (new) allows `/`, disallows `/api/`, points at the sitemap; search/category
results (client query state, URL stays `/`) now set `noindex` via setMeta.

**Limitation:** meta/JSON-LD only materialize after JS executes — social scrapers
(Facebook/Twitter/WhatsApp) and non-JS crawlers read the static fallback only.

**Plan (SSR product pages — future phase):** add a server route `sf/[slug]/p/[pSlug]`
(App Router page, not API) that fetches the same DB records the JSON route uses and emits
`export async function generateMetadata()` (title/description/OG/canonical) + server-side
Product JSON-LD via `productJsonLd()` (reuse `src/lib/seo.ts` — it is runtime-agnostic,
`origin()` already handles the server side). Keep the SPA as the interactive layer;
the server page can render the same JSON-LD + meta and hydrate the client view.
Until then, sitemap + robots + client JSON-LD are the delivery surface.
