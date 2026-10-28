# Blueprint Support 03 — Backend, API & Business Logic Blueprint (Part E)

Evidence from full static inspection of `src/app/api/**` (~120 route files). Guard shorthand: **A**=requireAdmin, **C(cap)**=requireCap, **S**=requireSeller, **SAS**=requireActiveSellerStore, **Sh**=requireShopper, **Ses**=getSession, **—**=public. Envelope: `{data}` / paged `{data, meta}` / errors `{error:{code,message,details}}` via `ApiError`+`handle` (`src/lib/api.ts:7-46`). No server actions exist. No zod except 3 `me/*` routes; validation is manual per-route. No rate limiting anywhere.

## E.1 Auth & session foundation

| Function | Location | Semantics |
|---|---|---|
| `createSession(userType,userId)` | `lib/auth.ts:28-44` | Session row (token = 64-hex CSPRNG, TTL 7d) + cookie `sm_session` `httpOnly, SameSite=None, Secure, path=/, maxAge=604800` |
| `getSession()` | `lib/auth.ts:53-76` | Bearer header (regex-validated) **or** cookie → Session row, expired→null. No status re-check here (guards do it) |
| `requireAdmin / requireAdminRole / requireCap` | `lib/auth.ts:78-144` | userType=admin + isActive; 11-cap RBAC matrix `ADMIN_CAPS` (unknown cap ⇒ superadmin-only) |
| `requireSeller / requireActiveSellerStore / requireShopper` | `lib/auth.ts:92-124` | Seller includes store (status passthrough); Shopper requires `status==="active"` |
| `hashPassword/verifyPassword` | `lib/password.ts:4-20` | scrypt (64B key, random salt), timing-safe compare |
| `claimGuestStateForShopper` | `lib/shopper-merge.ts:13-21` | On shopper login/register: legacy guest orders with matching email claimed into account (risk F-11) |
| `transitionOrder` | `lib/api.ts:147-167` | read→update status+timestamp→history row. **No from-status legality check, non-transactional** |
| `nextOrderNumber()` | `lib/api.ts:183-190` | Counter upsert `NM-<n>`; atomic per-row but called outside the create transaction (gaps possible) |
| `auditAdmin / logActivity / notify` | `lib/api.ts:57-124` | Dual-write AdminAuditLog+ActivityLog; notifications are inline NotificationLog rows (no worker) |
| `dispatchStoreWebhooks` | `lib/api.ts:127-144` | **Simulated** outbound webhook fan-out (pre-marked success rows, no HTTP) |

## E.2 Route inventory

### auth (7 files)
| Route | Method | Guard | Notes |
|---|---|---|---|
| `/api/auth/login` | POST | — | portal∈{admin,seller}; terminated seller 403; returns Bearer token + sets cookie |
| `/api/auth/register` | POST | — | seller signup; **$transaction**: Seller(onboarding)+draft Store+Wallet+4 CMS pages |
| `/api/auth/logout` | POST | — | revoke + cookie delete |
| `/api/auth/me` | GET | Ses | whoami; `{userType:null}` anon |
| `/api/auth/shopper/login|register` | POST | — | cross-portal email-collision check; suspended 403 |
| `/api/auth/callback/[platform]` | GET | — | OAuth redirect; 10-min single-use `state` nonce (Setting table); inline handler never consumes the stored sellerId binding (F-07) |

### me (14 files — all requireShopper)
`GET /orders` (buckets + **lazy auto-complete** delivered>14d→completed 60s-throttled + **lazy mock-tracking tick**), `GET /orders/[orderNumber]` (shopperId-scoped 404), `POST .../receive` (shipped/delivered→completed; fast-forwards mock shipment), `POST|GET .../return-request` (creates **Dispute**; no Refund, no money), `POST .../reorder`, `GET|POST /notifications (+/unread)`, `GET /vouchers + POST /vouchers/claim`, `GET|PATCH /profile` (auto membership upgrade; zod here), `GET /wallet` (**dormant** — `disabled:true` envelope), `POST /coins/claim` (403 `FEATURE_DORMANT`), `GET /recommendations`, `GET|POST|DELETE /activity`.

### cart (4 files)
`GET /` (guest → 200 empty + requiresAuth), `POST /items` (Sh; stock/active guards; merge-dup capped at stock), `PATCH|DELETE /items/[id]` (Sh). Carts are account-scoped; legacy token path read-only (`cart/cart.ts:1-6`).

### checkout (8 files)
`POST /quote` (public when no vouchers; session only to resolve voucher wallet), `GET|POST /addresses (+[id])` (guests 401), `POST /create` (Sh; **Idempotency-Key required**; full trace in E.3), `GET /payments/[ref]` (public status; no ownership check), `POST /payments/[ref]/simulate` (public mock-PSP), `POST /payments/[ref]/retry` (public; failed→requires_payment).

### orders (public)
`GET /lookup?email&orderNumber` (uniform 404; sequential numbers ⇒ guessable pair, F-08), `GET /receipt` (pdf-lib PDF; PII inside; unpaid 409).

### market (3, public) — `home`, `products` (search/category/sort, okPaged), `stores` (live directory; marketplaceOptIn filter).
### sf (6, public) — live stores only, publishedJson only. **`POST /sf/{slug}/products/{pSlug}/reviews` is unauthenticated, auto-published, rewrites rating aggregates** (abuse flag). `POST /sf/{slug}/newsletter` unbounded log rows.
### img / health / shipping-tick / campaigns
`GET /img/[seed]` (deterministic SVG, 1y immutable), `GET /health` (**publicly exposes ledger invariant problems**), `POST /shipping/tick` (intentionally unauthenticated global mock-shipment advancer, 1.5s throttle; **no caller in repo**), `GET /campaigns/active` (published campaign or null).
### claim / follow / chat / import
`POST /claim/bind` (seller session; SHA-256-hashed single-use claim token; guarded tx) [V]. `GET|POST /stores/[slug]/follow` (Sh). `chat/threads*` (Sh/Ses; thread access shopper-XOR-store-owner; broadcast via hub; dormant auto-reply scaffold). `import/resolve|jobs|jobs/[id]|resume|claim/validate` — **job creation unauthenticated** (trackingToken-gated reads; abuse flag F-10). `webhooks/payments/[provider]` (public; HMAC w/ hardcoded demo secret — see E.3).

### store (50 files — seller portal)
All session-guarded (43 `requireActiveSellerStore`, 1 `requireSeller`, 6 inline seller checks); **no unscoped bare-id query found** — every `[id]` route filters by `storeId` or post-checks ownership (`ownProduct`/`ownVariant`/`ownCoupon`/`ownCollection`/`ownEndpoint`). Coverage: `me`, `dashboard`, `products(+[id],variants)`, `inventory/adjust` ($transaction), `orders(+fulfill|ship|deliver|label|refund-request)`, `shipping/quote`, `wallet(+activity/[id])`, `payouts` (uncalled), `coupons*`, `vouchers`, `collections*` (membership $transaction), `pages(+draft|publish|revert)`, `theme`, `settings`, `seo`, `domains*` (verify simulated), `webhooks*`, `integrations`, `connections*` (OAuth begin/disconnect), `imports`, `publish` (canPublish gate), `onboarding`, `bank-accounts`, `chat/*`.

### admin (70 files — back office)
**Guard coverage 70/70** (`requireAdmin` or `requireCap`); **audit coverage: every DB-mutating admin route calls `auditAdmin`** (45 files; the 25 without are read-only GETs or pure-compute `simulate`). Capability matrix: `sellers.approve/suspend`, `products.moderate`, `commission.manage`, `payouts.manage`, `refunds.manage`, `disputes.manage`, `settings.manage`, `impersonate` (unused), `logs.view`, `campaigns.manage`. Coverage: dashboard, sellers(+lifecycle/kyc/notes), kyc-queue, banks(+verify/reject), products(+approve/reject/ban), categories, orders(+[id]), refunds(+approve|process|reject), disputes, coupons, banners, featured, campaigns, announcements (uncalled), stores, wallets(+adjust T6), ledger/accounts+transactions, payout-batches, payouts(+mark-paid|fail), commission/* (see E.4), tickets, reports/[type], export, settings, feature-flags, audit-logs, activity-logs, notifications, webhook-deliveries(+replay, uncalled), system/health.

## E.3 End-to-end trace A — checkout → paid order → ledger

1. **Quote** `POST /checkout/quote` (`quote/route.ts`): `priceItems` (server price from variants; qty/active/live validation) → `computeGroupPricing` (per-store groups, per-group free-ship threshold RM100 standard/express RM15 non-East-MY, coupon applies to exactly ONE highest-subtotal eligible group) → `buildVoucherOutcomes` soft mode → aggregate. Nothing persisted. [V] `checkout/pricing.ts:12-17,78-330`
2. **Create** `POST /checkout/create` (`create/route.ts`): requireShopper → **replay by idemKey** (PaymentGroup then legacy Order; 403 cross-user) → validation (provider ∈ KNOWN_PROVIDERS, address, email/phone) → **recompute pricing from scratch** → **hard voucher mode** (unusable selection ⇒ 409) → commission via `computeOrderCommissions` on voucher-adjusted totals → `nextOrderNumber()` per group (**outside tx**) → **single `$transaction`**: stock re-check (check-then-act decrement, no `stock >= qty` conditional), PaymentGroup, Orders(payment_pending), **atomic voucher redemption** (guarded `updateMany AVAILABLE→USED` + quota increment), OrderItem.createMany **with frozen commission snapshots**, stock decrement + InventoryLog + salesCount, history row, CouponRedemption+timesUsed → post-commit notify+audit. [V] `:33-350`
3. **Pay** `GET /payments/[ref]` (public status; computed `expired`), **simulate** (server signs payload with `WEBHOOK_SECRET` and calls the exact production processor), **retry** (failed→requires_payment). [V]
4. **Webhook** `POST /webhooks/payments/[provider]` → `processPaymentWebhook` (`webhooks/payments/process.ts`): always log `PaymentWebhookLog` first (incl. bad signatures) → HMAC-SHA256 over `"{ref}.{event}.{amountMinor}.{ts}"`, **hardcoded demo secret** (`:26`), non-timing-safe compare (`:63`), **no replay window** → amount guard 409 → **duplicate handling = status check** (`group.status==="succeeded"` ⇒ no-op `duplicate:true`, `:98-110`; intent `:210-221`) → success: `group.succeeded` → per order `transitionOrder(→paid)` → **T1** `postOrderPaid` (DR GATEWAY total / CR SELLER:PAYABLE net w/ `availableAt=holdUntil` / CR REVENUE_COMMISSION) + `refreshWalletCache` → simulated store webhooks + notifications + **cart cleared server-side**. [V]
5. **Known hazards** (detailed in Support 06): non-transactional success path (status flip before ledger; crash ⇒ paid order never credited, retries return duplicate), status-only idempotency ⇒ TOCTOU double-T1 under concurrency, T1 silently skipped if seller/wallet missing (`:151,268`). [V]

## E.4 Commission endpoints

| Endpoint | Guard | Behaviour |
|---|---|---|
| `GET|PUT /admin/commission/settings` | A / C(commission.manage) | `rateBpsFrom` digit-exact validation; payoutHoldDays 0..60; basePriceRule enum; upsert singleton id=1; audited |
| `GET|POST|PATCH|DELETE /admin/commission/overrides(+[id])` | A / C | scope∈{category,seller,product}; `rateBpsFrom`; validity window; audited. **Table is never read by the engine** (FIN-01) |
| `GET|POST|PATCH|DELETE /admin/commission/holidays(+[id])` | A / C | startsAt<endsAt required; `rateBpsFrom ?? 0`; audited |
| `GET|POST /admin/commission/exports` (+`GET /[id]/download`) | A / C | POST: days 7..730, `aggregateCommission`, 409 `EMPTY_PERIOD`, snapshot stored; download **regenerates CSV from frozen snapshotJson — never recomputed** (byte-stable), `Cache-Control: no-store` |
| `POST /admin/commission/simulate` | A | pure computation, no write/audit |
| `GET /admin/commission/analytics` | A | ledger-truth aggregation + recent exports + PSP scaffold state |
| `GET|PUT /admin/commission/psp-settings` | A / C | PUT autoSettle:true ⇒ **409 PSP_ADAPTER_REQUIRED**; provider must have `awaitingAdapter:false` (only `mock`); audited |

## E.5 Trace B — refunds; Trace C — payouts (summaries; full detail Support 06 §5–6)

**Refunds**: shopper `return-request` creates a **Dispute** (no money); seller `refund-request` is the **only `db.refund.create`** (amount ≤ total−Σnon-rejected); admin approve/reject; **process** = Refund(processed) + `commissionReversalMinor = bpsOf(amount, frozen item bps)` + **T5** + order→`partially_refunded|refunded` + OrderItem.refundedMinor (whole amount charged to first item with remaining balance — heuristic) + restock (**full item qty regardless of partial amount**) + paymentIntent→refunded. **No `$transaction`**; idempotency = status check-then-act. [V]

**Payouts**: `POST /admin/payout-batches {dryRun}` → eligibility = ledger-truth `availableMinor ≥ payout.min_minor` → real run: batch(running) → per wallet: counter `PO-<n>`, statement period since last **paid** payout, `buildLedgerStatementFromLedger` (ledger-derived, balancing "retained" line), Payout(processing) + **T3**; batch→completed. `mark-paid` ⇒ **T4** (clearing→bank) + paidAt/providerRef; `fail` ⇒ **T4f** (reverse to payable, immediately available). Non-transactional loop; small check-then-act races. [V]

## E.6 Cross-cutting anomalies

- **Uncalled endpoints**: `GET /api/store/payouts`, `/api/admin/announcements*`, `/api/admin/webhook-deliveries(+replay)`, `POST /api/shipping/tick`. **Broken caller**: `admin/stores.tsx:64` → non-existent `/api/admin/domains/[id]/verify` (404). [V]
- **Business rules in multiple places**: free-ship threshold (pricing.ts + checkout copy), order-status arrays ≥5×, payment providers (client 4 vs server 5), status label maps ≥5× (Support 10 §4).
- **Frontend-only logic**: none financially authoritative (server recomputes everything at create/webhook); client quote math is display-only.
- **Input validation**: manual everywhere except zod in 3 `me/*` routes; webhook `amountMinor = Math.round(Number(...))` coerces instead of rejecting (`process.ts:55`).
- **Unauthenticated mutation surface**: simulate, retry, webhook, reviews, newsletter, shipping/tick, import jobs — all flagged in Support 07 §5.
