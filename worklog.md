# SHOPMESH Build Worklog

Project: SHOPMESH v1 — multi-tenant commerce platform (storefronts + page builder + marketplace + commission engine + double-entry ledger + payouts + admin command centre), built from the PART0..PART6 blueprint in /home/z/my-project/upload/.

Sandbox adaptations (decided, do not change):
- Single Next.js 16 app (App Router) on port 3000. Single user-visible route `/`; all surfaces (Shopper / Seller / Admin) are client-side surfaces switched in src/components/app-root.tsx via zustand (src/lib/app-store.ts).
- SQLite + Prisma (db/custom.db) instead of PostgreSQL. Money = Int minor units (cents). JSONB → String JSON columns (src/lib/json.ts). Enums → String + app-level validation.
- No Redis/Meili/BullMQ: workers simulated inline (webhook deliveries recorded on demand, notifications logged to notification_logs, wallet cache refreshed on write).
- Mock payment gateway: checkout creates PaymentIntent with redirectUrl /pay/{providerRef}; a mock hosted payment page (part of shopper surface) POSTs a signed webhook to /api/webhooks/payments/{provider}; API verifies HMAC signature, logs to payment_webhook_logs, marks order paid, posts ledger T1.
- Auth: cookie session (sm_session) stored in Session table. /api/auth/* already implemented. Demo credentials seeded.
- Placeholder images: GET /api/img/{seed}?w=&h=&label= returns deterministic SVG. Use it for ALL demo imagery (never external URLs).

## Task 1 — Foundation (DONE, by orchestrator)

Files created (DO NOT MODIFY except where noted):
- prisma/schema.prisma — full data model (~50 models). db pushed.
- prisma/seed.ts — rich demo data (5 sellers/stores, 27 products, 14 orders, 18 balanced ledger txns, payout batch, coupons, banners, tickets, audit logs). Run: `bun prisma/seed.ts` (idempotent, wipes first).
- src/lib/db.ts (prisma client, `import { db } from "@/lib/db"`)
- src/lib/money.ts — formatMinor(minor, currency="MYR"), toMinor(input), commissionOf(base, percent) [round-half-up], allocateProportionally(amount, weights[]), divHalfUp
- src/lib/json.ts — parseJson<T>(raw, fallback), toJson(value)
- src/lib/commission.ts — M09 engine: getCommissionSettings(), resolveRate({sellerId, categoryId, productId, now}) → {percent, source: fee_holiday|product|category|seller|global, holdDays, fixedFeeMinor}, computeOrderCommissions({sellerId, items[], orderDiscountMinor, shippingMinorTotal, now}) → {items: [{discountMinor, shippingMinor, baseMinor, percent, percentPartMinor, fixedFeeMinor, commissionMinor, sellerNetMinor, breakdown}], orderCommissionMinor, orderSellerNetMinor, holdDays, holdReleaseRule}, simulateCommission(...)
- src/lib/ledger.ts — M10 engine: ACCOUNTS.*, ensureWalletAccounts(walletId), postTransaction({txnType, refType, refId, description, lines[]}) [throws if unbalanced], journal recipes: postOrderPaid, postGatewaySettlement, postPayoutInitiated, postPayoutConfirmed, postPayoutFailed, postRefund, postAdminAdjustment; walletTruth(walletId) [pending=credits availableAt>now, available=matured credits−debits], refreshWalletCache(walletId), runLedgerInvariants(), buildPayoutStatement(...)
- src/lib/password.ts — hashPassword, verifyPassword, randomToken, hmacSha256Hex(secret, payload)
- src/lib/auth.ts — createSession(userType, userId), destroySession(), getSession(), requireAdmin() → AdminUserDTO, requireAdminRole(roles), requireCap(cap) [RBAC matrix], requireSeller() → SellerUserDTO {id, email, fullName, displayName, status, storeId, storeSlug, storeName}, requireActiveSellerStore() → {me, store}
- src/lib/api.ts — ApiError(status, code, msg), ok(data), okPaged(rows, {page,size,total}), fail(status, code, msg, details?), handle(fn) [route wrapper — ALWAYS wrap handlers], getPagination(url) → {page,size,skip,take}, auditAdmin({adminId, adminEmail, action, entityType, entityId, before, after}), logActivity(...), notify({event, channel, recipient, subject}), dispatchStoreWebhooks({storeId, event, payload}), transitionOrder({orderId, toStatus, actor, note, timestamps}) [writes history], slugify(s), nextOrderNumber() → "SM-100xxx"
- src/lib/sections.ts — SECTION_REGISTRY (15 section types with defaultProps + builder fields), createSection(type), parsePageDoc(json) → {sections, version}, parseTheme(json) → ThemeTokens, DEFAULT_THEME, defaultHomeSections(storeName, tagline), defaultPageSections(pageType, storeName). Page doc JSON shape: {sections:[{id, type, props}], version}
- src/lib/app-store.ts — zustand: useApp() {surface: 'shopper'|'seller'|'admin', setSurface, activeStoreSlug, setActiveStoreSlug, me, refreshMe(), logout()}
- src/components/app-root.tsx — surface switcher + lazy shells (imports the 3 shells; do not rename files)
- src/app/page.tsx — renders <AppRoot/>
- src/app/api/img/[seed]/route.ts, src/app/api/auth/{me,login,logout,register}/route.ts, src/app/api/health/route.ts

Seed demo accounts (all seeded):
- Admin: admin@shopmesh.io / Admin123! (superadmin), ops@shopmesh.io / Ops12345! (ops), finance@shopmesh.io / Finance123! (finance), moderator@shopmesh.io / Mod12345! (moderator)
- Sellers (password all Seller123!): lumina@shopmesh.io (active, "Lumina Living", slug lumina-living), byte@shopmesh.io (active, "ByteBazaar"), glow@shopmesh.io (active, "Glow Theory"), warung@shopmesh.io (pending_review, "Warung Satu" — KYC queue), trail@shopmesh.io (onboarding, "TrailKit Outdoors" — onboarding wizard demo)
- Currencies: MYR everywhere. Timezone Asia/Kuala_Lumpur.

Environment rules for all agents:
- Dev server already runs on port 3000 in background (log: /home/z/my-project/dev.log — read the TAIL only). Do not run `bun run build`. Use `bun run lint` from /home/z/my-project to check your files.
- shadcn/ui components exist in src/components/ui (list: accordion, alert, alert-dialog, avatar, badge, breadcrumb, button, calendar, card, carousel, checkbox, collapsible, command, dialog, drawer, dropdown-menu, form, hover-card, input, input-otp, label, menubar, navigation-menu, pagination, popover, progress, radio-group, resizable, scroll-area, select, separator, sheet, sidebar, skeleton, slider, sonner, switch, table, tabs, textarea, toast, toaster, toggle, toggle-group, tooltip). Also @dnd-kit, recharts, framer-motion, date-fns, sonner (use `toast` from "sonner"), lucide-react icons.
- All data fetching client-side via fetch("/api/...") — same origin, cookies included automatically. NO absolute URLs, NO other ports, NO server actions.
- Money display: always formatMinor. Never floats for money math.
- Responsive: mobile-first; lists in max-h-[480px] overflow-y-auto where long; use min-h-[44px] touch targets.
- Do NOT modify: prisma/schema.prisma, src/lib/** (read-only), src/app/page.tsx, src/components/app-root.tsx, package.json, other agents' directories. If you need a helper, define it locally in your own directory.
- Lint before finishing: `bun run lint` (fix ONLY errors/warnings in files you own).

## API CONTRACT (v1) — implemented by Task 2-a (admin+auth-adjacent) and Task 2-b (store/market/checkout)

Envelope: {data} | {data, meta:{page,size,total}} | {error:{code,message,details}}.
Auth: cookie session. Admin endpoints require admin session (401 otherwise). Seller endpoints require seller session. Public endpoints listed as public.

### Task 2-a scope — /api/admin/** (all require admin session unless noted)
- GET  /api/admin/dashboard → KPI object {gmvTodayMinor, ordersToday, commissionTodayMinor, activeStores, pendingKyc, productsToModerate, refundsQueue, disputesOpen, payoutsDueMinor, payoutsDueSellers, gmvSeries30d: [{date, gmvMinor, orders}], topStores: [{storeName, gmv30dMinor, orders30d}], recentSellers: [{id, displayName, storeName, status, createdAt}]}
- GET  /api/admin/sellers?status=&search=&riskTier=&page=&size= → Seller[] w/ store, wallet, gmv30dMinor
- GET  /api/admin/sellers/[id] → {seller, store, kycDocuments, bankAccounts, wallet, products(5 recent), orders(5 recent), notes, gmv30dMinor}
- PATCH /api/admin/sellers/[id] {riskTier?, commissionOverridePercent?, holdDaysOverride?, marketplaceOptIn?} (audit)
- POST /api/admin/sellers/[id]/approve  (sets seller active, store live, kyc approved, notify kyc.approved) — RBAC sellers.approve
- POST /api/admin/sellers/[id]/reject {reason} → status rejected
- POST /api/admin/sellers/[id]/suspend {reason?} / POST /api/admin/sellers/[id]/activate  (store status live/draft) — RBAC sellers.suspend
- POST /api/admin/sellers/[id]/terminate {reason?}
- POST /api/admin/sellers/[id]/kyc/[docId] {decision: approved|rejected, reason?} (audit; auto-approve seller when all docs approved + bank verified + ≥1 product)
- GET/POST /api/admin/sellers/[id]/notes {body}
- GET  /api/admin/kyc-queue → sellers pending_review w/ docs + bank + products (cards)
- GET  /api/admin/products?status=pending_review|all&search=&storeId=&page= → products w/ images, store name, flags
- POST /api/admin/products/[id]/approve | /reject {reason?} | /ban {reason?} (audit; RBAC products.moderate)
- GET/POST /api/admin/categories {name, parentId?} ; PATCH/DELETE /api/admin/categories/[id] {name?, commissionPercent?} (delete nulls product.categoryId)
- GET  /api/admin/orders?status=&storeId=&search=&page= ; GET /api/admin/orders/[id] → {order, items, history, paymentIntents, refunds, dispute}
- GET  /api/admin/refunds?status= ; POST /api/admin/refunds/[id]/approve ; POST /api/admin/refunds/[id]/process → posts ledger T5 postRefund (commission reversal = round(refund * item.commissionPercent/100) using the order's largest refunded item), sets item refundedMinor, order status refunded/partially_refunded, restocks variants if restock, webhook dispatch order.refunded
- POST /api/admin/refunds/[id]/reject {reason?}
- GET  /api/admin/disputes ; PATCH /api/admin/disputes/[id] {status, resolution?} (resolve clears order.disputedFlag)
- GET/PUT /api/admin/commission/settings (PUT audit; validate percent 0..100)
- GET/POST /api/admin/commission/overrides ; PATCH/DELETE /api/admin/commission/overrides/[id]
- GET/POST /api/admin/commission/holidays ; PATCH/DELETE /api/admin/commission/holidays/[id]
- POST /api/admin/commission/simulate → simulateCommission(body) — PUBLIC? no, admin-only
- GET  /api/admin/wallets → wallets w/ seller + store names (recompute via refreshWalletCache per wallet)
- POST /api/admin/wallets/[id]/adjust {amountMinor, direction: credit|debit, reason} → postAdminAdjustment T6 + audit — RBAC payouts.manage
- GET  /api/admin/ledger/transactions?type=&cursor=&walletId= → txns w/ lines (last 100 ok, cursor by id desc)
- GET  /api/admin/ledger/accounts → accounts with balance (sum debit vs credit)
- GET  /api/admin/payouts?status=&batchId= ; POST /api/admin/payouts/[id]/mark-paid {referenceNo} → T4 + status paid + notify payout.paid ; POST /api/admin/payouts/[id]/fail {reason} → T4f reversal + status failed
- GET  /api/admin/payout-batches ; POST /api/admin/payout-batches {dryRun?: boolean} → dryRun: preview wallets ≥ min (setting payout.min_minor) w/o writing; else create batch + payouts(processing) + T3 per wallet + statementJson; payouts status processing, method = setting payout.mode — RBAC payouts.manage
- GET  /api/admin/banks?verified=false ; POST /api/admin/banks/[id]/verify | /reject
- GET/POST /api/admin/coupons ; PATCH/DELETE /api/admin/coupons/[id]
- GET/POST /api/admin/banners ; PATCH/DELETE /api/admin/banners/[id]
- GET/POST /api/admin/featured {productId, slot?} ; DELETE /api/admin/featured/[id]
- GET/POST /api/admin/announcements ; PATCH /api/admin/announcements/[id]
- GET  /api/admin/audit-logs?adminEmail=&action=&entityType=&page= ; GET /api/admin/activity-logs?actorType=&page=
- GET/PUT /api/admin/settings (key/valueJson list; PUT upserts, audit) — RBAC settings.manage
- GET/PATCH /api/admin/feature-flags {key, isEnabled?, rolloutPercent?}
- GET  /api/admin/system/health → counts, runLedgerInvariants(), latest activity, db ok
- GET  /api/admin/notifications (notification logs, latest 100)
- GET  /api/admin/webhook-deliveries ; POST /api/admin/webhook-deliveries/[id]/replay (mark pending→success sim)
- GET  /api/admin/tickets?status= ; GET /api/admin/tickets/[id] (w/ messages) ; POST /api/admin/tickets/[id]/reply {body} ; PATCH /api/admin/tickets/[id] {status, priority?}
- GET  /api/admin/reports/[type]?days=30 for type in sales|sellers|commission|payouts → aggregated series+rows
- GET  /api/admin/stores?search= → stores w/ seller + product counts
- GET  /api/admin/export → CSV export (simple: return text/csv of requested entity, e.g. ?entity=orders) — keep simple

### Task 2-b scope — /api/store/**, /api/market/**, /api/sf/**, /api/cart, /api/checkout/**, /api/webhooks/**, /api/orders/lookup
Seller (require seller session; store scoped):
- GET  /api/store/me → {seller, store, wallet, onboarding: {step, checklist: {profile, storeIdentity, kyc, bank, products}}, stats}
- POST /api/store/onboarding {action: "submit"} → seller.status=pending_review, submittedAt (notify admin email log)
- PATCH /api/store/settings {name?, tagline?, description?, supportEmail?, supportPhone?, whatsapp?, marketplaceOptIn?, logoUrl?, bannerUrl?, social?} (also updates cms header if needed)
- GET/POST /api/store/products (create w/ images[], variants[]; first 5 products of seller → pending_review per setting moderation.first_n, else active unless banned keywords [list: "replica","fake","gun","drug"] → flags) ; GET/PATCH/DELETE /api/store/products/[id] (delete = archive)
- POST /api/store/products/[id]/variants {name, optionName?, optionValue?, priceMinor, stock?, sku?} ; PATCH/DELETE /api/store/variants/[id] ; POST /api/store/inventory/adjust {variantId, delta, reason} → InventoryLog + stock.low notify when below threshold
- GET  /api/store/orders?status=&search= ; GET /api/store/orders/[id]
- POST /api/store/orders/[id]/fulfill → processing ; POST /api/store/orders/[id]/ship {provider, trackingNumber} → shipped + dispatchStoreWebhooks order.shipped + notify customer email
- POST /api/store/orders/[id]/refund-request {amountMinor, reason?, restock?} → Refund requested (notify admin)
- GET  /api/store/wallet → {wallet(truth-refreshed), recentLines: ledger lines for wallet account (desc 20), payouts}
- GET  /api/store/payouts ; GET/POST /api/store/bank-accounts {holderName, bankName, accountNumber}
- GET  /api/store/pages ; PUT /api/store/pages/[id]/draft {sections} (bump draftVersion, hasUnpublished=true) ; POST /api/store/pages/[id]/publish (publishedJson=draftJson, publishedVersion++, hasUnpublished=false) ; POST /api/store/pages/[id]/revert (draft=published)
- GET/PUT /api/store/theme {theme}
- GET/POST /api/store/coupons (store scope) ; PATCH/DELETE /api/store/coupons/[id]
- GET  /api/store/collections ; POST /api/store/collections {name} ; POST /api/store/collections/[id]/products {productIds}
- GET/PUT /api/store/integrations {integrations: [{provider, config, isEnabled}]} (upsert per provider)
- GET/POST /api/store/webhooks ; PATCH/DELETE /api/store/webhooks/[id] ; POST /api/store/webhooks/[id]/test → creates a demo delivery
- GET  /api/store/domains ; POST /api/store/domains {domain, mode} (status verifying) ; POST /api/store/domains/[id]/verify → simulate: status verified→active, ssl issued (notify domain.verified) ; DELETE /api/store/domains/[id]
- GET  /api/store/dashboard → today/7d/30d cards {orders, revenueMinor, commissionMinor, netMinor}, lowStock: variants stock<=threshold, recentOrders 5, pendingActions

Public market/storefront:
- GET  /api/market/home → {banners, categories(tree, 2 levels), featured: ProductCard[], latest: ProductCard[], topStores: StoreCard[]}
- GET  /api/market/products?search=&category=&sort=newest|price_asc|price_desc|popular&page= → ProductCard[] paged (filter: product.status=active, store.status=live, store marketplaceOptIn) ProductCard = {id, slug, title, priceMinor, compareAtPriceMinor, imageUrl, storeName, storeSlug, ratingAvg, ratingCount, salesCount, categoryName}
- GET  /api/market/stores → StoreCard[] {id, name, slug, tagline, logoUrl, bannerUrl, productCount}
- GET  /api/sf/[slug] → store home: {store: {name, slug, tagline, logoUrl, theme(parsed), whatsapp, supportEmail}, page: {title, sections(parsed), publishedVersion}, products for grid sections resolved? NO — client fetches products per section via /api/sf/[slug]/products?source=&limit=&collection=
- GET  /api/sf/[slug]/products?search=&collection=&source=latest|featured&limit= → ProductCard[]
- GET  /api/sf/[slug]/products/[pSlug] → PDP: {product: {id, title, slug, description, images[], variants[], priceMinor, compareAtPriceMinor, ratingAvg, ratingCount}, reviews[], related[6], store:{name, slug, tagline, whatsapp}}
- POST /api/sf/[slug]/products/[pSlug]/reviews {customerName, rating, title?, body?} → recompute product rating
- GET  /api/sf/[slug]/pages/[pageSlug] → {store, page, sections} for about/contact/policy
- POST /api/sf/[slug]/newsletter {email} → notification log + activity log

Cart & checkout (guest; cart token cookie sm_cart; one cart per store):
- GET  /api/cart → current cart w/ items (variant+product+store joined) — creates empty if missing? return null-safe {cart: {items:[]}} when empty
- POST /api/cart/items {variantId, qty} → adds (sets cart storeId from variant), PATCH /api/cart/items/[id] {qty}, DELETE /api/cart/items/[id]
- POST /api/checkout/quote {storeSlug, items:[{variantId, qty}], couponCode?, shippingRateId?} → server recompute: {subtotalMinor, discountMinor, shippingMinor, totalMinor, coupon: {code, valid, reason?}, items:[{title, variantLabel, qty, unitPriceMinor, lineTotalMinor}], commissionPreviewMinor?} — coupon validation: window/active/minSpend/usage limits (platform+store coupons)
- POST /api/checkout/create (Idempotency-Key header; if Order with same idemKey exists return it) {storeSlug, items, customer:{name,email,phone}, shippingAddress, couponCode?, provider, customerNote?} → validates stock, recomputes via computeOrderCommissions (snapshot), decrements stock, creates Order(payment_pending)+items+intent(providerRef ref_sm{rand}, redirectUrl /pay/{providerRef}, TTL 30min), history row, notify admin email "New order", returns {orderNumber, orderPaymentRef}
- GET  /api/checkout/payments/[ref] → {status: requires_payment|succeeded|failed, orderNumber, amountMinor, storeName}
- POST /api/webhooks/payments/[provider] — body {providerRef, eventType: payment.succeeded|payment.failed, amountMinor, ts, sig}. Verify sig = hmacSha256Hex("sm_webhook_secret_demo", `${providerRef}.${eventType}.${amountMinor}.${ts}`) header X-SM-Signature (ALSO accept sig in body.sig). Log PaymentWebhookLog (raw). Idempotent by providerRef (if intent already succeeded → return ok). On payment.succeeded: intent succeeded, transitionOrder paid (paidAt), T1 postOrderPaid (wallet from store.seller, holdUntil = paidAt + holdDays from commission settings), coupon redemption record + timesUsed++, product salesCount++ (done at create? NO — do here), dispatchStoreWebhooks order.paid, notify seller email+inapp + customer email. On failed: intent failed.
- GET  /api/orders/lookup?email=&orderNumber= → order status for shoppers (guest order tracking)

Payment providers list (for checkout UI): [{id: "fpx_toyyibpay", label: "FPX Online Banking"}, {id: "tng", label: "Touch 'n Go eWallet"}, {id: "grabpay", label: "GrabPay"}, {id: "card_stripe", label: "Card (Stripe MY)"}]. Webhook secret for the mock pay page: "sm_webhook_secret_demo".

---

### CONTRACT ADDENDUM (sandbox mock payment)
- POST /api/checkout/payments/[ref]/simulate {result: "succeeded"|"failed"} (public; part of Task 2-b)
  Server-side only: builds the webhook payload, signs it with hmacSha256Hex("sm_webhook_secret_demo", `${ref}.${eventType}.${amountMinor}.${ts}`), and internally invokes the same verification+processing logic as /api/webhooks/payments/[provider] (HMAC secret NEVER exposed to client). The mock hosted payment page in the shopper surface calls this endpoint. Returns {status, orderNumber}.

### SURFACE MAP (UI agents)
- Shopper surface = marketplace + storefronts + cart + checkout + mock payment + order lookup (Task 2-e, src/components/shopper/**)
- Seller surface = auth + onboarding wizard + dashboard + catalog + orders + wallet + page builder + domains + coupons + integrations + settings (Task 2-d, src/components/seller/**)
- Admin surface = command centre per PART4 nav tree (Task 2-c, src/components/admin/**)
---
Task ID: 2-a
Agent: full-stack-developer (admin API)
Task: All /api/admin/** routes (64 route files)

Work Log:
- Implemented every endpoint in the contract: dashboard, sellers CRUD + lifecycle (approve/reject/suspend/activate/terminate), KYC doc review, notes, kyc-queue, product moderation, categories tree, orders, refunds (approve/process/reject with ledger T5), disputes, commission settings/overrides/holidays/simulate, wallets + adjustments (T6), ledger transactions/accounts, payouts + batches (dry-run + T3/T4/T4f), banks, coupons/banners/featured/announcements, audit/activity logs, settings/flags, system health (with runLedgerInvariants), notifications, webhook deliveries + replay, tickets + replies, reports (sales/sellers/commission/payouts), export CSV.
- All mutations write admin_audit_logs with before/after; RBAC enforced via requireCap.
- Tested via curl with admin session (dashboard, simulate, wallets, payout dry-run, real batch).

Stage Summary:
- Admin API 100% implemented; ledger invariants green after all operations.
- Note: response shapes: kyc-queue returns {docs, docsTotal, store:{productCount}}; products list paged {data, meta}.

---
Task ID: 2-b
Agent: full-stack-developer (store/checkout API)
Task: /api/store/**, /api/market/**, /api/sf/**, /api/cart, /api/checkout/**, /api/webhooks/payments/**, /api/orders/lookup (52 route files)

Work Log:
- Seller APIs: me/onboarding/settings, products (moderation.first_n + keyword flags), variants, inventory adjust + stock.low, orders fulfill/ship + webhooks + notify, refund-request, wallet (truth-refreshed), payouts, bank accounts, pages draft/publish/revert, theme, coupons, collections, integrations, webhooks + test, domains (simulated verify), dashboard stats.
- Public APIs: market home/products/stores, sf store/pages/products/reviews/newsletter, cart (cookie token, one store per cart), checkout quote (coupon validation + server-recompute), checkout create (Idempotency-Key, stock decrement, commission snapshots), payments status, payment webhook (HMAC verify + idempotent + T1 posting + notify + webhook fan-out), payments simulate (server-side signing), order lookup.
- Golden path verified via curl: add-to-cart → quote (category commission 6% resolved) → create → simulate succeeded → order paid → wallet pending increased → ledger balanced → seller fulfill/ship.

Stage Summary:
- Checkout pipeline fully functional end-to-end with double-entry T1 and wallet cache sync.

---
Task ID: 2-c / 2-c2
Agent: full-stack-developer (admin UI)
Task: Admin command centre (src/components/admin/**, ~7,000 lines)

Work Log:
- admin-shell: auth gate + demo one-click login, sidebar (PART 4 nav tree), top bar, view switcher.
- Views: Dashboard (KPIs + recharts GMV 30d + queues), Sellers list/detail (tabs: overview/KYC/orders/wallet/banks/notes), KYC Queue, Stores, Product Moderation gallery + drawer + confirm dialogs, Categories, Orders + Order Detail (money panel + timeline + breakdown chips), Refunds (approve/process/reject), Disputes, Commission Settings (live simulator panel), Overrides, Fee Holidays, Simulator, Wallets (+adjust dialog), Ledger Explorer (txns + lines + accounts), Payout Batches (dry-run preview → create) + detail (mark paid/fail), Bank Verification, Banners, Featured, Coupons, Support tickets, Reports (4 types + CSV export), Settings, Flags, Audit Log (diff viewer), Activity, Notifications, System Health.
- Fixed use-api.ts syntax bug (meta state declaration).

Stage Summary:
- All 25+ admin screens implemented per PART 4 wireframes.

---
Task ID: 2-d
Agent: full-stack-developer (seller UI)
Task: Seller surface (src/components/seller/**, ~5,900 lines)

Work Log:
- Auth screen (login/register tabs + demo fill), onboarding wizard (4 steps: store identity + template, KYC simulated attach, bank account, review + submit), pending_review screen with polling, full dashboard for active sellers.
- Views: Dashboard (today/7d/30d + pending actions + low stock + latest orders), Products (list + editor with variants + images + moderation states), Orders (tabs + detail with fulfill/ship/refund request + packing slip print), Wallet (pending/available explainer + ledger-lite + payouts + banks), Page Builder (section library with all 15 registry types, live canvas with device toggle, props form per field schema, dnd reorder, autosave, publish/revert, theme editor), Domains (DNS instructions + verify simulation), Coupons, Integrations (pixels/webhooks/API keys), Store Settings (identity + marketplace opt-in).

Stage Summary:
- Seller journey complete: register → onboarding → pending_review → active dashboard.

---
Task ID: 2-e
Agent: full-stack-developer (shopper UI)
Task: Shopper surface (src/components/shopper/**, ~4,000 lines)

Work Log:
- Market home (banner carousel, categories, featured/latest grids, top stores), search/category results with sort + pagination, storefront section renderer (all 15 types with theme CSS vars + error boundary + fallback box), store pages, PDP (gallery, variants, reviews, related), cart drawer (qty edit, per-store), checkout (contact/address/shipping options/coupon/summary/providers), mock payment gateway page (countdown, Pay Now/simulate failure, auto-poll), order status timeline, order lookup.
- Fixed: React import missing in storefront.tsx (500), reserved `ref` prop on PayView.

Stage Summary:
- Full shopper purchase loop verified in browser with real order SM-100019.

---
Task ID: 3
Agent: orchestrator
Task: Integration, lint fixes, self-verification

Work Log:
- Fixed hydration mismatch (surface from localStorage now applied post-mount via hydrateSurface).
- Fixed src/lib/password.ts require() import.
- Added targeted eslint-disable comments for intentional fetch-reset effects (react-hooks/set-state-in-effect), removed unused directive.
- Fixed KYC queue UI/API key mismatch (docs/store.productCount).
- Verified via agent-browser: market home, PDP, add-to-cart, cart drawer, checkout + FREESHIP coupon, mock payment, order status SM-100019, admin login/dashboard/commission+simulator/KYC approve (Warung Satu went live)/moderation approve flow, seller dashboard/page builder, mobile viewport (390px), zero hydration errors, ledger invariants green.

Stage Summary:
- PLATFORM SHIPPED. All portals functional; commission engine, double-entry ledger, payouts verified consistent after real browser-driven purchases.
