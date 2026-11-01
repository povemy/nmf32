import type { MetadataRoute } from "next";

// Phase 2.4 SEO — robots.txt. The storefront is a client-rendered single-route
// app: "/" (and its ?sf=/?sp= query views) is the only crawlable surface; every
// dynamic payload is JSON under /api/ (no HTML, no SEO value, authenticated or
// rate-limited) — disallowed. Seller/admin portals are in-app state on the same
// route (no distinct URLs to disallow) and always require auth.
export default function robots(): MetadataRoute.Robots {
  const base = process.env.PUBLIC_APP_ORIGIN || "http://localhost:3000";
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/"] }],
    sitemap: `${base}/sitemap.xml`,
  };
}
