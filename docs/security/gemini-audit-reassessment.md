# NOMOFEE — Independent Reassessment of the Gemini/ChatGPT Audit

**Date:** 2026-10-31 · **Mode:** ASSESSMENT-ONLY (read-only; no source, schema, dependency, env or deployment changes were made) · **Scope:** full `src/`, `prisma/`, `mini-services/`, `scripts/`, `Caddyfile`, `next.config.ts`, `package.json`

**Method.** Five parallel deep-dive investigations (auth/login; reviews/orders/access-control; financial integrity; performance/memory; dependencies/framework) plus independent spot-verification of every classification-driving claim by direct file reads, and live npm advisory queries (via `registry.npmjs.org/-/npm/v1/security/advisories/bulk`). No database connections were made (user constraint). No load tests were executed. Nothing was modified.

---

## SECTION 1 — Executive verdict

**Overall:** NOMOFEE's *financial core is materially stronger than the Gemini audit implies* — the ledger is double-entry with enforced balance, every money operation carries a unique dedup key and/or conditional status claim, the wallet cache is a pure derivation of ledger truth, and expiry/sweep machinery is CAS-based and race-safe. The genuinely weak surfaces are (a) **public, unauthenticated, unthrottled endpoints that manipulate marketplace trust and expose order data**, (b) **a stale Next.js 16.1.3 carrying 4 CRITICAL + 15 HIGH advisories, several aimed precisely at this app's architecture** (proxy-bypass vs `src/proxy.ts` CSRF backbone; Image-Optimization RCE vs active `next/image` optimizer), and (c) a handful of correctness leaks (`failed` payment groups hold stock forever; an SSRF redirect-follow regression; a chat order-context IDOR).

**Most serious confirmed risks (in order):**
1. **next@16.1.3 advisories** — 4 CRITICAL (2× Image-Optimization RCE — the app self-hosts with the default optimizer active and serves SVGs; `use cache` RCE — not exploitable here, directive unused; Windows-host RCE — N/A on Linux) and 15 HIGH including multiple **middleware/proxy bypasses**, which matter because `proxy.ts` is the *entire* CSRF defense (session cookie is `SameSite=None`). Verified live: 16.1.3 → 41 advisories; **16.4.3 → 0** (in-range for `^16.1.1`).
2. **SEC-03 review manipulation** — one unauthenticated POST publishes a review and rewrites `ratingAvg/ratingCount`, which feed search ranking, PDP trust, and SEO rich snippets.
3. **SEC-05 + chat IDOR order exposure** — sequential `NM-100001+` numbers, unthrottled lookup/receipt endpoints; any signed-in shopper can pull another customer's order context via `/api/chat/threads`.
4. **SSRF regression in import image copier** — `redirect:"follow"` after validating only the original URL; amplified by unauthenticated `/api/import/jobs`.
5. **`failed` payment groups leak reserved stock indefinitely** (silent sellable-inventory loss).
6. **Session tokens stored plaintext at rest** (DB/backup read ⇒ instant full account takeover incl. superadmin).

**Readiness:**
- **Internal testing:** ✅ Ready today (dev-only credential panel is dual-gated and fail-closed in production).
- **Limited production deployment:** ⚠️ Conditional — after Phase 1 of my plan below (~1.5–2 weeks of focused work). The money path itself is launch-grade.
- **Normal public launch:** ❌ Not until Phase 1 + Phase 2 + a measured load test.
- **Influencer-driven traffic spike:** ❌ No. Hard capacity ceiling: zero server-side caching on all public read routes, single Node process, Supavisor pool of 10, 2–3 DB round-trips per authenticated request. This is a capacity problem, not a code-correctness problem — but it will fall over under a spike.

---

## SECTION 2 — Original Gemini audit comparison

| Finding | Classification | Actual evidence (verified) | Recommended action | Priority |
|---|---|---|---|---|
| **SEC-01** login timing / enumeration | **PARTIALLY CONFIRMED** | Timing oracle real: `login/route.ts:22,34`, `shopper/login/route.ts:22`, `unified-login/route.ts:62-64` short-circuit `!user || !verifyPassword(...)` ⇒ 0 scrypt calls for unknown email vs 1–3 (~30–90 ms measured) for existing. Messages uniform; 10/min/IP throttle exists; **no dummy-hash, no lockout, no admin MFA** | FIX: dummy-hash verification + per-account throttle; MFA for admin | High |
| **SEC-02** XFF spoofing | **PARTIALLY CONFIRMED** | `lib/rate-limit.ts:185-192` trusts first XFF blindly — BUT `Caddyfile:16,25` `header_up X-Forwarded-For {remote_host}` **replaces** the header on both public routes. IP used only for limiter keys (no audit/session binding). Residual risk only if `:3000` is directly reachable (unverifiable from sandbox) | MODIFY: bind app to loopback or document gateway-only topology; no code panic | Medium |
| **SEC-03** anonymous reviews | **CONFIRMED** (self-verified) | `sf/[slug]/products/[pSlug]/reviews/route.ts` — no session check, no purchase tie (dead `orderId` column), no `@@unique`, `status:"published"` at creation, no rate limit, aggregates rewritten inline and consumed by search scoring (`market/_shared/search.ts:53`) and SEO JSON-LD | FIX: auth + verified-purchase + `@@unique` + moderation + rate limit | **Critical** |
| **SEC-04** sync scrypt | **CONFIRMED** (self-verified) | `lib/password.ts:6,14` `scryptSync` (Node defaults, ~30 ms/call); no async wrapper anywhere; unified-login does up to 3 sequential; dev-accounts does 12 | FIX: `promisify(scrypt)` — mechanical, zero call-site changes (routes already `await`) | High |
| **SEC-05** guest order enumeration | **CONFIRMED** (self-verified) | Sequential `NM-` numbers (`lib/api.ts:216-223` counter); lookup/receipt = email+number pair, plain `!==` compare, **no rate limit on either route**; receipt PDF includes name/phone/providerRef; uniform 404 only | FIX: rate limits + email-verification or access-token for receipts; **keep** human-readable order numbers | High |
| **SEC-06** CSRF / Content-Type | **ALREADY MITIGATED** | `src/proxy.ts:108-186`: matcher covers all `/api/*` mutations; Bearer / `X-SM-Client` / `Sec-Fetch-Site` / Origin gates; exemptions are legitimately self-authenticating (HMAC webhooks, cron secret, claim token). No file-upload surface to break. Residual: cookie is `SameSite=None` (iframe trade-off) ⇒ `proxy.ts` is a single point of failure | KEEP; optional defense-in-depth later | Low |
| **SEC-07** unsafe savepoints | **INCORRECT FINDING** | `lib/ledger.ts:158-161` — identifier built from `Date.now()`+`Math.random()` only; no external input reaches SQL text; tagged-template `$executeRaw` *cannot* express `SAVEPOINT $1` (identifiers aren't bindable); the savepoint exists to converge webhook replays | REMOVE from roadmap (add a comment guard against future refactors at most) | None |
| **PERF-01** cart countdown | **PARTIALLY CONFIRMED** | Tick state in `CartDrawer` (`shopper-shell.tsx:1843-1854`) re-renders rows — but countdown is **off by default** (`urgencyCountdownEnabled:false`), interval only while open, 5–30 rows at 1 Hz = negligible | DEFER (10-line isolation if ever touched) | Low |
| **PERF-02** payment QR | **INCORRECT FINDING** | **No QR code exists anywhere in the codebase** (docs confirm "no existing qrcode dependency"); PayView is a ~60-node static card | REMOVE from roadmap | None |
| **PERF-03** useCart instability | **NOT REQUIRED** | `ui-bits.tsx:387-427` — `cart` identity comes from `useSyncExternalStore` (stable); `refresh` is `useCallback`; no consumer passes the object into effect deps | REMOVE from roadmap | None |
| **PERF-04** virtualization | **PARTIALLY CONFIRMED** (maintainability only) | Top files 2.5–3k lines (`insights.tsx` 2964, `checkout.tsx` 2636); **every list is server-paginated 8–50 rows**; no unbounded render; no virtualization lib needed | DEFER; opportunistic file splits; delete dead `notifications-bell.tsx` | Low |
| **MEM-01** per-socket timers | **PARTIALLY CONFIRMED** (fact true, harm ~nil) | `chat-service/index.ts:126-129` one 500 ms interval/socket doing a pure integer increment; cleaned up on disconnect; engine.io heartbeats dominate anyway | DEFER until ≫10k sockets | Low |
| **MEM-02** duplicate sockets | **PARTIALLY CONFIRMED** (by design) | Exactly 2 connection points (`chat-presence.ts:52` refcounted singleton; `chat-ui.tsx:140` per-view); both open only while Messages view is mounted; lifecycles correct; 1 extra socket + doubled frames | DEFER (optional consolidation) | Low |
| **MEM-03** limiter memory | **PARTIALLY CONFIRMED / largely mitigated** | In-memory Maps with sweeps (`rate-limit.ts:44-48` ≥60 s; `ratelimit.ts:29-37` 1 h retention, no cap — the only balloonable structure); Caddy XFF overwrite bounds the key space; single process ⇒ consistent | MODIFY: one-line max-size guard; unify the two limiter modules someday | Low-Med |
| **MEM-04** PDF generation | **CONFIRMED facts / DEFER action** | pdf-lib in request path, standard-14 fonts, tens-of-KB single page, per-order manual frequency; no batch path; no caching | DEFER worker/infra; just add the missing rate limit on receipt | Low |
| **DEP-01** Next 16→15 downgrade | **INCORRECT FINDING** (but real underlying issue) | 16.x **is** the official stable line (`latest: 16.4.3` verified live); React 19.2.3 satisfies peers; `proxy.ts` is the correct Next 16 convention; zero runtime errors. **However** 16.1.3 has 41 advisories (4 CRITICAL/15 HIGH) and **16.4.3 queries clean** | REMOVE downgrade; **FIX: upgrade 16.1.3→16.4.3** (+ sharp ^0.35.5, zod ^4.6.7 — both verified affected/clean) | **Critical** |
| **DEP-02** next-auth unused | **CONFIRMED** | Zero imports anywhere; custom DB-backed sessions; no `[...nextauth]` route; carries a CRITICAL advisory (fixed 4.24.15) | FIX: remove (zero runtime risk) | Med |
| **DEP-03** z-ai-web-dev-sdk | **CONFIRMED unused** | Zero imports; zero runtime deps; no install scripts | FIX: remove | Med |
| **DEP-04** unused deps | **CONFIRMED (17 packages)** | next-auth, next-intl, @tanstack/react-query, @tanstack/react-table, @mdxeditor/editor, react-markdown, react-syntax-highlighter, @reactuses/core, uuid, react-hook-form, @hookform/resolvers, z-ai-web-dev-sdk, @supabase/supabase-js, react-day-picker, embla-carousel-react, input-otp, tailwindcss-animate (+bun-types dev). Zero bundle impact (never imported); orphaned host files (`lib/supabase.ts`, `ui/{form,calendar,carousel,input-otp}.tsx`, `tailwind.config.ts`) must be deleted in the same change | FIX: remove | Med |

---

## SECTION 3 — Additional NOMOFEE-specific findings

### A. Inventory reservation & unpaid checkout expiry — **PARTIALLY CONFIRMED**
The "expiry not enforced" lead is **stale**: stock is deducted at checkout creation via conditional `updateMany where stock >= qty` (`checkout/create/route.ts:380-394`, oversell impossible); PaymentGroup expires at +30 min; a durable mini-service sweeps every 30 s (`mini-services/expiry-scheduler`), and release is CAS-claimed (`cron/expiry-sweep/route.ts:80-127` — only the writer that flips `payment_pending→payment_expired` restocks; idempotent; races with the webhook serialize on the group row, loser gets `409 GROUP_EXPIRED` + a durable refund obligation with its own idempotency key). Auditable `InventoryLog` on every movement.
**Genuinely broken:** both sweeps filter `status:"requires_payment"` only (self-verified) — a group flipped to `"failed"` by a `payment.failed` webhook whose buyer never retries **holds stock forever**; legacy single-intent orders are equally unswept; the "lazy sweep on polling" hook has zero callers.

### B. Payment webhook reliability & concurrency — **PARTIALLY CONFIRMED**
Core is strong: HMAC-SHA256 timing-safe (`safeEqual`), ±10 min replay window, secret **fail-closed in production**, log-then-verify trail, claim-first conditional updates inside Serializable transactions, ledger `dedupKey @unique` + savepoint replay for convergence, inline P2034 retry ×3 with jitter, `SET LOCAL statement_timeout='10s'`, all fan-out moved post-commit (documented against the measured pool-of-10 contention). Duplicate delivery ⇒ `200 duplicate:true`; double credit is structurally impossible (cache recomputed from ledger, never incremented).
**Gaps:** `processPayoutEvent` (`process.ts:691-826`) lacks all of the above hardening (no retry, no statement_timeout, notify/logActivity/cache-refresh *inside* the Serializable tx on the global client); the ops sweep's reprocessing branch re-feeds 1-hour-old payloads that always fail the ±10 min window (`admin/payouts/sweep/route.ts:75-98`) — recovery exists on paper only; exhaustion returns raw 500 (not the designed 503) because `withSerializableTxRetry` has **zero callers** (dead code).

### C. Wallet & ledger integrity — **integrity CONFIRMED sound; historical drift = benign**
Ledger is the source of truth: enforced double-entry balance (`LEDGER_UNBALANCED`), wallet cache is an absolute recompute from ledger lines (never read-modify-write), money decisions (payout authorization, refunds, settlements) always recompute truth transactionally under `FOR UPDATE`, reconciliation runs at four layers (invariants on every admin sweep, per-payout sync, read-only `wallet-reconcile` script with gated `--apply`, verify-finance preflight). The historical observation (available 0 vs 10,764; pending 95,292 vs 84,528) **totals equal** — exactly the code's own benign `TIME_MATURITY` classification (credits matured by clock since last cache write; self-heals on next wallet read; display-only). Affiliate liability is a separate ledger account (`PLATFORM:AFFILIATE_LIABILITY`), never a seller wallet; sponsor flag is fail-closed false in code (live DB value UNVERIFIABLE). **Live balances: UNVERIFIABLE without DB access.**

### D. Financial transaction idempotency — **CONFIRMED comprehensive**
All 10 operations carry unique keys and/or conditional claims: checkout (`Idempotency-Key` required + `idemKey @unique` ×2), payment (claim + `order_paid:order:{id}`), commissions (`AffiliateCommission.orderItemId @unique`, 90/10 frozen at checkout), wallet credit (derived from T1), withdrawal (one-open-request Serializable + `Wallet FOR UPDATE` + T3/T4/T4f dedupKeys; PSP-transfer vs bank-payout are distinct paths gated by the same claims), refunds (per-row dedupKey + cumulative cap re-validated under `Order FOR UPDATE`), settlement (`gateway_settlement:{ref}`), vouchers (status-guarded redemption + quota CAS + `@@unique([userId,voucherId])`). Minor nuances only: voucher quota enforced at redemption not claim; concurrent same-idem-key checkout resolves via P2002 (ugly error, no duplicate); no webhook event-ID column (dedup is behavioral).

### E. Database & connection management — **real, measurable, but deferred-scale**
`force-dynamic` on essentially every route, zero `unstable_cache`/ISR (client-SPA root); every authenticated request pays 2–3 remote-DB round-trips for session resolution; checkout runs ~100 sequential round-trips in one 15 s Serializable tx (already mitigated by the `MAX_INFLIGHT=8` admission gate < pool 10, with dev.log-measured rationale); `/api/me/orders` runs lazy maintenance sweeps inline on the hot path; **index gaps:** `PaymentGroup [status, expiresAt]` (the 30 s sweep currently seq-scans) and `Order [storeId, status]`. No N+1 in loops; no fetch-inside-transaction; lists all bounded.

### F. Additional security findings (missed by the original audit)
| # | Finding | Severity | Evidence |
|---|---|---|---|
| F-1 | **Chat order-context IDOR** — any signed-in shopper queries any order's status/total/first item by number+store (comment *claims* email parity with orders/lookup, but the email half is absent) | Medium | `chat/threads/route.ts:113-122`, `lib/chat-context.ts:87-111` (self-verified) |
| F-2 | **SSRF redirect-follow regression** — `assertPublicHost` validates only the original URL; `redirect:"follow"` then chases a public host's 302 to `169.254.169.254`/private ranges; amplified by unauthenticated `/api/import/jobs` | Medium | `lib/import/runner.ts:57-61` (self-verified) |
| F-3 | **Rate-limit regression on 4 public endpoints** (lookup, receipt, reviews POST, newsletter) — blueprint F-04 documents limits that were never in the code; newsletter also writes 2 DB rows/request with attacker-chosen email | Medium | verified: zero `rateLimit` hits in all four files |
| F-4 | **Session tokens plaintext at rest** (raw token is the PK) | Medium-High | `schema.prisma:146-152` |
| F-5 | **No admin MFA, no account lockout**; seeded demo passwords fail open if `SEED_*` unset | Medium | grep-verified |
| F-6 | Store webhook signing secrets returned in plaintext on every GET | Low | `store/webhooks/route.ts:23` (self-verified) |
| F-7 | Seller-controlled `javascript:` URL sink in social links (stored XSS on own storefront) | Low | `product-card.tsx:62-64`, `storefront.tsx:1031-1035` |
| F-8 | Expired sessions never purged (unbounded table) | Low | deleteMany only on logout/revoke |
| F-9 | Dev credential panel live in dev (dual-gated, fail-closed in prod; by design) + 12 sequential scrypt calls per hit | Info | `auth/dev-accounts/route.ts` |

**Verified properly protected:** seller data isolation (all `store/**` ownership-filtered), shopper isolation (all `me/**` session-bound, automated sweep zero misses), all 88 admin routes gated by `requireAdmin`/capability matrix, affiliate session binding, no file uploads exist, no `dangerouslySetInnerHTML` outside dev-controlled chart CSS, no unsafe raw SQL beyond the benign savepoints, no sensitive logging, no open redirects, no mass assignment (zod allowlists everywhere), metrics endpoint token-gated.

---

## SECTION 4 — Comparison against the proposed three-phase roadmap

| Proposed item | Decision | Reason | Required before launch? |
|---|---|---|---|
| SEC-03 verified-purchase reviews | **FIX** | Confirmed trivially exploitable; trust manipulation | **Yes** |
| SEC-05 secure guest order lookup | **FIX** (modified) | Rate limits + email-verification/token; keep NM- numbers | **Yes** |
| SEC-01/04 async pw + timing | **FIX** | One mechanical change (async scrypt + dummy hash) covers both | **Yes** |
| SEC-02 trusted proxy / real IP | **MODIFY** | Caddy already rewrites XFF; fix is topology (loopback bind), not code | Yes (verify) |
| SEC-06 strengthen CSRF | **KEEP** | proxy.ts already layered & correct; exemptions legit | No |
| Checkout stock reservation expiry | **MODIFY** | Machinery exists & race-safe; extend to `failed` groups + legacy intents | **Yes** |
| Payment webhook retry/concurrency | **MODIFY** | Core solid; fix payout-event path + dead sweep branch + 503 semantics | **Yes** |
| Wallet/ledger reconciliation | **KEEP** | Already implemented at 4 layers; drift explained as benign | No |
| Financial idempotency tests | **KEEP (tests only)** | Mechanisms verified in code; add executable invariant tests | Yes (tests) |
| MEM-01 remove per-socket timers | **DEFER** | Pure integer increment; negligible | No |
| MEM-02 consolidate sockets | **DEFER** | Dual sockets only while Messages view open; lifecycles correct | No |
| MEM-03 limiter memory | **MODIFY (cheap)** | One-line max-size guard; Caddy already bounds key space | No (nice-to-have) |
| PERF-01/02 countdown isolation | **REMOVE** | PERF-02 premise false (no QR); PERF-01 negligible & off by default | No |
| DB queries/indexes/pooling review | **MODIFY** | 2 named indexes + move lazy sweeps; do NOT raise connection_limit (Supavisor session mode) | Before scaling |
| Measure checkout/storefront perf | **KEEP (as test)** | Load test after caching work; never against prod | Before spike |
| DEP-02/03/04 remove unused | **FIX** | 17 confirmed-unused; also clears a CRITICAL next-auth advisory | Yes (quick) |
| Upgrade Next.js to patched 16.x | **FIX — but MOVE TO PHASE 1** | 4 CRITICAL + 15 HIGH on 16.1.3; 16.4.3 clean, in-range, zero migration | **Yes** |
| SEC-07 savepoint cleanup | **REMOVE** | Identifier internally generated; not injectable | No |
| PERF-03 hook stability | **REMOVE** | External-store identity already stable | No |
| PERF-04 refactor/virtualize | **DEFER** (splits only) | Lists all paginated; virtualization unwarranted | No |
| MEM-04 PDF reassessment | **DEFER** | Measured trivial; just rate-limit the receipt route | No |

---

## SECTION 5 — Items that do NOT need fixing (safe to avoid)

1. **Next.js 16 → 15 downgrade (DEP-01 as proposed)** — wrong remedy. 16.x is the stable line; the app is healthy on it; `proxy.ts` is the correct v16 convention. A downgrade would re-introduce migration work and *still* leave you chasing patches. Replace with the in-range 16.4.3 upgrade.
2. **SEC-07 savepoint rewrite** — no external input reaches the SQL text; Prisma cannot parameterize identifiers anyway; the current design is the pragmatic correct one.
3. **PERF-02 QR-code isolation** — there is no QR code in the product. The finding is a hallucination.
4. **PERF-03 useCart memoization** — `useSyncExternalStore` already provides stable identities; memoizing the return literal changes nothing measurable.
5. **PERF-04 virtualization at any threshold** — every list is server-paginated at 8–50 rows; virtualization would be complexity with zero beneficiary.
6. **MEM-04 PDF background worker + object storage** — single-page, standard-font, tens-of-KB PDFs at manual-download frequency; infrastructure would be over-engineering.
7. **MEM-01 timer rework** — integer increments at 2 kHz aggregate; revisit only at ≫10k concurrent sockets.
8. **Raising Prisma connection_limit** — Supavisor session mode caps server-side connections; the correct levers are the admission gate (already `MAX_INFLIGHT=8`) and reducing round-trips, not a bigger pool.
9. **Rewriting guest checkout / order-number scheme** — guest flows are already account-scoped at checkout with email-claim merge; NM- numbers are a support feature. Harden verification around them; don't replace them.
10. **CSRF token framework (double-submit)** — origin-evidence gate + preflight-forcing custom headers + no CORS is a coherent modern design. Monitor only that `proxy.ts` never regresses (framework upgrades included — hence the 16.4.3 patch matters).

*Monitoring advisories:* keep `proxy.ts` exemptions list under review; re-run the advisory bulk query before each deploy; watch `PaymentWebhookLog.processed=false` counts (the dead sweep branch will surface there).

---

## SECTION 6 — Prioritized remediation plan (my roadmap)

**Phase 1 — Security & correctness before ANY public exposure (~1.5–2 weeks)**
1. `next 16.1.3→16.4.3`, `sharp →^0.35.5`, `zod →^4.6.7` (in-range; clears RCE/proxy-bypass surface). *Dependency: do this FIRST — several later fixes live in files whose framework behavior shifts.*
2. SEC-03 review hardening: `requireShopper` + delivered-order eligibility join + `@@unique` + `status:"pending"` moderation + rate limit + length caps.
3. Rate limits on `/api/orders/lookup`, `/api/orders/receipt`, `sf/**/reviews`, `sf/**/newsletter` (infrastructure already exists — one import each) + chat-thread order ownership check (F-1).
4. Receipt hardening: rate limit (in 3) + one of {emailed verification code, per-order access token}; preserve NM- numbers.
5. Import SSRF: restore documented F-06 design — `redirect:"manual"`, re-validate every hop, cap 3; gate `/api/import/**` behind seller session (F-2).
6. SEC-01/SEC-04 in one change: async `scrypt` + dummy-hash verify on all login paths (+ per-account throttle).
7. Expiry sweep: include `failed` groups and legacy `PaymentIntent` orders (release path already CAS-safe).
8. Hash session tokens at rest (`sha256(token)` lookup) + purge job for expired sessions (F-4/F-8).

**Phase 2 — Financial ops hardening & admin surface (before launch, may trail Phase 1)**
9. `processPayoutEvent`: post-commit fan-out, P2034 retry, statement_timeout (mirror the payment-path pattern).
10. Fix the ops-sweep reprocessing branch (re-stamp/re-sign stored payloads or bypass freshness for verified stored events); wire or delete `withSerializableTxRetry` (503 semantics).
11. Admin MFA (TOTP) + account lockout.
12. Store webhook secrets write-only (show once on rotation) (F-6); `javascript:`-scheme allowlist on seller URLs (F-7).
13. Remove the 17 unused dependencies (+ orphaned host files in the same commit).

**Phase 3 — Capacity & hygiene (before scaling / influencer traffic)**
14. Server-side caching for public read routes (market home/products/suggest/storefronts) with explicit revalidation strategy; nothing financially sensitive without a consistency plan.
15. Migrations: `PaymentGroup [status,expiresAt]`, `Order [storeId,status]` (go through the migration workflow, not `db push`).
16. Move lazy sweeps off `/api/me/orders` into the scheduler mini-service.
17. Limiter unification + max-size guard (MEM-03).
18. Opportunistic: file splits for the 2.5–3k-line components; delete dead `notifications-bell.tsx`; optional socket consolidation.

---

## SECTION 7 — Testing plan

| Fix | Tests |
|---|---|
| Next upgrade | Full regression via Preview (all portals), `bun run lint`, existing `verify:finance` static suite, then the browser-driven golden path (login → browse → cart → checkout → simulate pay → wallet → payout). Requires: dev env only |
| Reviews | Integration: anonymous 401; non-purchaser 403; purchaser-with-delivered-order 201; duplicate 409; pending-review invisible; aggregate recompute correct. Requires: **DB access** |
| Rate limits | Burst tests (n+1 requests → 429) on all four routes + chat threads. Requires: dev env |
| SSRF | Unit: original-URL public + redirect→private blocked at hop 2; redirect chain cap; content-type gate. No DB needed |
| Async scrypt + dummy hash | Timing harness: p50/p95 user-exists vs user-missing within noise; load test: 50 concurrent logins, event-loop stall < 5 ms. No DB |
| Expiry sweep | Concurrency: webhook vs sweep race (exactly one winner; late payment → refund obligation, exactly one); run sweep twice → identical stock (idempotent); `failed`-group release. Requires: **DB access** |
| Payout event | Injected P2034 (retry count=1 success); concurrent duplicate events → single T4; fan-out failure does not roll back the committed tx. Requires: **DB access** |
| Session hashing | Migration compatibility (existing sessions invalidated — acceptable, documented); login/logout/revocation round-trip; DB-leak simulation cannot replay tokens. Requires: **DB access** |
| Financial invariants | Convert `verify-finance-hardening` sections A–F into CI-runnable checks; add ledger-balance invariant + wallet-cache equality assertions. Requires: **DB access** |
| Load (Phase 3 gate) | k6-style checkout/storefront concurrency on a **staging DB only**; never against production. Requires: **staging infra + DB** |

**Regression risks to watch:** review route must not break PDP read path; rate limits must not throttle legitimate order-tracking emails; SSRF fix must not break legitimate image CDN redirects (allow after re-validation); async scrypt must not change hash format (same `s1:` scheme); session hashing forces one-time re-login for all users; dependency removal must include orphaned-file deletion or tsc breaks.

---

## SECTION 8 — Remaining unknowns

| Unknown | Evidence needed |
|---|---|
| Live wallet-cache vs ledger state | Direct read-only DB query (reconciliation script exists: `scripts/readiness/wallet-reconcile.ts`) |
| `affiliate.sponsor_enabled` actual DB value | Read-only settings query (code default is false; legal gate) |
| Whether `:3000`/`:3003` are externally reachable (SEC-02 residual) | Network/firewall topology of the production host |
| Deployed Caddyfile == repo Caddyfile | Ops access to `/app/Caddyfile` on the host |
| Real-PSP webhook behavior (HMAC format, retry cadence) | PSP sandbox credentials + contract docs; current rails are mock-only |
| Supavisor live pool utilization & index presence | Supabase dashboard/pg_stat statements; migration-vs-`db push` drift check (`prisma migrate status`) |
| Production env gates (`PSP_WEBHOOK_SECRET`, `NOMOFEE_SHOW_DEV_LOGIN_CREDENTIALS`) | Production env var **names** only (values never needed) — code is fail-closed, deployment must be confirmed |
| Exact exploitability of the two Image-Optimization RCEs | Pen-test of `/_next/image` reachability post-upgrade (upgrade regardless — trivial patch) |
| Cloudflare/other front proxy in production | Deployment architecture answer |

---

## FINAL ANSWER — fix / ignore / postpone

**Genuinely fix (before any public exposure):** Next.js 16.1.3→16.4.3 (+sharp/zod patches) · anonymous review injection · rate limits on the four public routes · chat order-context IDOR · receipt access hardening · import SSRF redirect · async scrypt + dummy-hash login · failed-group stock leak · session tokens hashed at rest · payout-event webhook hardening + dead recovery branch · admin MFA/lockout · remove 17 unused deps.

**Safely ignore:** the Next 15 downgrade · SEC-07 savepoint rewrite · PERF-02 (no QR exists) · PERF-03 memoization · PERF-04 virtualization · MEM-04 PDF infrastructure · raising connection_limit · any rewrite of guest checkout or order numbers · a CSRF-token framework (origin gate is adequate).

**Postpone:** MEM-01 timer rework · MEM-02 socket consolidation · PERF-01 countdown isolation · large-file splits · public-route caching + the two indexes + lazy-sweep relocation (all Phase 3, mandatory before influencer-scale traffic but not before a limited launch).

The recurring theme: **the money path was already built with discipline; the public-facing trust and enumeration surfaces were not.** Fix those, patch the framework, and the codebase is in genuinely defensible shape for a staged launch.
