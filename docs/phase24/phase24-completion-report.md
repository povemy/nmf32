# Phase 2.4 — MARKETPLACE EXPERIENCE, SEARCH & GROWTH — Completion Report

**Programme:** Consolidated Remediation Programme (writing-block.md) · **Phase:** 2.4 of 3
**Status:** IMPLEMENTATION-COMPLETE · **Evidence standard:** code-level verified + live smoke in this sandbox.

---

## 1. Item-by-item verdicts (programme §22–26)

| # | Item | Verdict | Outcome |
|---|---|---|---|
| 1 | **C2.2 main marketplace search** | CONFIRMED (case-sensitive substring) → **FIXED** | `GET /api/market/products` now uses the shared tokenized engine (`market/_shared/search.ts`): case-insensitive ILIKE per token across **title/description/category/store**, multi-word AND semantics, `%` prefix wildcards; **`sort=relevance` ("Best match")** with deterministic candidate window (≤200 by sales), in-memory ranking, tiebreak chain score ▸ salesCount ▸ rating ▸ createdAt ▸ id; all SQL sorts gained `{id:"asc"}` (deterministic pagination); submit-only UX preserved (verified: ZERO frontend callers of suggest/related; header search fires on Enter/button only); cache wrapper + `normalizeSearchQuery` cache-key protection intact. Live matrix: `pulse`/`PULSE` (was 0) → 1; store/category/description-only hits verified; repeat relevance calls byte-identical. |
| 2 | **PostgreSQL search indexes** | MISSING → **MIGRATION CREATED (not applied)** | `20261109000000_phase24_search_indexes`: `pg_trgm` extension + GIN trigram indexes on the exact tokenized columns (Product.title/description, Store.name, Category.name); Supabase owner-rights + CONCURRENTLY notes included. Staging checklist (EXPLAIN before/after at 10k/100k rows) in agent-ctx `P2.4-1`. |
| 3 | **Submit-only search preserved** | VERIFIED intact | No per-keystroke requests; pagination/filters/sorting carry the submitted keyword; sort change resets page (latent append bug fixed). |
| 4 | **C3 external-marketplace sync warning** | MISSING → **ADDED** | Amber Alert in the seller Import Centre with the exact required copy (no sync exists; nothing suggests otherwise); no two-way sync implemented (future feature needs its own idempotency/conflict design). |
| 5 | **Chat pagination + send throttling** | CONFIRMED (unbounded) → **FIXED** | Keyset pagination lib (`chat-pagination.ts`, `?before=` (createdAt,id) cursor, limit cap 200, hasMore) wired into both thread-message routes AFTER access control; "Load older messages" UI with scroll pinning (shopper + seller); `rateLimitKey(me.id, "chat-send-*", 20/min)` after auth on both POST routes (429 + retryAfterSeconds). Live-verified against the dev DB. |
| 6 | **Browser History support** | MISSING → **ADDED** | Checkout pushes/restores `{nomofeeCheckoutPhase}` entries through a single `goPhase()` (all 10 call sites); auth modal pushes a sentinel; mount stamps reload-safe state; documented limitation (residual phase entries after leaving checkout are consumed harmlessly). Mobile shoppers no longer exit the site on Back. |
| 7 | **Portal code splitting** | CONFIRMED (all portals loaded) → **IMPLEMENTED (safe subset)** | `next/dynamic(ssr:false)` for SellerShell + AdminShell in app-root — shopper sessions never download seller/admin bundles; docs/phase24/portal-code-splitting.md records the assessment + why deeper splitting stops there (no invented architecture). |
| 8 | **SEO + sitemap** | PARTIAL → **IMPROVED + HONEST** | Dynamic `robots.ts` (allow /, disallow /api/, sitemap ref — conflicting static file removed); sitemap verified (live stores of active sellers + active products, seller-status filter intact) with >5k-URL chunking how-to comment (not implemented — catalog tiny); ResultsView sets noindex for search states; product JSON-LD + meta remain client-rendered (SPA) — **SSR product pages documented as the future plan** in docs/phase24/seo.md, not faked. |
| 9 | **Metrics + operational cleanup** | CONFIRMED → **CLEANED** | Removed dead `maybeRunExpirySweepLazy` + dead `order-completion.ts`; broken pre-ledger finance scripts moved to `scripts/attic/` (documented, not deleted); `/api/metrics` token compare now constant-time; import category pollution fixed (whitelist-only mapping); notification read-state verified fine; 4 actively-misleading SQLite comments corrected; unused deps REPORTED ONLY (zero imports for lodash/react-hook-form/@hookform/resolvers/@tanstack/react-query — nothing uninstalled per restrictions). |
| 10 | **SM- → NM- order-number copy bug** | CONFIRMED → **FIXED** | Shopper checkout lookup hint + placeholder corrected to NM-; internal identifiers (X-SM-Client, sm_cart, etc.) deliberately kept (rebrand residue in docs left as history). |

## 2. Verification

- `tsc --noEmit | grep ^src/` → **0 errors** (re-verified today); eslint on all touched files clean; dev server 200s; sitemap/robots 200; live search matrix + keyset pagination + history integration smoke-tested (agent-ctx `P2.4-1`, `P2.4-2_3_4`).
- Cache invalidation after inventory changes: existing public-cache tags/bust behavior preserved and re-exercised by the sweep's conditional bust (Phase 2.2 G4 fix covers legacy releases too).

## 3. Deliberately NOT done (programme §29 anti-overengineering)

- No external search engine (Postgres trigram suffices at current scale; EXPLAIN evidence deferred to staging).
- No per-keystroke autocomplete re-introduced.
- No two-way marketplace synchronization.
- No UI redesign; no virtualization; no broad refactors.
