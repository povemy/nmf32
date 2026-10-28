# Blueprint Support 02 — Frontend & UX Blueprint (Part D)

All findings from static inspection of `src/components/**` (labels: [V] verified / [I] inferred / [P] partial). Portal surfaces are **client-side state machines on the single route `/`**; there is no URL routing except `?sf=`, `?sp=`, `?claim_job=`, `?claim_token=`.

## D.1 Shell, navigation & state

| Aspect | Implementation | Evidence |
|---|---|---|
| Mount chain | `app/page.tsx` → `AppRoot` → loading gate until `refreshMe()` → `ShopperShell / SellerShell / AdminShell` by zustand `surface` | `app-root.tsx:14-46` [V] |
| Surface store | `{surface, activeStoreSlug, me (5-arm union), shopperAuthOpen, afterShopperAuth}`; `setSurface` persists `localStorage.sm_surface`; `hydrateSurface` re-applies after mount (SSR default shopper) | `app-store.ts:19-80` [V] |
| Identity channels | localStorage `sm_session_token` → `Authorization: Bearer`; `sm_cart_token` → `X-Cart-Token`; `sm_shopper_token` → `X-Shopper-Token`; in-memory `memoryTokens` memo; cookie `sm_cart` fallback. **Shopper view calls send device headers only — session rides the cookie exclusively** (cookie-blocked iframe ⇒ guest degradation) | `session-client.ts:1-117`, `shopper/ui-bits.tsx:214-276` [V] |
| Refresh behaviour | Shopper view persisted (`sm_shopper_view`, 25-deep in-memory back stack); **seller/admin nav is useState only — refresh lands on Dashboard**; browser back exits app | `shopper-shell.tsx:75,141-219`, `seller-shell.tsx:86`, `admin-shell.tsx:195` [V] |
| Cross-portal handoff | `setActiveStoreSlug` ("view store" from seller portal) consumed by shopper shell | `app-store.ts`, `seller-shell.tsx:441` [V] |
| SEO | Single static metadata block; per-product `<meta>`+JSON-LD injected client-side (invisible to non-JS crawlers); sitemap emits query-param URLs | `layout.tsx:16-36`, `pdp.tsx:106-139`, `sitemap.ts` [V] |
| Realtime | socket.io `io("/?XTransformPort=3003")`, rooms `thread:{id}`; `chat:message` payloads deduped client-side; `nomofee:*` window events for badge sync | `shopper-shell.tsx:894-921`, `seller/messages.tsx:111-135` [V] |

## D.2 Shopper portal (11 components)

| View | Purpose | Backend calls | Gaps / mock |
|---|---|---|---|
| `shopper-shell.tsx` (1,476 ln) | Header, bottom nav (cart+chat badges), auth dialog, cart drawer, messages | `/api/market/home`, `/api/cart*`, `/api/chat/*`, `/api/auth/shopper/*` | 15s unread poller; auth stores token (unused by view calls) [V] |
| `market.tsx` (613) | Home (banners/categories/featured/latest/topStores), search/category results with sort+pagination | `/api/market/home`, `/api/market/products`, `/api/campaigns/active` (60s, cosmetic accent layer) | Category icon map is decorative regex→icon [V] |
| `pdp.tsx` (574) | Product detail, variant picker, qty stepper, likes, contact-seller, reviews (seeded DB rows), SEO JSON-LD | `/api/sf/{slug}/products/{pSlug}`, `/api/cart/items`, `/api/me/activity`, `/api/chat/threads` | — [V] |
| `storefront.tsx` (1,285) | Renders builder `publishedJson` via 15-type `SectionRenderer`; follow toggle w/ optimistic update; newsletter | `/api/sf/{slug}[/pages|/products]`, `/api/stores/{slug}/follow`, newsletter | Owner-controlled `href`/`src` not scheme-allow-listed (XSS risk F-13) [V] |
| `checkout.tsx` (2,569) | 3-phase checkout (Information→Delivery→Payment), vouchers per store group, mock pay page, order status/orders/lookup views | `/api/checkout/quote|create|addresses|payments/{ref}(+simulate,retry)`, `/api/me/orders*`, `/api/orders/lookup`, `/api/orders/receipt` | See D.3 [V] |
| `me-hub.tsx` (2,241) | Account dashboard, purchases (buckets, receive, reorder), vouchers (mine+claim centre), addresses CRUD, likes/viewed, recommendations, coins check-in, profile | `/api/me/*` (12 endpoints) | NomoPay wallet & coins UI dormant behind `NOMO_FINANCE_ENABLED=false`; 4 toast-only "coming soon" tiles; Help Center misroutes to Purchases [V] |
| `generate.tsx` (1,446) | Store-generation import wizard (input→authorisation→progress→result) + claim view | `/api/import/resolve|jobs|resume|claim/validate`, `/api/claim/bind`, `/api/auth/*` | Shopee/TikTok need server env; only `fixture` works end-to-end [V] |
| `notification-bell.tsx` | 30s-polled badge + popover, mark-read, click-through | `/api/me/notifications*` | — [V] |
| `ui-bits.tsx` (769) | fetch layer, product cards, status badges, shipment timeline, `sm_order_refs` device-local order list (≤25) | — | Guest "Orders" is localStorage-fan-out via lookup API (by design) [V] |

## D.3 Checkout flow detail

- **Phases**: draft state machine with `sessionStorage.sm_checkout_draft`; contact prefill from `sm_shopper_*` localStorage; client validation (email/phone/MY-postcode regex, 16 hardcoded MY_STATES). [V] `checkout.tsx:86-89,161-186`
- **Quote sequencing (recently hardened)**: `quoteSeq` ref — only newest response may write quote state; `voucherKey` stable string dep + `voucherEntriesRef` break the quote→groups→voucherEntries→refreshQuote render cycle that previously hung checkout on "Updating prices from server…". Coupon apply joins the same sequence. [V] `checkout.tsx:569-617`
- **Totals authority**: all totals rendered from server quote; create recomputes from scratch (`create/route.ts:108-114`). Client-side fallback subtotal sum is display-only. [V]
- **Payment methods are a hardcoded client constant** `PROVIDERS = fpx_toyyibpay | tng | grabpay | card_stripe` (`checkout.tsx:91-96`); server accepts 5 (`KNOWN_PROVIDERS` incl. `fpx_curlec`, `create/route.ts:13`). **No NomoPay/Later option at checkout.** [V]
- **Free-shipping copy duplicates the server rule** (RM100 threshold magic number, `checkout.tsx:1156-1169` vs `pricing.ts:12`). [V]
- **Mock pay page**: in-shell `pay` view polling `/api/checkout/payments/{ref}` (3s), 10:00 countdown, Pay Now → `simulate {result:"succeeded"}`, decline/retry paths, auto-redirect on success. [V] `checkout.tsx:1494-1732`
- **Idempotency**: stable draft `idemKey` sent as `Idempotency-Key` header (create route honours it server-side). [V] `checkout.tsx:792`, `create/route.ts:33-57`
- Guest order history: `sm_order_refs` + `Promise.allSettled` over `/api/orders/lookup`. [V] `checkout.tsx:2394-2414`

## D.4 Seller portal (21 components)

- **Shell** (`seller-shell.tsx`, 674): status router — auth → onboarding wizard → `pending_review` (polls) → blocked screens → active dashboard; demo credential card rendered in UI (`:607-616`). 14-item nav. [V]
- **Onboarding** (4 steps: identity/theme, KYC docs, bank account, submit): `/api/store/settings|theme|bank-accounts|onboarding`. [V]
- **Dashboard**: KPIs + quick restock **fixed at delta +10** (`dashboard.tsx:50`). [V]
- **Products**: list/create/edit/archive; images are client-generated `/api/img/{seed}` URLs (no upload API); nested create is atomic via Prisma. [V]
- **Orders** (`orders.tsx` + `ship-order-dialog`/`deliver-dialog`/`shipment-panel`): tabs, fulfil → platform ship (rate card + AWB/label) or manual tracking, deliver with proof ≤1.2MB, refund-request (amount ≤ refundable). [V]
- **Wallet**: truth-refreshed balance + 20 ledger lines + payouts + activity drill-down. (Dedicated `/api/store/payouts` page unused — wallet view covers it.) [V]
- **Builder** (`builder.tsx` 1,042 + `builder-render.tsx` 387): 15 section types (announcement_bar, header, hero, image_banner, product_grid, collection_list, rich_text, image_with_text, testimonials, faq, newsletter, countdown, whatsapp_floating, footer, marketplace_strip), @dnd-kit drag/drop, draft/publish/revert versioning, theme editor. [V] `sections.ts:74-364`
- **Imports**: connections (Shopee/TikTok/fixture), job progress 8s poll, resume, publish blockers. [V]
- **Integrations**: provider config KV, webhook endpoints CRUD + "test" (simulated delivery labelled as such), API-key generator UI. [V]
- **Domains** (verify is a server simulation), **SEO**, **Settings** (identity/social/marketplace opt-in), **Messages** (socket room + static quick-reply chips). [V]

## D.5 Admin portal (29 components; 26 nav views)

- **Shell** (`admin-shell.tsx`): login card with **hardcoded demo-account chips incl. plaintext demo passwords** (`:434-438`); `VIEW_MAP` + param views (`seller-detail`, `order-detail`, `payout-detail`). [V]
- **Command centre**: KPIs + recharts GMV area chart + `/api/admin/system/health` poll. [V]
- **Sellers**: list/detail, approve/reject/suspend/activate/terminate, risk tier, notes, KYC doc review, bank verify/reject, KYC queue. [V]
- **Moderation**: product approve/reject/ban grid. **Categories** CRUD w/ commission bps. **Orders** list + full dossier. **Refunds** approve/process/reject. **Disputes** PATCH. [V]
- **Finance**: `finance.tsx` (Overrides CRUD + Fee Holidays CRUD w/ "Commission % during holiday · 0 = full fee holiday" hint at `:576-578`), `wallets-ledger.tsx` (wallets, per-wallet ledger drill-down, adjustments T6), `payouts.tsx` (dry-run preview → run; mark-paid/fail; statement expansion w/ reconciliation-sum honesty check). [V]
- **Commission** (`commission.tsx`, 2 tabs): Settings (diff dialog before apply) and **Reports & exports** (analytics incl. weekly trend + top stores; export history + download; dormant PSP split scaffold toast-blocked by `PSP_ADAPTER_REQUIRED`). Simulator is a separate nav view (raw JSON mode). [V]
- **Marketing**: banners, featured slots, coupons, campaigns (RBAC `campaigns.manage`; festive presets auto-fill dates/theme; published campaign themes shopper market home). [V]
- **Stores**: directory + **broken "retry domain verify" button** calling non-existent `/api/admin/domains/{id}/verify` (`stores.tsx:64`). [V]
- **Support**: tickets (status/priority/reply). **Reports**: 4 canned reports + CSV export via full-page nav. **System**: settings, feature flags, audit logs, activity logs, notification log, health (ledger invariants). **No UI for webhook-deliveries/replay or announcements** (backend-only endpoints). [V]

## D.6 Cross-cutting UX observations

- **Responsive**: mobile-first throughout; shopper app-like bottom nav + safe-area insets; admin/seller desktop sidebar + mobile Sheet; long lists in max-h scroll containers. Touch targets ≥44px widely used. [V]
- **Accessibility**: ~250+ `aria-label`s, Radix primitives for keyboard/focus, `role=tablist` segmented tabs, `aria-current` nav; weaknesses: some colour-only transitions. [V]
- **Theming**: teal-led token system (`globals.css:45-62` brand remap), `bg-brand-gradient` utilities; `next-themes` installed but **no ThemeProvider mounted — light-only in practice**, inert `.dark` block. [P]
- **Feedback**: sonner toasts (position top-center), consistent `EmptyState`/`Skeleton` patterns, framer-motion view transitions (7 files), recharts confined to admin. [V]
- **Images**: deliberate plain `<img>` against `/api/img/{seed}` deterministic SVGs; `next/image` used twice, unoptimized. [V]
- **i18n**: `next-intl` installed, **zero imports** — hardcoded en-MY copy. [M]
- **Pollers inventory**: chat unread 15s, notifications 30s, pay status 3s, order status 12s, import 8s, campaigns 60s, admin health 30s, seller `/api/store/me` 20s. [V]

## D.7 UI-only / mock / unwired inventory (file:line)

1. Hardcoded payment providers — `checkout.tsx:91-96`. 2. Dormant NomoPay/coins scaffold behind `NOMO_FINANCE_ENABLED=false` — `me-hub.tsx:84,260,942-981`, `feature-flags.ts:30`. 3. Toast-only service tiles (NomoPay App, Money+ 4.1% p.a., Cash Financing, Insurance) — `me-hub.tsx:598-603`. 4. Help Center → Purchases misroute — `me-hub.tsx:428`. 5. RM100 free-ship magic number duplicated client-side — `checkout.tsx:1156-1169`. 6. Hardcoded `MY_STATES` + validators — `checkout.tsx:86-89`. 7. Decorative category icon map — `market.tsx:55-68`. 8. Demo credentials rendered in client bundles — `admin-shell.tsx:434-438`, `seller-shell.tsx:607-616`. 9. Backend-only webhook-deliveries/replay — no admin view. 10. Simulated confirmations labelled as real ("Test delivery sent (simulated)", domain verify) — `integrations.tsx:132`, `domains.tsx:46`. 11. Marketplace connect buttons surface env-not-configured toasts; only fixture platform works — `imports.tsx:123-132`. 12. Image "generation" = new `/api/img/{seed}` seed strings — `products.tsx:302`, `builder.tsx:732,751`, `marketing.tsx:68-76`. 13. Fixed +10 restock — `dashboard.tsx:50`. 14. Static quick replies — `messages.tsx:287-300`. 15. Device-local guest order list — `ui-bits.tsx:293-316`. 16. Campaign accent layer silently no-ops on failure — `market.tsx:88-105`. 17. Shopper Bearer gap (cookie-less contexts degrade to guest) — `ui-bits.tsx:214-243`. 18. No URL routing for seller/admin; refresh → dashboard. [V]
