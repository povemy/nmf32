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

---
Task ID: 2-c
Agent: image-gen (Glow Theory)
Task: Generate 9 product/brand images for Glow Theory store

Work Log:
- Created public/products/ and public/stores/ directories.
- Generated 7 product mockups (1024x1024) via `z-ai image` CLI with clinical-clean skincare prompts + shared style guide (soft teal-cyan gradient, dewy spa aesthetic, no text/watermark/people):
  barrier-repair-serum, gentle-gel-cleanser, mineral-spf50, sheet-mask-5, sleeping-mask, vitc-ampoules, peptide-eye-complex → public/products/{slug}.png
- Generated 2 brand images via `z-ai image` CLI: glow-theory-logo.png (1024x1024, teal/cyan droplet molecular icon) and glow-theory-banner.png (1344x768, spa flatlay with water ripples) → public/stores/
- One transient failure: sheet-mask-5 first attempt rejected by upstream content filter (API 400, code 1301); retried with reworded prompt ("facial skincare packets / facial sheet") and succeeded on retry 1.
- Verified all 9 files exist with non-trivial sizes (31KB–99KB). Note: z-ai CLI writes JPEG-encoded data with .png filenames (same as all other agent images in public/); browsers render them fine.

Stage Summary:
- Successfully created (9): public/products/barrier-repair-serum.png, public/products/gentle-gel-cleanser.png, public/products/mineral-spf50.png, public/products/sheet-mask-5.png, public/products/sleeping-mask.png, public/products/vitc-ampoules.png, public/products/peptide-eye-complex.png, public/stores/glow-theory-logo.png, public/stores/glow-theory-banner.png
- Failures: none (sheet-mask-5 resolved on retry).

---
Task ID: 2-b
Agent: image-gen (ByteBazaar)
Task: Generate 10 product/brand images for ByteBazaar store

Work Log:
- Created output directories: public/products/, public/stores/
- Generated 8 product mockups (1024x1024) sequentially via `z-ai image` CLI, one per ByteBazaar product (Pulse ANC Earbuds, MK65 Tactile keyboard, USB-C Hub 8-in-1, Felt & Cork Desk Mat, BT Bookshelf Speakers, 4K Action Cam Lite, RGB Light Bars, Portable Espresso Maker), each with the shared e-commerce style guide appended to a product-specific rich prompt.
- Generated ByteBazaar brand logo (1024x1024, teal/cyan circuit-chip mark) and banner (1344x768, teal-lit desk setup).
- Verified every file after generation: all 10 exist, non-trivial size (42KB-137KB), correct dimensions (logo 1024x1024, banner 1344x768).
- No source code, database, or config files touched. No retries needed — all 10 generations succeeded on first attempt.

Stage Summary:
- Successfully created (10): public/products/pulse-anc-earbuds.png, public/products/mk65-tactile.png, public/products/usbc-hub-8in1.png, public/products/desk-mat-felt.png, public/products/bt-bookshelf-speakers.png, public/products/action-cam-lite.png, public/products/rgb-light-bars.png, public/products/portable-espresso.png, public/stores/bytebazaar-logo.png, public/stores/bytebazaar-banner.png
- Failures: none.

---
Task ID: 2-a
Agent: image-gen (Lumina Living)
Task: Generate 12 product/brand images for Lumina Living store

Work Log:
- Created output directories: public/products/, public/stores/ (mkdir -p).
- Generated 10 product mockups sequentially via `z-ai image ... -s 1024x1024`, one rich prompt per product (named subject + shared style guide: soft diffused studio light, cream/pale-teal airy background, centered, no text/watermark/people): aurora-ceramic-vase, linen-cushion-sand, teak-serving-board, candle-neroli, rattan-wall-mirror, stoneware-mug-set, waffle-towel-set, jute-basket, brass-incense-holder, olive-wood-spoons.
- Generated 2 brand images: lumina-living-logo.png (1024x1024, teal/sand abstract lotus-arch flat vector icon) and lumina-living-banner.png (1344x768, japandi living room scene).
- z-ai CLI wrote JPEG-encoded data under .png filenames (same behavior as other agents' images); converted all 12 files in place to true PNG format with Python PIL (no source/config files touched).
- Verified all 12 files exist as real PNGs with correct dimensions (10 products @1024x1024, logo @1024x1024, banner @1344x768).

Stage Summary:
- Successfully created (12): public/products/aurora-ceramic-vase.png, public/products/linen-cushion-sand.png, public/products/teak-serving-board.png, public/products/candle-neroli.png, public/products/rattan-wall-mirror.png, public/products/stoneware-mug-set.png, public/products/waffle-towel-set.png, public/products/jute-basket.png, public/products/brass-incense-holder.png, public/products/olive-wood-spoons.png, public/stores/lumina-living-logo.png, public/stores/lumina-living-banner.png
- Failures: none (all 12 generated on first attempt).

---
Task ID: 2-d
Agent: image-gen (Warung Satu + TrailKit + banners)
Task: Generate 9 images for Warung Satu, TrailKit stores and marketplace hero banners

Work Log:
- Read worklog.md (lines 1-60) for project context; created public/products, public/stores, public/banners directories.
- Generated 4 product mockups via `z-ai image` at 1024x1024, one command at a time, each verified after generation:
  - public/products/kuih-raya-tin.png (Kuih Raya Gift Tin — festive round tin, pineapple tarts/semperit, batik accents)
  - public/products/sambal-bundle.png (Sambal Bundle — 3 glass jars, kraft labels, chilis beside)
  - public/products/trail-runner-backpack.png (Trail Runner Backpack 12L — burnt orange/gray hydration pack with bottles)
  - public/products/trekking-poles-carbon.png (Carbon Trekking Poles pair — cork grips, collapsible)
- Generated 3 store brand images: warung-satu-logo.png (1024x1024), warung-satu-banner.png (1344x768), trailkit-outdoors-logo.png (1024x1024).
- Hero banners: 1440x720 was rejected by the image API (code 1214: both dimensions must be multiples of 32; 720 is not), even though the CLI lists 1440x720 as an allowed size. Worked around by generating at 1344x768 (API-valid wide size), then center-cropping to 2:1 and resizing to exactly 1440x720 with Python PIL (image files only, no source/config touched).
  - hero-merdeka.png: prompt weighted visual richness (shopping bags, gift boxes, confetti, batik accents) on the right, left third calm/darker for text overlay.
  - hero-zero-commission.png: first attempt failed content filter (code 1301); rephrased prompt (removed "onboarding", softened wording) and generation succeeded on retry 1. Shopfront awnings illustration on right, left third calm for text overlay.
- Final verification with PIL: all 9 files exist as valid PNGs with correct dimensions.

Stage Summary:
- Successfully created (9): public/products/kuih-raya-tin.png, public/products/sambal-bundle.png, public/products/trail-runner-backpack.png, public/products/trekking-poles-carbon.png, public/stores/warung-satu-logo.png, public/stores/warung-satu-banner.png, public/stores/trailkit-outdoors-logo.png, public/banners/hero-merdeka.png, public/banners/hero-zero-commission.png
- Failures: none persistent. Notes: (1) 1440x720 direct generation unsupported by API — banners generated at 1344x768 then converted to 1440x720 via PIL crop+resize; (2) hero-zero-commission initial prompt hit content filter once, succeeded after rephrase.
---
Task ID: p2
Agent: api-doc-researcher
Task: Phase 2 official API documentation research (Shopee + TikTok Shop)

Work Log:
- Fetched official docs for both platforms. TikTok: z-ai page_reader + curl returned only the SPA shell → discovered the official doc content API `partner.tiktokshop.com/api/v1/document/detail?document_id={slug}` (curl-able, returns clean markdown) + full doc tree `/api/v1/document/tree` (972 nodes); fetched 15+ pages incl. search-products-202309, get-product-202309, get-authorized-shops-202309, seller-authorization-guide, authorization overview, common-parameters, sign-your-API-request, rate limits, access scope, app creation, api-versioning, regions-and-languages, common errors, Developer ToS.
- Shopee: page_reader/curl return Nuxt SPA shell only → rendered open.shopee.com in headless browser (agent-browser) and extracted innerText per page: AMS campaign endpoint (spec's link), product.get_item_list / get_item_base_info / get_item_extra_info / get_model_list / get_category, shop.get_shop_info, public.get_access_token, public.refresh_access_token, developer-guide/12 (registration), /14 (app management), /16 (API calls + signature algorithm), /20 (authorization & authentication), policy?policy_id=1 (Data Protection Policy), FAQ index.
- Probed Shopee dev-guide ids 21–25 and FAQ + web-search for rate limits → not found (recorded as UNRESOLVED).
- No live API calls (no credentials in sandbox). Raw captures archived in docs/research-raw/.
- Wrote deliverable: docs/marketplace-integration-research.md (8 sections, VERIFIED/INFERRED/UNRESOLVED tagging, endpoint matrix, Prisma field mapping, env var list).

Stage Summary:
- VERDICT: URL-only (unauthorised) catalogue import is NOT possible on either platform — all catalogue APIs require seller authorization; both platforms' policies forbid unauthorised content access (Shopee DPP "Shopee Content" ownership; TikTok Developer ToS §3.5). Design must be authorization-first; pasted URLs serve only as shop identification.
- Spec's Shopee link v2.ams.get_open_campaign_added_product = Affiliate Marketing Solution open-campaign API (commission rates only, AMS T&C gated) — NOT a catalogue import API. Correct Shopee path: product.get_item_list (offset/page_size≤100) → get_item_base_info (≤50 ids, name/desc/images/prices) → get_model_list (variants w/ tier_index, price_info, stock_info_v2) → shop.get_shop_info (region check).
- TikTok correct path: GET /authorization/202309/shops (shop_cipher) → POST /product/202309/products/search (page_size≤100 + opaque page_token; scope seller.product.basic) → GET /product/202309/products/{id} (full schema: main_images, HTML description, skus[] w/ sales_attributes, inventory, list_price).
- Signing verified: Shopee = HMAC-SHA256(partner_key, partner_id+path+timestamp[+access_token+shop_id]) hex; TikTok = hex HMAC-SHA256(app_secret, secret + sorted{key}{value} + path + body + secret), token in x-tts-access-token header, timestamp window [now−5m, now+30s], shop_cipher required on product endpoints.
- Token lifecycle verified: Shopee code(10min)→access 4h + refresh 30d single-use (rotate), auth validity ≤365d; TikTok auth_code 30min → access 7d, grant_type literal "authorized_code", refresh = granted duration, expiry webhook T-30d, host auth.tiktok-shops.com/api/v2/token/{get,refresh}.
- MY market support confirmed on both (Shopee seller eligibility table incl. MY; TikTok region MY/ms-MY/MYR/COD).
- Rate limits: TikTok dynamic QPS documented (3–10 rps baseline read per App×Shop; 429/36009002); Shopee NOT published on accessible pages → UNRESOLVED, conservative throttle recommended.
- Env vars for deployer: Shopee SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY/SHOPEE_HOST/SHOPEE_REDIRECT_URI; TikTok TIKTOK_APP_KEY/TIKTOK_APP_SECRET/TIKTOK_REDIRECT_URI (+auth/token/api hosts); per-shop tokens belong in DB (MarketplaceConnection), not env.
- Blockers: no credentials in sandbox (cannot live-test); Shopee rate-limit table not publicly accessible; TikTok Partner Center pages are SPA-only for browsers (content API used instead).

---
Task ID: p2-tiktok
Agent: tiktok-doc-researcher
Task: Phase 2 TikTok Shop official docs research

Work Log:
- Method: docs are JS SPAs; used agent-browser CLI per proven pattern (open → sleep 6-8s → innerText in 15k chunks). Discovered that every doc page has a "Download Markdown" button exporting the FULL page incl. nested schema tables → used it for API reference pages (tagged button via eval, clicked via JS, moved UUID-named download).
- Pages fetched (all https://partner.tiktokshop.com/docv2/page/...): seller-authorization-guide; authorization-overview-202407 (token APIs, user_type, domains); sign-your-api-request (HMAC algorithm + Go/Java/Node/Py samples + worked example); common-parameters (app_key/sign/timestamp/x-tts-access-token/shop_cipher); get-authorized-shops-202309; search-products-202309 (full request+response schema); get-product-202309 (full 434-line response schema incl. skus/price/inventory/sales_attributes/main_images/video/package); rate-limits; regions-and-languages; create-your-app; access-scope; tts-webhooks-overview; common-errors; generate-test-access-token; make-your-first-api-call-overview.
- Inaccessible: legacy slug authorization-guide-202309 → "No document found"; Partner Center console (login-gated) not researched; no credentials in sandbox → no live API test.
- Raw page copies saved to ~/.cache/tiktok-docs/*.md (get-product.md 78KB etc.).
- Deliverable written: docs/research-tiktok.md (9 sections per task spec, source URL per claim).

Stage Summary:
- Base host for ALL OpenAPI calls (US+ROW): https://open-api.tiktokglobalshop.com; token host https://auth.tiktok-shops.com/api/v2/token/{get,refresh}; seller auth link https://services.tiktokshop.com/open/authorize?service_id={service_id} (US adds .us).
- grant_type is literally "authorized_code" (NOT authorization_code); auth_code expires 30 min, single use.
- Access token default validity 7 days (x-tts-access-token header, 202309+); refresh_token valid = authorization duration; 30-day expiry warning webhook (UPCOMING_AUTHORIZATION_EXPIRATION) then daily; revoke → SELLER_DEAUTHORIZATION.
- Signing = HMAC-SHA256(secret + path + sorted{key}{value} + raw_body(except multipart) + secret), excluding sign & access_token; timestamp 10-digit unix, window [now-5min, now+30s].
- Common params: app_key, sign, timestamp (query) + x-tts-access-token (header) + shop_cipher (product APIs; from Get Authorized Shops = /authorization/202309/shops → shops[]{id,region,seller_type,cipher}).
- Products read scope = seller.product.basic ("Product Basic"); even Public scopes still require seller authorization → URL-only/unauthorised import NOT possible (verdict documented with 4 evidence points).
- Search Products: POST /product/202309/products/search; page_size REQUIRED 1-100; page_token ← next_page_token; total_count; NO has_more; hard cap 10,000 results (err 12052180) → need incremental time-window sync (create_time_ge/le, update_time_ge/le).
- Get Product: GET /product/202309/products/{product_id}; full schema captured: title, description (HTML), brand{id,name}, category_chains[], main_images[]{urls,thumb_urls,uri,w,h}, video{url,cover_url}, package_dimensions/weight, skus[]{id, seller_sku, price{currency,sale_price,tax_exclusive_price}, inventory[]{warehouse_id,quantity(1-99999)}, sales_attributes[]{name,value_name,sku_img(variant image)}, status_info}, audit block.
- Status enum: DRAFT/PENDING/FAILED/ACTIVATE/SELLER_DEACTIVATED/PLATFORM_DEACTIVATED/FREEZE/DELETED/SCHEDULED.
- Rate limits: dynamic QPS (no fixed numbers); isolation unit App ID × Authorized Shop; signals HTTP 429 + business code 36009002; planning baselines per app-shop: reads 3-10 (light 5-20) rps, writes 1-3, heavy 0.2-1; backoff+jitter, honour Retry-After.
- Markets: 16 regions incl. MY (locale ms-MY, currency MYR, COD flag) on the single global API host.
- Webhooks: PRODUCT_CREATION / PRODUCT_INFORMATION_CHANGE / PRODUCT_STATUS_CHANGE / PRODUCT_CATEGORY_CHANGE / PRODUCT_AUDIT_STATUS_CHANGE; signature = HMAC-SHA256(app_key+raw_body, app_secret) in Authorization header (no Bearer); docs mandate polling backup.
- App registration: Partner Center → App & Service; credentials App Key / App Secret / Service ID; Custom apps skip review UNLESS Connector category or ≥25 seller authorizations (our connector case → review expected); env vars proposed: TIKTOK_SHOP_APP_KEY/APP_SECRET/REDIRECT_URI/WEBHOOK_URL.
- Error codes verified: 105005 scope denied, 105002 token expired, 106001 bad sign, 36009004 family (timestamp/sign/key/shop_cipher), 106013 missing shop_cipher, 36004004 bad auth_code, 36009033 IP allowlist.

---
Task ID: p2-shopee
Agent: shopee-doc-researcher
Task: Phase 2 Shopee Open Platform official docs research

Work Log:
- Method: docs are JS SPAs — curl/page_reader useless; used agent-browser CLI (--session shopee): open URL → sleep 6-8s → document.body.innerText in 15k chunks; nav items are click-handler divs (no anchors), so real page URLs discovered by clicking + reading window.location.href.
- API reference pages fetched (/documents/v2/v2.<api>?module=X&type=1): ams.get_open_campaign_added_product (127, incl. collapsed "Common Request Parameters"), product.get_item_list / get_item_base_info / get_item_extra_info / get_model_list / get_category (module 89), shop.get_shop_info / get_profile (92), public.get_access_token / refresh_access_token / get_shops_by_partner (104) — each incl. request/response tables, error codes, API Permissions (app types).
- Developer guides fetched (/developer-guide/<id>): 12 (dev account registration: account types + per-market seller eligibility incl. MY), 14 (App management: Test/Live Partner ID+Key, Go Live ~24h, app statuses, ≤10 apps), 16 (API calls: hosts + EXACT signing algorithm with worked base-string example + demo code), 20 (Authorization & Authentication: auth link spec, redirect params, token lifecycle rules, GetAccessToken/RefreshAccessToken paths + Python/Java/PHP demos), 27 (API call flow diagrams — images only), 702 (Shopee AMS guide: Open Campaign definition verbatim).
- FAQ crawled (/faq): Debugging category (2054) → HTTP 429/QPS guidance, "Wrong sign" checklist, full error_auth table, IP whitelist ≤1000; Integration Flow (2049) → push-mechanism rules only.
- Blocked/inaccessible: Console (login-walled — app key values, Go-Live forms), "Shopee Markets" footer page (no crawlable content), numeric QPS limits (not published anywhere crawled).
- Deliverable written: docs/research-shopee.md (9 sections, endpoint matrix, field mapping, verified-vs-assumption lists).

Stage Summary:
- Signing [VERIFIED]: base string = partner_id + api_path + timestamp + access_token + shop_id (Shop API; Public API drops the last two; Merchant swaps merchant_id); sign = HMAC-SHA256(base_string, partner_key) hex; timestamp ±5 min; request params NOT signed.
- Token lifecycle [VERIFIED]: auth link https://open.shopee.com/auth?partner_id=&auth_type=seller&redirect_uri=&response_type=code → redirect ?code&shop_id (code one-time, 10 min) → POST /api/v2/auth/token/get → access_token (4h) + refresh_token (30d, single-use, ROTATES on every refresh; old access_token lives 5 more min) → POST /api/v2/auth/access_token/get; authorisation validity seller-chosen ≤365 days.
- Catalogue chain [VERIFIED]: product.get_item_list (offset/page_size≤100/item_status required; has_next_page+next_offset) → product.get_item_base_info (≤50 ids; item_name, description, price_info, image.image_url_list, stock_info_v2, condition, item_status, has_model, category_id) → product.get_model_list (tier_variation[] options+option images; model[] model_id/price_info/stock_info_v2/model_sku/model_status/tier_index) → shop.get_shop_info (shop_name/region/status/auth/expire) + shop.get_profile (shop_logo).
- URL-only import verdict: NO — every catalogue API is a Shop API requiring seller authorisation (explicit guide quote); no URL/slug-based public endpoint exists (public.* = token mgmt + get_shops_by_partner only); ISV rules forbid services that extract listings off-platform → connector must be authorisation-code-flow based.
- Spec's campaign endpoint assessed: v2.ams.get_open_campaign_added_product retrieves only products the seller enrolled in the affiliate Open Campaign (commission_rate/campaign_status/periods), is restricted to "Affiliate Marketing Solution Management" app type and gated by AMS T&C acceptance — NOT a catalogue importer; recommend the get_item_list chain instead.
- MY market: supported (eligibility Mall OR Registered Business OR ≥1 order in L12M; category languages en/ms-my/zh-hans; 2-decimal pricing; region field "MY").
- Rate limits: only HTTP 429 + "adjust QPS" guidance published — no numeric table; plan self-throttling + backoff. Hosts: partner.shopeemobile.com (prod), openplatform.sandbox.test-stable.shopee.sg (sandbox).
- Credential mapping: SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY (Test vs Live pair from Console "App Key" section), SHOPEE_SHOP_ID, per-shop tokens in DB not env.

---
Task ID: p1-p6 (orchestrator)
Agent: main (Z.ai Code)
Task: Phases 1-6 of Nexova-style upgrade — inventory, API research, plan, schema migration, connectors, import engine

Work Log:
- Phase 1: docs/codebase-inventory.md — full stack/model/gap analysis
- Phase 2: 2 research agents crawled official docs via headless browser → docs/research-shopee.md + docs/research-tiktok.md + merged docs/marketplace-integration-research.md. Verdict: URL-only import impossible on both platforms (seller OAuth required)
- Phase 3: docs/implementation-plan.md — repo-specific architecture
- Phase 4: additive Prisma migration (MarketplaceConnection, ImportJob, ImportJobItem, StoreClaim, SeoMeta; Store.sellerId nullable + lifecycle statuses; Product source/SEO fields; ProductVariant.sourceModelId/imageUrl; ProductImage.alt). db push OK, data preserved (5 stores/27 products), wallet cache refreshed
- Phase 4 libs: src/lib/store-lifecycle.ts (guarded state machine + canPublish gate), src/lib/secretbox.ts (AES-256-GCM token sealing)
- Phase 5: src/lib/marketplaces/{types,resolver,shopee,tiktok,fixture,index}.ts — official-contract connectors (Shopee V2 signing, TikTok 202309 signing incl. shop_cipher), SSRF-safe URL resolver, clearly-labelled fixture connector
- Phase 6: src/lib/import/{normalise,summary,runner}.ts — inline job engine: phases, persisted progress, idempotent upserts ((storeId,platform,sourceProductId) unique), partial-failure per item, SSRF-guarded image copy, SEO generation, claim issuance, honest awaiting_authorisation
- APIs: /api/import/resolve, /api/import/jobs (POST), /api/import/jobs/[id] (GET ?token), /resume, /claim/validate, /api/store/connections (+/disconnect, /[platform]/begin), /api/auth/callback/[platform], /api/claim/bind, /api/store/publish, /api/store/seo, /api/store/imports, src/app/sitemap.ts, src/lib/seo.ts (JSON-LD + meta)

Stage Summary:
- Self-verification harness: 25/25 PASS (URL patterns, SSRF rejects, full fixture import, unclaimed store, idempotent re-import, claim token lifecycle, shopee-without-creds honesty)
- Live Shopee/TikTok import requires app credentials (env) + seller authorisation — implemented per official docs, honestly reports needs_credentials/awaiting_authorisation
- Fixtures labelled demo data; never presented as live imports

---
Task ID: p7-p12 (orchestrator)
Agent: main (Z.ai Code)
Task: Phases 7-12 — claim system, SEO pipeline, seller command centre, E2E verification, final audit

Work Log:
- Phase 7: /api/claim/bind — atomic ownership binding (hashed single-use token, concurrent-claim guard, registration-placeholder detach, OAuth shopId match for real platforms)
- Phase 8: verified existing checkout guard (store must be status live) + order/payment/ledger chain reused; E2E order SM-100015 paid, ledger invariants ok, wallet credited net of 8% commission
- Phase 9: src/lib/seo.ts (JSON-LD Product/Breadcrumb + client meta), PDP + storefront SEO injection, /sitemap.xml (live stores + active products), ?sf= deep links, SEO API (/api/store/seo with lock/unlock)
- Phase 10: generate.tsx (1445-line paste-URL → progress → claim UX by p10-a agent), seller imports.tsx (Import Centre: connections + publish gate + job history) + seo.tsx (SEO editor), seller nav + routing wired
- Fixed p10-a agent's apiSend/runMutation signature mismatches; fixed pre-existing runtime crash in storefront chrome (ShopperCtx called as function in SfHeader/SfFooter/ProductGridSection/MarketplaceStrip)
- Converted 7 route handlers from `return handle(...)` to `export const X = handle(...)` pattern
- Phase 11 E2E (agent-browser): demo import → claim (register + bind "Store claimed!") → admin KYC approve → support email → publish gate → live storefront via /?sf=aurora-test → PDP JSON-LD → cart → checkout RM38 → mock pay → order paid + ledger balanced; regression: market home / seller / admin all clean, zero console errors
- Phase 12: docs/handover.md (12-part technical handover + acceptance checklist), README marketplace section, verification harness 25/25 PASS

Stage Summary:
- Complete Nexova-style store generator: paste URL → import → claim → publish → trade, with honest credential gating (awaiting_authorisation until Shopee/TikTok app creds are configured server-side)
- All new code: 0 lint errors, 0 tsc errors; existing features regression-verified
- Deliverables: docs/handover.md, docs/marketplace-integration-research.md, docs/research-{shopee,tiktok}.md, docs/codebase-inventory.md, docs/implementation-plan.md
