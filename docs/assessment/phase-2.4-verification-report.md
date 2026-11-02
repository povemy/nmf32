# Phase 2.4 — Marketplace Experience, Search & Maintenance — Stage-Gate Verification Report

**Stage expectation (owner):** *"Search, UX, marketplace discovery and remaining maintenance."*
**Verification date:** 2026-11 (this session) · **Method:** independent read-only code audit + live checks against the running dev server; claims cross-checked against `docs/phase24/phase24-completion-report.md`.
**Evidence standard:** code-level + live dev-server smoke. No code changes made.
**Verdict labels:** CONFIRMED / PARTIALLY CONFIRMED / NOT CONFIRMED / UNVERIFIABLE.

---

## 1. Stage verdict

**PASS on search / UX / marketplace discovery — CONDITIONAL PASS on "remaining maintenance": one live defect and a working-tree regression must be cleaned before this stage is closed.**

The core Phase 2.4 deliverables are real and live-verified: the tokenized case-insensitive search engine with deterministic relevance ranking works on the running server; chat keyset pagination + send throttling, checkout browser-history, portal code-splitting (verified live — no seller/admin chunks in a shopper first load), the sync warning, and the NM- copy fix are all in place. **However, the current working tree has regressed relative to the Phase 2.4 git commit (`184dd4a`)**: files that commit deleted were resurrected on disk by an environment restore, and one of them — `public/robots.txt` — now conflicts with `src/app/robots.ts`, making **`/robots.txt` return HTTP 500 on the live server right now** (personally verified: `curl → 500`, while `/sitemap.xml` and `/` return 200). Additionally, the storefront's own product search (`sf/[slug]/products`) still has the exact case-sensitivity bug class this phase fixed on the main market route.

The completion report's claims are accurate **as of the git commit**; they are not accurate **for the working tree as it sits today**.

---

## 2. Claim-by-claim verification

| # | Claim | Verdict | Key evidence |
|---|---|---|---|
| 1 | Tokenized case-insensitive search (C2.2 fix) | **CONFIRMED** | `src/app/api/market/_shared/search.ts:13-20` (tokenize: lowercase, `[a-z0-9%]` classes, 8-token cap), `:60-71` (per-token OR across title/description/category/store, AND across tokens, `mode:"insensitive"` → ILIKE), `:35-55` (scoring); `src/app/api/market/products/route.ts:91-93` (wiring), `:108-127` (relevance: `take:200` window ordered `salesCount desc, id asc`; in-memory chain score▸salesCount▸ratingAvg▸createdAt▸id), `:130-133` (all four SQL sorts carry `{id:"asc"}`), `:154` (`normalizeSearchQuery` in cache key). **Live-verified:** `pulse`/`PULSE`/`Pulse` all hit; `earbuds pulse` matches (AND); `pulse zzzzznotaword` → 0; store-name-only hit works; repeat relevance calls byte-identical. Postgres datasource confirmed (schema.prisma:5-11) so ILIKE is valid. |
| 2 | PostgreSQL search indexes migration | **CONFIRMED** (created, NOT applied) | `prisma/migrations/20261109000000_phase24_search_indexes/migration.sql` — `pg_trgm` + GIN `gin_trgm_ops` on exactly the tokenized columns (Product.title/description, Store.name, Category.name); header states "CREATED, NOT APPLIED"; read-only `prisma migrate status` confirms not applied. |
| 3 | Submit-only search UX | **CONFIRMED** | Grep across src: **zero frontend callers** of suggest/related; header search fires on Enter only (`shopper-shell.tsx:790`, `submitSearch:654`); storefront search Enter + button (`storefront.tsx:422-437`, "no debounce… ZERO network requests per keystroke"); sort change resets page (`market.tsx:581-582`). |
| 4 | External-marketplace sync warning | **CONFIRMED** | `src/components/seller/imports.tsx:199-206` — amber Alert "Imports are one-way — no automatic sync" with the exact required copy. |
| 5 | Chat pagination + send throttling | **CONFIRMED** | `src/lib/chat-pagination.ts:14-15` (default 50, cap 200), `:41-54` (keyset cursor `(createdAt,id)`, cross-thread → 400), `:58-65` (limit+1 hasMore); wired AFTER access control (`chat/threads/[id]/route.ts:73`, checks `:31-40`; `store/chat/threads/[id]/messages/route.ts:51`, ownership `:27`); throttle after auth on both message POST routes (`rateLimitKey(me.id,"chat-send-*",20,60_000)`) with 429 + `retryAfterSeconds`; "Load older messages" UI with scroll pinning (`shopper-shell.tsx:1559-1565`, `seller/messages.tsx:371-377`); thread-creation POST also throttled (`chat/threads/route.ts:86`); the socket.io mini-service is broadcast-only — **no persistence path bypasses throttling**. |
| 6 | Browser History in checkout | **CONFIRMED** | `checkout.tsx:529-537` — single `goPhase(n,"push"\|"replace")` writing `{nomofeeCheckoutPhase}`; 11 call sites (matches "~10"); popstate restore `:519-526`; reload-safe mount stamp `:506-518`; auth-modal sentinel (`shopper-shell.tsx:1036-1060`, `closedByPopRef` guard); documented residual-entry limitation `:503-505`. |
| 7 | Portal code splitting | **CONFIRMED** | `src/components/app-root.tsx:31-38` — `next/dynamic({ssr:false})` for SellerShell + AdminShell; ShopperShell statically imported; no cross-portal static imports. **Live check: `/` HTML references shopper chunks only — zero seller/admin chunks.** |
| 8 | SEO + sitemap | **PARTIALLY CONFIRMED** | Confirmed: `src/app/robots.ts:8-14` (allow /, disallow /api/, sitemap ref); `sitemap.ts:16-31` (live stores of active sellers + active products, correct absolute URLs, lastModified from DB); live `/sitemap.xml` → 200 valid XML; ResultsView noindex (`market.tsx:513-516` → `lib/seo.ts:96`, meta reset on unmount). **NOT confirmed: "conflicting static file removed" — `public/robots.txt` exists on disk (untracked) and the live server returns HTTP 500 for `/robots.txt`** (conflict between the public file and the app route — personally re-verified this session). |
| 9 | Operational cleanup | **PARTIALLY CONFIRMED** | Confirmed in git: `maybeRunExpirySweepLazy` absent (`expiry-sweep.ts:232-233` removal note; zero references); `scripts/attic/` exists with README + `fin-concurrency.ts` + `fin-reconcile.ts` (git-tracked); metrics constant-time (`api/metrics/route.ts:21` → `secretbox.ts:82-87`); whitelist-only category mapping (`import/normalise.ts:52-67`, unknown → null, logged once). **NOT confirmed in the working tree:** `src/lib/order-completion.ts` present on disk (67 lines, zero importers — dead); identical untracked duplicates at `scripts/fin-concurrency.ts` / `scripts/fin-reconcile.ts`. All were deleted in commit `184dd4a` and resurrected by an environment restore (see X-2). |
| 10 | SM→NM order-number copy | **CONFIRMED** | `checkout.tsx:2993` ("order number (e.g. NM-100017)") + `:3011` (placeholder). Grep: no user-facing `SM-` remains (only internal identifiers `X-SM-Client`, `sm_cart`). |

---

## 3. Independent findings

| ID | Severity | Finding | Evidence | Impact |
|---|---|---|---|---|
| **X-1** | **HIGH** | **`/robots.txt` returns HTTP 500 on the live server right now.** The resurrected `public/robots.txt` (untracked) conflicts with `src/app/robots.ts`; Next.js serves a 500 error page for the conflict. Crawlers receive an error instead of directives; the sitemap reference is never served. | `public/robots.txt` vs `src/app/robots.ts:8`; live `curl /robots.txt → 500` (re-verified this session; `/sitemap.xml` → 200, `/` → 200) | Active SEO defect. |
| **X-2** | **MEDIUM** | **Working tree regressed vs the Phase 2.4 commit.** Files deleted in commit `184dd4a` are back on disk as untracked files (environment-restore artifact, mtimes 2026-10-30): `public/robots.txt`, `src/lib/order-completion.ts`, `scripts/fin-concurrency.ts`, `scripts/fin-reconcile.ts`, plus ~25 shadcn `ui/*` components deleted in earlier commit `8cdd7a9` and other stray untracked files. Anyone deploying/auditing THIS tree gets the pre-cleanup state; only git-tracked content is clean. | `git status --porcelain` (personally re-verified: `?? public/robots.txt`, `?? scripts/fin-concurrency.ts`, `?? scripts/fin-reconcile.ts`, `?? src/lib/order-completion.ts`, `?? src/components/ui/*` …); `git log` shows `184dd4a` as the Phase 2.4 commit | Deployment-integrity risk. |
| **X-3** | **MEDIUM** | **Storefront search still has the original C2.2 bug class.** `sf/[slug]/products/route.ts:22` uses `where.title = { contains: search }` — case-sensitive single-field LIKE on Postgres (lowercase query misses capitalized titles), no tokenization; `orderBy` `:42` lacks the `{id:"asc"}` tiebreak. Phase 2.4 fixed only the main market route. | `src/app/api/sf/[slug]/products/route.ts:22,42` | Same UX defect this phase was meant to close, on the storefront surface. |
| X-4 | LOW | Shopper chat thread-list search is case-sensitive (`contains` without `mode:"insensitive"`); explicitly documented as a deliberate future tweak. | `src/app/api/chat/threads/route.ts:22-40` | Inconsistent with market search UX. |
| X-5 | LOW | 429 responses carry `retryAfterSeconds` only in the JSON body — no standard `Retry-After` HTTP header, so generic clients won't honor it. | `lib/rate-limit.ts:259-262`; `lib/api.ts:127` | Minor client compat. |
| X-6 | LOW | Metrics `safeEqual` early-returns on length mismatch (token-length timing oracle); content comparison is constant-time. | `lib/secretbox.ts:85` | Negligible. |
| X-7 | INFO | No ILIKE injection risk: Prisma parameterizes `contains`; the tokenizer strips `_` and `\` (only `[a-z0-9%]` survive — `%` is a documented feature); `normalizeSearchQuery` caps 80 chars + strips control chars; token count ≤ 8; live-tested. | `search.ts:13-20`; `lib/search-normalize.ts` | — |
| X-8 | INFO | Relevance "load more" is capped at 200 by design (deterministic top-N); beyond 200 matches deeper results are unreachable. | `market/products/route.ts:42-47,126` | Documented trade-off. |
| X-9 | INFO | `suggest`/`related` remain public zero-caller APIs (rate-limited 30/min + cache-key guarded) — hardened but dormant surfaces. | grep | — |

---

## 4. What remains before this stage is fully closed

1. **Re-clean the working tree (fixes X-1/X-2):** delete the resurrected `public/robots.txt` (restores `/robots.txt` to the dynamic route — immediately clears the live 500), `src/lib/order-completion.ts`, and the root `scripts/fin-concurrency.ts` / `scripts/fin-reconcile.ts` duplicates (the git-tracked copies live in `scripts/attic/`). These are trivial deletions awaiting your go-ahead under the assessment-only discipline; note that the ~25 untracked shadcn `ui/*` files are inert library components (no conflict observed) and can be reviewed separately.
2. **Fix X-3:** apply the shared tokenized engine (or at minimum `mode:"insensitive"` + `{id:"asc"}` tiebreak) to `sf/[slug]/products`.
3. Optional polish: X-4 (insensitive thread search), X-5 (`Retry-After` header).
4. Apply migration `20261109000000` (search indexes) together with the other eight migrations in the authorized environment, with the EXPLAIN before/after check at representative catalog size.

**Boundary statement:** no cleanup was executed during this verification — the deletions above are listed for your approval, not performed.
