# S1 — Search System Overhaul (top bar + results)

## User asks
1. "Try to look at the search field on top bar, is it working as how it should be? … I tried searching available product, but none shows, probably it's not linked yet, you need to check this out first."
2. "…it should have the advance search system built in … it should also suggested few other products that seems similar to the searched product. Just like the standard practice of e-commerce."

## Root cause (confirmed)
`GET /api/market/products` line 20: `where.title = { contains: search }` — Prisma + Postgres
`contains` is CASE-SENSITIVE without `mode: "insensitive"`. All product titles are
Title-Case ("Aurora Ceramic Vase"), so lowercase queries match nothing. It is also
title-only matching (no description/category/store), single-token only, no ranking,
no suggestions, no similar-product step.

## File map (planned changes)
| File | Change |
|---|---|
| `src/app/api/market/_shared/search.ts` | NEW — tokenize(), buildTokenWhere(), scoreProduct(), rankProducts() shared helpers |
| `src/app/api/market/products/route.ts` | Fix search: insensitive + multi-token AND across title/description/category/store; `sort=relevance` (Best match) ranked in JS over a candidate window |
| `src/app/api/market/search/suggest/route.ts` | NEW — header autocomplete: ≤6 product cards + ≤3 live stores for `?q=` |
| `src/app/api/market/search/related/route.ts` | NEW — similar products for a query (`?q=&exclude=id,id&limit=8`); token-overlap ranking → popular fallback |
| `src/components/shopper/shopper-shell.tsx` | Header search → combobox: debounced suggestions dropdown (products → click = open PDP; stores → storefront), keyboard nav (↑/↓/Enter/Esc), a11y roles, "See all results" row |
| `src/components/shopper/market.tsx` | ResultsView: "Best match" sort (default for search mode); "You may also like" row below results; "Similar to «q»" grid inside the zero-results state |

## Protected areas (must NOT change)
- Existing API envelope contract of /api/market/products (`search`,`category`,`sort`,`page`,`size`; `{data,meta}`) — ResultsView keeps working.
- `liveStore` filter (status:"live" + seller.marketplaceOptIn) — all market surfaces must keep respecting marketplace opt-in.
- PDP `related` (same-store bestsellers) — untouched, separate feature.
- Cart drawer / checkout / chat logic in shopper-shell.
- ProductCard, EmptyState, fetchEnvelope helpers in ui-bits (consume only).
- Storefront search surfaces (`/api/sf/[slug]/products`) — out of scope this round.

## Design decisions
- Multi-word = AND semantics (each token must hit ≥1 field), fields = title ▸ category ▸ store ▸ description.
- Relevance score: phrase-in-title(+60) ▸ every-token-in-title(+30) ▸ per-token title(+20)/category(+8)/store(+6)/description(+3), tie-break salesCount + ratingAvg.
- Candidate window 200 rows → rank in JS → slice for pagination (dataset small; count stays exact via db.count).
- Suggest endpoint is public (market data only), returns ProductCardT shape → reuses ProductCard rendering pieces.
- Related endpoint: looser OR-over-tokens match, excludes ids already shown, popular fallback so the section is never empty on a no-result query.
- Zero-result searches keep the friendly EmptyState + show "Similar to «q»" grid (standard e-commerce recovery).

## Verification plan
- curl: "vase" (lowercase — previously 0), "SERUM" (upper), "ceramic vase" (multi-word), "earbuds", suggest?q=vit, related?q=keyboard&exclude=…, zero-hit q=zzz → popular fallback.
- agent-browser: type in header → dropdown suggestions appear → click one → PDP; Enter → results page with Best match; gibberish → 0 results + Similar grid; sort dropdown shows Best match; mobile 390×844 + desktop 1440×900, no horizontal overflow; console clean.
- lint 0; dev.log clean; /api/health ok.
