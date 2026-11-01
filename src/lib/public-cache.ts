// ============================================================================
// PUBLIC READ CACHE (Phase 2 / IMPLEMENTATION C) — tag-based data caching for
// personalization-free public routes, built on Next.js 16's official data-cache
// primitives (`unstable_cache` + `revalidateTag` from next/cache).
// ----------------------------------------------------------------------------
// POLICY (see Phase 2 report §C for the full design):
//   • Only PUBLIC, per-request-identical data is cached. NEVER: account info,
//     carts, checkout, orders, receipts, wallets, settlement, admin data, or
//     anything that reads cookies/session headers (C2 safety rule). The
//     sf/[slug] storefront view-tracker, for example, stays OUTSIDE the cached
//     function because it writes a cookie on the live response.
//   • TTLs are deliberately SHORT (30–60 s) — the consistency safety net that
//     bounds staleness even if a mutation route ever misses its invalidation
//     call. Checkout NEVER trusts cached values: it revalidates price/stock
//     transactionally inside its own READ-COMMITTED + CAS-guarded flow, so a
//     45 s-old listing price/stock display can never cause an oversell or a
//     wrong charge.
//   • Invalidation is COARSE and SIMPLE (per instruction): entity-level tags
//     ('pub:products', 'pub:stores', 'pub:market', 'pub:reviews',
//     'pub:campaigns') busted from the handful of mutation routes that change
//     the underlying data — not a distributed invalidation bus.
//
// Single-process note: the Next data cache is process-local here (standalone
// deployment, no ISR worker) — same scope as the existing in-memory limiter
// and checkout admission gate, consistent with the documented 1×1 topology.
// ============================================================================

import { unstable_cache, revalidateTag } from "next/cache";

/** Entity-level cache tags — the invalidation vocabulary. */
export const PUBLIC_CACHE_TAGS = {
  /** Any product mutation (create/update/delete/publish/price/stock-visible). */
  products: "pub:products",
  /** Any store mutation (settings/profile/theme/publish). */
  stores: "pub:stores",
  /** Marketplace home aggregates (banners, featured slots, top stores). */
  market: "pub:market",
  /** Review moderation transitions (published aggregates). */
  reviews: "pub:reviews",
  /** Campaign publish/window changes. */
  campaigns: "pub:campaigns",
} as const;

export type PublicCacheTag = (typeof PUBLIC_CACHE_TAGS)[keyof typeof PUBLIC_CACHE_TAGS];

/**
 * Wrap a personalization-free data loader in the Next data cache.
 * VERIFIED against the installed next@16.4.3 source: the returned function's
 * ARGUMENTS are part of the cache key (`invocationKey = fixedKey-JSON.stringify(args)`),
 * so per-request variance rides on the call args (route + shape identify the
 * fixed part). Cached values are JSON-serialized (Dates → ISO strings) —
 * output-equivalent to the uncached path because Response.json serializes
 * Dates identically. Create the wrapper at MODULE scope (the function's source
 * string is part of the fixed key — per-request wrappers never hit cache).
 * The wrapped function must be PURE: no cookie reads/writes, no request
 * context, no side-effect writes (analytics tracking stays at the call site).
 */
export function publicCache<TArgs extends unknown[], T>(
  fn: (...args: TArgs) => Promise<T>,
  keyParts: string[],
  opts: { ttl?: number; tags: PublicCacheTag[] }
): (...args: TArgs) => Promise<T> {
  return unstable_cache(fn, ["pub", ...keyParts], {
    revalidate: opts.ttl ?? 30,
    tags: opts.tags,
  });
}

/** Bust one or more entity tags (call AFTER a successful mutation commit).
 *  Next 16.4.3 API: revalidateTag(tag, profile). Profile semantics VERIFIED
 *  LIVE against the installed source + behaviour: "max" gives
 *  stale-while-revalidate (one stale serve, then fresh); `{ expire: 0 }` maps
 *  to the immediate-expiry branch (dynamic-rendering.js:
 *  `cacheLife?.expire === 0 → pathWasRevalidated`) — the next request
 *  re-fetches fresh data. */
export function bustPublicCache(...tags: PublicCacheTag[]): void {
  for (const t of tags) revalidateTag(t, { expire: 0 });
}

/**
 * Fail-safe variant for MUTATION routes: cache invalidation must never turn a
 * successful DB mutation into a 500 (a missed bust self-heals within the TTL
 * — the documented safety net). Use this inside route handlers.
 */
export function bustPublicCacheSafe(...tags: PublicCacheTag[]): void {
  try {
    bustPublicCache(...tags);
  } catch {
    /* TTL is the safety net — never fail a mutation over invalidation */
  }
}

/**
 * PHASE 2.1 (§9-A): bust the products tag after STOCK-MUTATING paths that are
 * not seller/admin mutations (those already bust via their own routes):
 *   • checkout commit (CAS stock decrement + salesCount bump)
 *   • expiry-sweep restock (failed/expired reservations released)
 *   • refund-related restock, cancellation restock (TTL safety net covers the
 *     rare paths; call this when a clean seam exists)
 * Displayed stock on public pages stays appropriately current (seconds, not
 * 45 s) while checkout keeps its authoritative transactional revalidation.
 */
export function bustPublicProductCache(): void {
  bustPublicCacheSafe(PUBLIC_CACHE_TAGS.products, PUBLIC_CACHE_TAGS.market);
}
