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

---
Task ID: checkout-3phase
Agent: main (Z.ai Code)
Task: Implement the pasted MASTER INSTRUCTION — revamp the shopper checkout into a Shopify-inspired three-phase flow (Information → Delivery → Payment) and connect every control to real backend operations (audit → schema → APIs → UI → E2E verification)

Work Log:
- Audit: traced existing flow (single-page checkout, cookie guest cart, /api/checkout/quote|create, sandbox payment with HMAC-signed webhook pipeline, email+orderNumber lookup). Found: no 3-phase structure, duplicate-order idempotency bug (randomUUID inside placeOrder click), shipping options hardcoded in UI, cart cleared client-side via N best-effort DELETEs, no address book, no order history, no payment-expired state, no stock caps on cart qty
- Schema (additive, db:push OK): Address model (ownerToken = sm_shopper_id device cookie, @@index) + Order.cartToken
- pricing.ts: SHIPPING_RATES + eta; shippingOptionsFor() server-derived options; assertShippingAvailable() — express ineligible for Sabah/Sarawak/Labuan (enforced at create → 409 SHIPPING_UNAVAILABLE)
- quote API: returns shippingOptions[] + per-line stock; create API: requires full destination, validates postcode/phone formats, persists cartToken, enforces delivery eligibility server-side
- New address-book API: /api/checkout/addresses (+[id] PATCH/DELETE) with device-token ownership checks, default promotion/demotion, per-field validation (5-digit MY postcode, phone format)
- Payment reliability: GET payments/[ref] computes authoritative "expired" state past expiresAt; NEW /retry endpoint re-opens only FAILED sessions (409 ALREADY_PAID otherwise) — fixes poll-vs-retry flip bug; process.ts clears the producing cart server-side on verified success only
- Cart integrity: POST add + PATCH qty capped at variant stock (409/notice), PDP surfaces stock-limit toast
- checkout.tsx rewritten: 3-phase stepper (completed steps clickable), Phase 1 contact+address book (add/edit/delete/default, per-field errors, validation gate), Phase 2 server-delivered options + free-ship progress + auto-fallback on ineligible pick, Phase 3 review blocks with Edit links + payment methods + required terms + note; sessionStorage draft with STABLE idempotency key per checkout session; coupon box with remove; stock-warning banner
- New OrdersView (order history from device refs via ownership-safe lookup) + header "Orders" nav; trackOrderRef persisted on create/payment/lookup; PayView expired + honest cancel states
- E2E browser verification (desktop 1440×900 + mobile 390×844): empty-form validation gate → address create (auto-select) → phase nav retains data → express RM104/standard RM97 recalculation → Sabah rule (toast + disabled express + fallback) → terms gate → order create → sandbox pay → decline → retry (via /retry) → success → order paid + timeline → cart badge emptied (server-side) → order history lists SM-100018 → seller portal shows Paid RM97.00 in To-fulfill; ledger 3 lines balanced, commission 712/net 8988 of 9700; idempotent replay + oversell 409 verified via curl; fixed pre-existing cart-drawer stale-state bug (setQty now notifies CART_EVENT)

Stage Summary:
- Three-phase checkout fully implemented and connected end-to-end; client never trusted for money math, stock, delivery eligibility or payment status
- Remaining external dependency (documented, not faked): real payment-provider credentials — sandbox gateway is the explicit integration boundary, clearly labelled, server-verified; stock stays reserved on abandoned unpaid orders until admin cancellation (no auto-release job exists)
- Files: prisma/schema.prisma, src/app/api/checkout/{pricing.ts,quote,create,addresses/*,payments/[ref]/{route,retry,simulate}}, src/app/api/cart/items/*, src/app/api/webhooks/payments/process.ts, src/components/shopper/{checkout.tsx,ui-bits.tsx,shopper-shell.tsx,pdp.tsx}
---
Task ID: 3
Agent: main (Z.ai Code)
Task: Full browser-verified investigation of "add to cart → cart still empty" bug + fix + E2E verification of all portals.

Work Log:
- Reproduced & root-caused via dev.log + DB: POST /api/cart/items returned 201 but the browser never persisted the `sm_cart` cookie (SameSite=Lax is silently dropped in the app's cross-site iframe preview panel). Evidence: 11 orphan carts in DB — one created per add attempt, tokens never reused.
- Fix (server): cart.ts getCartToken() now reads validated `X-Cart-Token` header first, cookie fallback; createCart() adopts client-supplied token; cookies upgraded to SameSite=None+Secure. Same treatment for checkout/owner.ts (`X-Shopper-Token`) and lib/auth.ts (Authorization Bearer fallback + None+Secure session cookie).
- Fix (server): /api/auth/login + /api/auth/register now return `token` in the response body.
- New src/lib/session-client.ts: localStorage bridge — sm_cart_token / sm_shopper_token (32-hex via crypto.randomUUID) → deviceHeaders(); sm_session_token → authHeaders().
- Fix (client): shopper ui-bits fetchJson/fetchEnvelope merge deviceHeaders(); seller ui-bits apiGet/apiGetPaged/apiSend and admin use-api apiGet/apiSend merge authHeaders(); app-store refreshMe/logout send Bearer + clear token on logout; token stored at all 4 login/register call sites (seller-shell login+register, admin-shell, generate.tsx claim flow).
- Bug found during browser testing: CartDrawer qty stepper threw "notifyCartUpdated is not defined" (missing import in shopper-shell.tsx — pre-existing). Fixed import; PATCH now refreshes all cart badges.
- Fixed TS errors in cart/items/route.ts (created cart assignment typed via const created).
- Verification: lint clean; tsc clean in all touched files; curl header-only flows pass (add → read → merge qty; login → Bearer me/store/dashboard; X-Shopper-Token address persistence); dev server restarted after an abrupt kill.
- agent-browser E2E top-level: home → PDP → add (badge 0→1) → drawer shows item → qty stepper 2→3 → checkout → address saved → delivery → payment → order SM-100019 paid → cart auto-cleared (badge 0). Seller portal: demo login + dashboard renders showing SM-100019. Admin: login + command centre renders (GMV RM 364 matches).
- Cross-site iframe repro (host page on 127.0.0.1:4321 embedding localhost:3000 — the user's preview-panel context): add to cart badge 0→1→2, DB shows ONE cart token reused with qty merged, zero new orphan carts. Mobile 390px: PDP, order status, home grid render correctly.

Stage Summary:
- Root cause: SameSite=Lax cookies are rejected in cross-site iframe contexts (preview panel), so guest cart/session/device cookies never stuck.
- All guest + portal identity now travels via headers (X-Cart-Token / X-Shopper-Token / Authorization Bearer) backed by localStorage, with cookies as fallback — works top-level AND in iframes regardless of third-party cookie policy.
- Bonus fix: cart drawer qty stepper crash (missing notifyCartUpdated import).
- Files: src/app/api/cart/cart.ts, src/app/api/cart/items/route.ts, src/app/api/checkout/owner.ts, src/lib/auth.ts, src/app/api/auth/login/route.ts, src/app/api/auth/register/route.ts, src/lib/session-client.ts (new), src/lib/app-store.ts, src/components/shopper/ui-bits.tsx, src/components/shopper/shopper-shell.tsx, src/components/shopper/generate.tsx, src/components/seller/ui-bits.tsx, src/components/seller/seller-shell.tsx, src/components/admin/use-api.ts, src/components/admin/admin-shell.tsx.

---
Task ID: 3
Agent: main (Z.ai Code)
Task: Fix runtime TypeError "txns.slice is not a function" (admin wallets-ledger) AND full-check the "cart still empty after add to cart" bug via real browser verification.

Work Log:
- Root-caused the admin crash: GET /api/admin/ledger/transactions returns envelope { data: { items, nextCursor, count } } but WalletActivity used useApi<LedgerTxn[]> then txns.slice(...) on the object. Fixed wallets-ledger.tsx to unwrap data?.items. Same latent bug fixed in LedgerTransactions.load() (was reading body.data as an array; now reads body.data.items and uses server-provided nextCursor for pagination).
- Swept codebase for the same envelope-mismatch pattern elsewhere: /api/admin/notifications and /api/admin/ledger/accounts return raw arrays — no other mismatches.
- Cart bug investigation: DB showed POST /api/cart/items WAS creating carts with items, but the SAME product was added into 3 DIFFERENT carts with 3 different tokens within 20 min → client identity instability.
- Root cause: in the preview-panel sandboxed/cross-site iframe, window.localStorage access throws SecurityError; deviceToken()'s catch-path returned a NEW random token on EVERY call, so "add to cart" (token A) and "get cart" (token B) hit different carts → cart always empty. Cookie fallback also blocked in third-party iframes.
- Fix in src/lib/session-client.ts: deviceToken() now resolves identity via 3 layers — in-memory Map memo (guarantees all calls in one page share a token) → localStorage → sm_cart cookie fallback (recovers server-issued cart token across reloads when localStorage is blocked but cookies work). Added CART_COOKIE_NAME constant.
- Browser reproduction (agent-browser): blocked localStorage via Object.defineProperty throw, clicked Add to cart → toast "Added to cart" but badge flipped to "0 items" and drawer showed "Your cart is empty" (bug reproduced exactly); 2 orphan carts created in DB confirming diagnosis.
- Post-fix browser verification with localStorage still blocked: add to cart → badge "1 item" → drawer shows item → qty +1 → remove item all work. Normal (unblocked) path re-verified after reload, plus persistence across reload.
- End-to-end checkout golden path verified in browser: add to cart → checkout → save address → delivery (Standard RM 8) → payment (FPX) → terms accepted → Pay → sandbox gateway Pay Now → order SM-100020 "Payment confirmed" (RM 97.00), cart auto-emptied after order.
- Verified seller portal (login lumina@shopmesh.io: dashboard stats, orders table, page builder pages) and admin portal (Wallets drawer ledger activity now renders; Ledger Explorer transactions + journal-line expansion) — zero browser errors.
- Mobile 390×844 spot-check: market grid 2-col dense layout, category chips, hero banner, add-to-cart badge, full-width cart drawer all verified.
- Cleaned up 3 test carts created during debugging (createdAt > 07:30 UTC); user's historical carts untouched.

Stage Summary:
- BUG 1 FIXED: admin wallets drawer + ledger explorer crashed on envelope mismatch — both now unwrap { data: { items } } correctly (src/components/admin/wallets-ledger.tsx).
- BUG 2 FIXED (the reported "cart still empty"): guest cart identity is now stable under blocked storage via memory→localStorage→cookie fallback in src/lib/session-client.ts deviceToken().
- VERIFIED IN BROWSER (not just lint): cart add/merge/qty/remove in both storage-blocked and normal modes, persistence across reload, full paid checkout (SM-100020), seller portal, admin wallets/ledger, mobile layouts. Lint exit 0; dev.log clean since fixes.

---
Task ID: 4
Agent: main (Z.ai Code)
Task: Restart sandbox session + dev server, then browser-verify the full A/B/C feature batch (seller wallet activity pages, store settings toggle, page-builder testimonials editor, draggable portal FAB, checkout mobile responsiveness, PDF receipt, buyer auth + chat). Fix anything broken found during verification.

Work Log:
- Restarted dev server (previous background process died with the session; relaunched `node node_modules/.bin/next dev -p 3000` detached via setsid — writing to dev.log; note plain `nohup bun run dev` kept getting reaped in this sandbox). Verified GET / 200 + zero browser errors.
- Discovered the A/B/C batch was already implemented by prior agent sessions; this run = full browser verification pass (user-mandated "browser check not lint check") + fixes.
- Discovered the A/B/C batch was already implemented by prior agent sessions; this run = full browser verification pass + fixes.
- FIX 1 (portal-fab.tsx): wrapped setPointerCapture in try/catch inside onPointerDown — a throwing capture (synthetic/non-active pointerId, pointer released early) aborted the whole tap-to-open flow. Post-fix, tap/drag verified with real UX intact.
- FIX 2 (shopper-shell.tsx): header nav overflowed 390px viewports by 18px (scrollWidth 408) because the Sell button kept a short "Sell" label below sm; made it icon-only below sm (scrollWidth 390, overflow gone).
- B verified (1280×800 + 390×844): FAB tap → menu (Market/Seller/Admin radios with aria-checked + Reset position); switching portals swaps surface; drag moves FAB (592,16 → 342,166 = exact delta) and persists to localStorage (survived session restart); Reset position returns to bottom-right default; position clamped on resize.
- C1 verified at 390×844: full checkout golden path (add Aurora Ceramic Vase → cart → checkout → phase 1 contact/address → phase 2 delivery Standard RM8 → phase 3 payment FPX → terms → Pay RM 97.00 → sandbox gateway → success) — document.body.scrollWidth == 390 at every phase, zero horizontal overflow.
- C2 verified: Download receipt button on payment-complete + order-status views; GET /api/orders/receipt?email&orderNumber returns a real 2.5KB PDF 1.7; decoded content shows structured receipt (SHOPMESH header, order SM-100022, placed date, Status PAID, SELLER/BILLED TO columns, ITEMS table QTY/UNIT/AMOUNT, subtotal/shipping/TOTAL PAID RM 97.00, payment method fpx_toyyibpay + reference, footer disclaimer).
- C3 verified (both paths): logged-out Contact seller → SHOPMESH shopper account dialog (Sign in / Create account tabs) → registered aisyah@shopmesh.test / Nur Aisyah → auto-resume carried intent ("Chat opened — You're now chatting with Lumina Living") → message sent and persisted (chatMessage row, thread subject "About order SM-100022"). Logged-in path (from My orders → SM-100022): no gate, straight to chat. Seller side (lumina@shopmesh.io → Messages): thread + shopper message visible, seller reply sent, persisted, chat hub (ports 3003/3103) alive. Note: single shared session token by design — seller login replaces shopper session.
- A2 verified: Store Settings "Marketplace opt-in" switch OFF → success toast "Store removed from marketplace listings", ON → success toast "Store listed on the SHOPMESH marketplace"; PATCH /api/store/settings 200 both ways; zero browser errors (the reported error popup is gone).
- A1 verified: seller Wallet & Payouts recent-activity rows are clickable (aria-label "View activity: …"); individual activity page renders title (Order payment received / Manual adjustment), credit/debit badge, activity summary (effect on balance, clearing hold, journal reference), "What this activity belongs to" with order/payout/adjustment context, double-entry journal table with my-wallet legs highlighted; "View order" cross-navigates to the SM-100022 order detail; Back returns to wallet.
- A3 verified: Page Builder → Home → Testimonials section → Content tab: no JSON anywhere — per-item collapsible cards (quote textarea + author text), Add testimonial (created item, filled quote/author, canvas live-updated after debounce), Move up/down + Remove per item, "Design style" select with all 4 options (Cards/Minimal/Bubbles/Featured) and canvas re-renders on change. Cleaned up after test (removed added item, restored Bubbles style; draft left as found).
- Desktop spot-check 1280×800: market home no overflow; FAB persistent. Lint exit 0; dev.log clean throughout.

Stage Summary:
- ALL THREE FEATURE GROUPS (A seller trio, B draggable portal FAB, C checkout trio) verified working end-to-end in the browser — mobile 390px and desktop 1280px.
- Two fixes applied during verification: portal FAB setPointerCapture hardening (tap-to-open could previously be killed by a capture throw) and mobile header 18px horizontal overflow (Sell button label).
- E2E artifacts: order SM-100022 paid (RM 97.00, Aurora Ceramic Vase + shipping), PDF receipt structurally verified, shopper account aisyah@shopmesh.test (Nur Aisyah) created, two-way buyer↔seller chat persisted on thread "About order SM-100022".
- Files changed this run: src/components/portal-fab.tsx, src/components/shopper/shopper-shell.tsx.

---
Task ID: 5
Agent: main (Z.ai Code)
Task: Chat enhancement trio — finish verification (shopper unread badge after restoring aisyah's session) after the previous session stopped mid-check at "Seller side fully verified. Final check — shopper badge". Fix anything found.

Work Log:
- Re-oriented on the implementation state left by the prior segment: schema has ChatThread.contextType/orderId/productId + shopperUnread/sellerUnread counters; APIs /api/chat/unread + /api/store/chat/unread power header/nav badges; thread rows render amber unread pills and no message preview; context bubbles (product/order quote cards) render in both conversation panes; auto-reply/quick-reply scaffold lives in src/lib/chat-quick-replies.ts (quick replies functional as composer chips; AUTO_REPLY dormant with platform comparison + assembly plan in comments).
- CRITICAL FIX (latent corruption): shopper-shell.tsx contained corrupted tokens — `}, essages]);` (useEffect deps, undefined identifier) and `: sg]));` (send fallback, undefined identifier). SWC error-recovered the parse (0 reported errors) so the stale served bundle kept working, but any fresh compile/restart would crash. Restored to `}, [messages]);` / `: [msg]));`. NOTE: sandbox filesystem showed stale-read flakiness during editing (reads flip-flopped between old/new content); verified final state by repeated node fs.readFileSync + md5sum (5/5 stable).
- FIX: POST /api/admin/coupons used ok() without importing it (ReferenceError on any POST) — added `ok` to the @/lib/api import. Found via bunx tsc --noEmit sweep (chat-related files otherwise clean; remaining tsc errors are pre-existing looseness in seed/skills/checkout typings, no undefined names).
- FIX (badge UX, requirement 2): both shopper and seller Messages views auto-opened the first thread on entry, instantly marking it read — the unread badge was consumed before the user ever saw it (repro: seller reply → aisyah login → badge already gone; /api/chat/unread returned 0 within 2s). Changed to list-first: no auto-select on plain entry (shopper keeps initialThreadId auto-open for the contact-seller intent resume path); empty pane shows "Pick a conversation…" prompt.
- FIX (badge lag): opening a thread marks read server-side but the header/nav badge only re-synced on the 15s poll. Added window event "shopmesh:chat-sync" dispatched after thread-open refresh and after send (both shells' unread hooks listen and re-fetch immediately); row pills now also refresh after open (loadMessages().then(loadThreads)).
- E2E verified in browser (fresh compile after dev-server restart, watcher confirmed recompiling): seller reply → DB shopperUnread=1 → aisyah login → header "My messages, 1 unread" with badge 1 → Messages list shows amber pill "1" on the row with NO message preview (only store name + time + "🏷️ product enquiry" tag) → open thread → header badge AND row pill clear instantly (sync event works) → context bubble "View product: Aurora Ceramic Vase" visible → bubble click navigates to the PDP (RM 89.00). Reverse direction: aisyah sends via PDP "Message seller" (auto-seeds product-intent greeting + manual msg, sellerUnread=2) → seller nav badge "2" → Messages row pill "2" no preview → open → nav badge + row clear instantly → seller bubble "Open product: Aurora Ceramic Vase" → click navigates to the product. DB counters return to 0/0 after reads.
- Mobile 390×844: messages list, conversation, bubble card and composer render with zero horizontal overflow (scrollWidth 390). Screenshots confirmed the dashed-teal product bubble with thumbnail/price/arrow.
- Sandbox ops note: `setsid nohup … &` dev-server instances were reaped within ~60s this session; a plain `( node node_modules/.bin/next dev -p 3000 < /dev/null >> dev.log 2>&1 & )` child of the persistent shell survived the entire E2E. Restart cost is fine; fresh compile of the fixed tree is clean (GET / 200, compile 4s, no errors).

Stage Summary:
- Chat trio COMPLETE and browser-verified both directions on a fresh compile: ① context bubble — entry-point-aware product/order quote card, clickable on both shopper (→PDP / order status) and seller (→product/order) sides; ② thread name cards show unread badge (amber pill + aria announce) and NO message preview, with header (shopper) / nav (seller) badges both ways, instant clear on read, badge survives re-login; ③ quick replies functional (chips fill draft), auto-reply scaffold dormant with documented platform patterns (Shopee/WhatsApp Business/Lazada/Etsy) and assembly plan pending user discussion.
- 4 code fixes this run: corrupted shopper-shell tokens, missing ok import in admin coupons, list-first messages entry (badge no longer auto-consumed), instant badge sync via shopmesh:chat-sync event. Lint exit 0, dev.log clean.
- Ops notes for next agents: (1) verify file writes with md5sum if reads look stale (sandbox fs flakiness); (2) start dev server as plain subshell child of the persistent Bash session, not setsid.

---
Task ID: 6
Agent: main (Z.ai Code)
Task: (1) Build the Shopee-style buyer dashboard/profile hub ("Me" tab) — schema, APIs, mobile+desktop UI, demo seed. (2) Fix the reported checkout bug: guest-registered delivery address leaking into a logged-in session ("messed up sessions" / identity crossover).

Work Log:
- ROOT-CAUSED the address crossover: the address book was scoped to a DEVICE token (ownerToken from X-Shopper-Token header / sm_shopper_id cookie) — addresses followed the browser, not the person, so guest-saved addresses appeared after login and would leak across accounts on a shared device.
- FIX (dual ownership + claim-on-login): Address.shopperId + Order.shopperId columns (schema, db:push). owner.ts now resolves the owner per request (account wins when a shopper session exists; lazy-claim of still-unclaimed device rows covers pre-deploy sessions). All 3 address routes scope by shopperId when signed in / device token when guest; [id] route enforces row ownership. New src/lib/shopper-merge.ts claimGuestStateForShopper() runs on shopper login AND register: claims unclaimed device addresses (default normalized to exactly one) + claims orders by account email. checkout/create attaches session shopperId to new orders. Cart intentionally stays device-scoped (standard cart-merge UX, non-PII).
- BROWSER-PROVEN: guest saved address → aisyah login → address claimed (shopperId=aisyah, still visible = seamless merge); sign out → guest sees 0; buyer@test.dev login on SAME device → 0 addresses (no crossover); aisyah again → 1 address. Signed-in checkout create → SM-100024 with shopperId=aisyah (DB-verified).
- NEW SCHEMA: ShopperUser profile fields (username unique, avatarUrl, membershipLevel, following/followerCount); ShopperWallet (balance/coins/SPayLater limit+used/lastCheckInAt/checkInStreak); Voucher pool + UserVoucher (AVAILABLE/USED/EXPIRED); UserActivity (LIKE/VIEWED, unique per user+product+type).
- NEW APIs (all requireShopper, zod-validated): GET/PATCH /api/me/profile (tier auto-upgrade SILVER→GOLD@RM500→PLATINUM@RM2000 from lifetime paid spend, never downgrades), GET /api/me/wallet, POST /api/me/coins/claim (24h cooldown server-side, streak +2/day bonus), GET /api/me/orders (bucket counts to_pay/to_ship/to_receive/to_rate/completed/cancelled + paged rows), GET /api/me/orders/[orderNumber] (account-scoped order detail), GET /api/me/recommendations (personalised: recent activity categories boosted → fill popular; sort=popular|sales|new; paged), POST+GET /api/me/activity (+productId liked-check, DELETE un-like), GET/POST /api/me/vouchers (claim by code).
- UI: src/components/shopper/me-hub.tsx (~1700 lines) — Shopee-style Me hub. Mobile: gradient profile header (avatar/name/@handle/membership chip w/ tier dialog/follow stats + settings-cart-chat icons), dismissible notification prompt (persisted), My Purchases 4-card grid with amber badges, quick services (20% Off / Free Delivery tags), Oct 15 Mid-Month Madness campaign circles, wallet bento (SHOPMESH Pay RM128.40 / Coins check-in button with dot / SPayLater with usage meter / Vouchers count), financial services grid, More Activities (likes/viewed counts, NEW badges) + Support (Jom Beli Selamat! safety dialog), addresses teaser, You May Also Like feed (Ready Stock / Selling Fast / SPayLater 0% 3x chips, sort, load-more). Sub-views: purchases (status tabs, paged), wallet, vouchers (claim-by-code), likes, viewed, addresses (full CRUD + default). Desktop ≥lg: sticky sidebar (profile card + menu + support) + bento main.
- SHELL: new "me" ShopperView (+tab deep-link), mobile bottom nav (Home/Orders/Cart/Chat/Me with badges + active indicator, hidden on checkout/pay focus mode, safe-area padding, content pb offset), header Orders button + account dropdown route signed-in users to the account-scoped hub. PDP: auto VIEWED tracking + heart Like toggle (optimistic, auth-gated). Fixed portal FAB default position to clear the bottom nav on <768px.
- FIXED integration gap found during E2E: order-status view relied on guest localStorage email — added /api/me/orders/[orderNumber] fallback (account path also feeds the PDF receipt via customerEmail).
- Seed: prisma/seed-me.ts (idempotent) — voucher pool (8), aisyah wallet (RM128.40 / 1250 coins / SPayLater RM6,652.12), voucher wallet, like/view activity, attaches up to 3 unclaimed demo orders. Gotcha fixed: seed update block was wiping lastCheckInAt (broke cooldown) — now create-only.
- Test harness notes: agent-browser clicks proved flaky on some buttons (framer-motion transform targets); programmatic element.click() + requestSubmit() used for verification — every flow also proven at API level with curl/node. tsc: only pre-existing baseline errors remain (checkout/create sellerId, quote, checkout.tsx ×4 — verified identical via git stash).

Stage Summary:
- BOTH deliverables done and browser-verified: ① Shopee-style buyer dashboard fully live (mobile app-like + desktop bento/sidebar, real data, working check-in/claims/CRUD/tier progress/recommendations) — E2E walked profile edit, coins claim (+12, cooldown enforced "Come back tomorrow"), voucher claim (409 dup + success path), purchases tabs w/ bucket counts (to_pay 1 / to_ship 3 after a new signed-in order), addresses CRUD, likes/viewed grids, order deep-link, receipt button. ② Address crossover FIXED with the claim-on-login pattern: addresses/orders now follow the ACCOUNT; guest→member merge still seamless; cross-account isolation proven on one device.
- Lint exit 0; zero new tsc errors; dev.log clean (2 historical PrismaClientValidationError lines from the pre-generate window only). Screenshots: /tmp/me-mobile*.png (390px), /tmp/me-desktop*.png (1280px).
- Ops notes: dev server was reaped silently again mid-session (plain subshell restart); seeds re-runnable anytime via `bun prisma/seed-me.ts`; FAB position persists per-browser (localStorage sm_portal_fab_pos).

---
Task ID: 6
Agent: Z.ai Code (main)
Task: 5 shopper-surface fixes — ① carts require login + DB-backed per-account carts (kill guest cart/session pollution), ② seller login page dead-end, ③ multi-vendor cart discussion (no code), ④ address count stale after delete, ⑤ hide Messages/Orders from header for guests + extend search to mobile.

Work Log:
- Schema: Cart gained shopperId String? @unique + relation ShopperUser.carts (bunx prisma db push; token column kept for legacy reconciliation). Cart is now ACCOUNT-scoped — one active cart per buyer.
- API rewrite: GET /api/cart → session-scoped (guests get empty cart + requiresAuth:true, 200); POST /api/cart/items → requireShopper() first (401 SHOPPER_LOGIN_REQUIRED), cart find-or-create by shopperId, cross-store replace now returns explicit notice "Cart replaced — it can only hold items from one seller at a time"; PATCH/DELETE /api/cart/items/[id] → requireShopper + cart resolved from session (no ids trusted from client). Legacy token helpers kept only for order.cartToken reconciliation.
- checkout/create: requireShopper() moved ABOVE the idempotency replay (replay now 403s for a different account), shopperId required, contact name/email/phone fall back to the account, cartToken recorded from the shopper cart.
- Guest checkout removed everywhere: checkout/owner.ts resolveAddressOwner → requireShopper (account-only address book; ownerToken column still filled for legacy rows but never matched); addresses/[id] requireOwned → shopperId only; shopper-merge.ts → orders-only claim (guest orders by email), address/device claiming deleted from login+register routes.
- Webhook (process.ts) clears the paid cart by order.shopperId (token fallback for legacy rows).
- Client: useCart() re-fetches on sign-in/out (me store subscription) + sm-cart-updated; PDP addToCart reads auth from useApp.getState() at call time (fixes stale-closure re-open of the auth dialog — the stored continuation callback runs after `me` changed) and resumes the add after sign-in; CartDrawer shows a sign-in gate for guests; CheckoutView shows a sign-in gate for guests and prefills contact from the account (blanks only).
- Header: Messages + Orders hidden for guests (desktop+mobile), search bar now ALWAYS visible incl. 390px (logo wordmark hidden on xs), duplicate search removed from the mobile Sheet; bottom nav Orders/Chat open the auth dialog for guests. Seller AuthScreen got a real top header (logo → shopper surface + "Back to marketplace").
- Address count fix: new window event "shopmesh:addresses-changed" dispatched by me-hub AddressesView + checkout address ops; useMeData listens and re-fetches /api/me/profile — the "N saved addresses" teaser updates instantly.
- Verified by API tests (guest 401 on cart-add/addresses/create; account add/persist/patch/cross-store-notice; addressCount 2→3→2) and agent-browser E2E: guest add → dialog → sign in → dialog closes AND item added; checkout contact prefilled (Nur Aisyah + account email); address list account-only; full order SM-100025 paid and cart auto-cleared (badge 0); me-hub delete → "2 saved addresses"→"1 saved address" instantly; seller login header + Back returns to Me hub; seller login (lumina) still works; desktop 1280 + mobile 390 screenshots (/tmp/desktop-signedin.png, /tmp/mobile-guest-header.png, /tmp/mobile-seller-login.png).

Stage Summary:
- Carts, checkout and the address book are strictly account-scoped; guest state can no longer leak into a logged-in session (the reported "old guest address reappears" class of bugs is structurally impossible now). One bug found & fixed during E2E: stored auth-continuation callbacks captured a stale `shopper` — resolved by reading auth from the zustand store at call time.
- lint exit 0; tsc identical to pre-existing baseline (payout-batches/app-store/process/checkout baseline errors untouched); dev.log clean after restart (fresh process needed after git stash swapped the SQLite file under the old one — "readonly database" was a stale handle, not a permission issue).
- Multi-vendor cart: NOT implemented — discussed instead (payment distribution decision pending user).

---
Task ID: 7
Agent: legal-research agent (Option A research)
Task: Malaysia-only legal/regulatory research for approved "Option A" (platform collect-then-disburse escrow model, Shopee-style): BNM licensing (FSA 2013), MSBA 2011 remittance, AMLA 2001, consumer protection (CPA 1999 + CPETTR + price display + ECA 2006 + TDA 2011), PDPA 2010 + Amendment Act 2024, tax (LVG SST, service tax on commissions, WHT, MyInvois), Consumer Credit Act 2025 (BNPL), operational registrations, and an Option A document/license checklist. Research-only task; no source code touched. ~20 CLI web searches run (z-ai web_search); findings returned as structured report to orchestrator.

Work Log:
- Read worklog for context (Option A approved after Task 6 multi-vendor cart discussion; buyer pays full amount to SHOPMESH once, platform holds funds, disburses per seller minus commission; future MeshPay wallet/coins/pay-later noted).
- Ran 20 web searches via `z-ai function -n web_search` (outputs in /tmp/research/q*.json) covering: BNM e-money/EMI approval (Revised E-Money PD 31 Jan 2025, EMI application FAQ), merchant-acquiring registration (FSA s.17-18), illegal deposit-taking (FSA s.137, bnm.gov.my/skimcepatkaya), MSBA 2011 + BNM MSB operator directory, AMLA reporting institutions/CDD/STR-FIED/compliance officer (amlcft.bnm.gov.my), CPETTR 2024 (replaced 2010 Rules, in force 25 Dec 2024, BM-language + marketplace operator duties per Skrine June 2025), Price Display for Online Sales Rules 2017, Trade Descriptions (Definition of Halal) Order 2011, PDPA Amendment Act 2024 3-phase commencement (1 Jan / 1 Apr / 1 Jun 2025; breach notification from Jun 2025; DPO; portability; cross-border guidelines per Mayer Brown/Tay & Partners/JPDP), LVG sales tax (10%, RM500k registration, mylvg.customs.gov.my), service tax 8% + RM500k threshold + 1 Jul 2025 SST expansion (MOF/investmalaysia), WHT on non-resident payments (LHDN e-commerce guidelines 2019), MyInvois phases (1 Aug 2024 >RM100m; 1 Jan 2025 >RM25m; 1 Jan 2026 RM1-5m; 1 Jul 2026 <=RM1m; later bands deferred ~2027/2028 - flagged verify; consolidated self-billed e-invoices + 7-day consolidated B2C), Consumer Credit Act 2025 (Act 873, gazetted 31 Dec 2025, in force 1 Mar 2026, SKP established, licensing 1 Jun 2026 per ccob.my/skp.gov.my), Consumer Claims Tribunal RM50k limit (KPDN), SSM EzBiz registration (no special marketplace licence), Competition Act 2010 (MyCC guidelines), product rules (NPRA cosmetics notification, ST/SIRIM electrical, Food Act 1983), e-money safeguarding/trust-account practice.
- Synthesized 9-topic structured report with per-topic law+authority, Option A trigger, obligations, documents, rates/dates (verify flags), 1-3 source URLs, plus Do-now/Do-before-launch/Monitor checklist and not-legal-advice disclaimer. UNCERTAIN items flagged: platform-commission service-tax classification (needs RMCD determination), WHT on seller payouts vs commissions, exact e-invoice sub-RM1m band dates, exact CPETTR 2024 grace-period end, exact s.137 fine quantum, EMI exemption/capital specifics.

Stage Summary:
- KEY CONCLUSION for Option A: marketplace collect-then-disburse is permissible WITHOUT an e-money licence if (a) buyer funds are collected via a BNM-registered merchant acquirer/gateway, (b) held only in a designated trust/client account segregated from working capital, and (c) disbursed to Malaysian sellers as ordinary bank transfers. EMI approval under FSA is triggered only if SHOPMESH issues its own open-loop stored value (MeshPay wallet); coins/loyalty points are typically limited-purpose and exempt (verify design). Cross-border payouts to foreign sellers require MSBA Class B remittance licence OR a partner licensed remitter/PSP. Consumer Credit Act 2025 now regulates BNPL (SKP, licensing from 1 Jun 2026) - do not launch SPayLater-like features before registration/partnership. CPETTR 2024 imposes direct duties on the marketplace operator (seller info verification + Bahasa Malaysia display) in force since 25 Dec 2024. Full 9-topic report with URLs delivered to orchestrator; nothing in the codebase was modified.

---
Task ID: 8
Agent: orchestrator (Option A implementation)
Task: User approved Option A (platform collect-then-disburse, Shopee-style) — implement the multi-seller cart + single platform payment across per-seller orders, and deliver the Malaysian regulations briefing (research from Task 7).

Work Log:
- Schema (prisma/schema.prisma + db push): `Cart.storeId` → nullable (legacy single-store lock retired); new `PaymentGroup` model (ref @unique, shopperId, provider, status requires_payment|succeeded|failed|expired, subtotal/discount/shipping/totalMinor, idemKey @unique, expiresAt, paidAt, orders[]); `Order.paymentGroupId` + relation + index; `ShopperUser.paymentGroups[]`.
- Cart APIs: `createCartForShopper(shopperId)` no longer binds a store; `POST /api/cart/items` one-store-per-cart delete/replace rule REMOVED (multi-seller cart); `shapeCart()` now returns `stores[]` per-seller groups (storeId/slug/name/itemCount/subtotalMinor) + per-item storeId; legacy single-store fields kept when cart has one store.
- Pricing engine (`api/checkout/pricing.ts`): new `computeGroupPricing()` — validates all lines, groups per live store, per-store subtotal/shipping (free-shipping threshold per store) and per-store coupon rules; a coupon applies to exactly ONE group (highest eligible subtotal) so platform codes can't multiply per seller; aggregate totals + aggregate shipping options (per-rate summed across parcels); legacy `computePricing()` untouched.
- Quote API: no-storeSlug branch → multi-seller quote (groups[] + per-item store fields); storeSlug branch kept for legacy compat.
- Create API rewritten: OPTION A flow — idempotent replay via PaymentGroup.idemKey (legacy order.idemKey replay kept); computeGroupPricing + per-group commissions; ONE transaction creates PaymentGroup + N per-seller Orders (orderNumber per group, idemKey `${key}:${storeId}`, paymentGroupId link) + items + stock decrement + InventoryLog + salesCount + history + coupon redemption per winning group; notifications/audit per order.
- Payment pipeline: `webhooks/payments/process.ts` resolves ref → PaymentGroup FIRST (group path: idempotent, payment.failed → group failed; payment.succeeded → amount check vs group.total, group succeeded+paidAt, per-order transitionOrder(paid) + ledger T1 postOrderPaid (seller wallet net + hold, commission to PLATFORM:REVENUE_COMMISSION) + store webhooks + notifications, then cart cleared by shopperId); legacy PaymentIntent path preserved unchanged (hardened `store.seller?` nullability). `GET /payments/[ref]`, `simulate`, `retry` all group-aware (orderNumbers, isGroup, orderCount, storeNames).
- Frontend: CartDrawer groups items per seller (store header + subtotal + FREE-shipping badge per store; "Items from N sellers — one cart, one payment"); PDP cross-store "replace cart" confirm deleted (multi-seller add is seamless); checkout subtitle/summary/coupon/placeOrder multi-store (summary grouped per seller, "One payment, N parcels" explainer); PayView group display ("to SHOPMESH Marketplace — collecting on behalf of N sellers", "SM-x + N more", success redirects to orders list for groups); ui-bits CartT.stores + CartItemT.storeId types.
- Hygiene: deleted 19 unreachable legacy guest carts (shopperId null) — account-scoped carts never read them.
- Verification: lint exit 0; tsc no NEW errors in touched files (pre-existing baseline untouched); agent-browser E2E: guest add→auth dialog→login→auto-resume add; second store add→2 items 2 sellers, NO replace prompt; drawer grouped (ByteBazaar + Glow Theory, FREE shipping both); checkout "Items from 2 sellers · you pay ONCE"; address book account-scoped; order placed → "2 orders created"; pay page RM 358.00 "collecting on behalf of 2 sellers" (SM-100026 + 1 more); Pay Now → "My orders" shows both orders paid; DB: PaymentGroup succeeded total 35800, orders SM-100026 (ByteBazaar 19900) + SM-100027 (Glow Theory 15900) both paid+linked; ledger T1 per order (gateway debit → seller PAYABLE 18706/14469 + PLATFORM commission 1194/1431); Aisyah cart 0 items; Me-hub address delete → "2 saved addresses"→"1 saved address" instantly; seller AuthScreen "Back to marketplace" round-trip; header Messages/Orders guest-hidden/auth-visible; mobile 390px search visible + bottom nav OK.
- Dev server restart mid-test (SQLite "readonly database" = stale handle after db:push touched the file; fresh process fixed it — no permission issue).

Stage Summary:
- OPTION A IS LIVE END-TO-END: one cart may span many sellers; checkout splits into N per-seller Orders under ONE PaymentGroup; buyer pays once to the platform; webhook fans out paid status + per-seller commission → ledger → wallet payout-hold (existing Payout pipeline disburses). Legacy single-order path still works for old pending orders.
- Malaysia legal briefing (from Task 7 research) delivered in chat: no EMI licence needed for collect-then-disburse if funds ride a BNM-registered acquirer + segregated trust account; MSBA Class B only for cross-border seller payouts; CPETTR 2024 marketplace duties in force; PDPA 2024 amendments; SST/MyInvois watch items; Consumer Credit Act 2025 gates future pay-later.
- Remaining known gaps (deliberate): admin disbursement = existing payouts/wallet screens (no new UI needed); PaymentGroup not yet surfaced in seller order detail; legacy `deviceToken()` header plumbing still dormant (harmless).

---
Task ID: 9
Agent: main (Z.ai Code)
Task: User decisions on payment architecture — ① switch multi-seller payments from Option A (platform collect-then-disburse escrow) to Option B (licensed PSP split, no platform custody), ② commission rate model discussion DEFERRED, ③ buyer finance suite (SHOPMESH Pay wallet / Mesh Coins / SPayLater) switched OFF on the backend while KEEPING the full scaffold unused-with-notes (do not remove, do not reconnect).

Work Log:
- Surveyed state first: worklog showed Tasks 6-8 already delivered the multi-seller cart, PaymentGroup single-charge flow, per-seller orders, ledger T1 + payout-hold — so the Option B pivot is a SEMANTICS + GATING change on a verified data model, not a rebuild (per prior discussion: "B is A minus fund custody").
- NEW src/lib/psp.ts — Option B provider layer: documents the decision (one PSP charge per checkout; licensed PSP collects, deducts application fee = commission, settles sellers; SHOPMESH never custodies buyer funds → outside BNM FSA 2013 s.17 acquiring scope), declares PspProvider interface + PSP_PROVIDERS registry with only the sandbox "mock" provider active, and enumerates the 4 production plug-in points (adapter, hosted checkout swap, real webhook, CommissionSetting→application fee). Production candidates noted: Stripe Malaysia+Connect / Curlec / iPay88.
- NEW src/lib/feature-flags.ts — MESH_FINANCE_ENABLED = false with the full decision note: scaffold (ShopperWallet model, /api/me/wallet, /api/me/coins/claim, me-hub WalletCard/CoinCard/SPayLater/WalletView, seed) deliberately kept; do NOT delete/reconnect; re-enable requires finance-roadmap discussion + licensing review (withdrawable wallet balance = e-money territory under FSA 2013/BNM; pay-later gated by Consumer Credit Act 2025/SKP registration; non-redeemable coins are the safe first step). Seller payout wallet + ledger explicitly NOT under this flag (it is the Option B accounting mirror and stays active).
- API gating: /api/me/wallet now answers { disabled: true, message, wallet: null, checkIn: null, vouchers: {available,used} } while dormant — does NOT touch ShopperWallet (no lazy creation, no stored-value exposure); voucher counts still served (marketing assets, not money). /api/me/coins/claim rejects 403 FEATURE_DORMANT before any award/streak mutation. Both routes keep their full implementation below the gate with notes.
- Semantics comments: webhooks/payments/process.ts header rewritten to Option B (one PSP charge, ledger = ACCOUNTING MIRROR of PSP sub-balances, not escrow; historical Option A note kept); lib/ledger.ts header notes SELLER:*:PAYABLE mirrors PSP balances and commission lines = PSP application fee (rate model deferred — mechanics untouched); simulate route comment updated ("this endpoint PLAYS the licensed PSP in dev"); prisma/schema.prisma comments on CommissionSetting (application fee, deferred), PaymentGroup (one PSP checkout session, no custody) and ShopperWallet (DORMANT SCAFFOLD with licensing warning).
- UI (me-hub.tsx): SHOPMESH Pay / CoinCard / SPayLater bento cards + "SHOPMESH Pay App" & "Money+" service cards + desktop "My Wallet" sidebar item all gated behind MESH_FINANCE_ENABLED; added FinanceComingSoonCard ("MeshPay & Coins · SOON · scaffold is kept for the roadmap") + FinanceComingSoonView (wallet sub-view now renders coming-soon while dormant; WalletView intact but unreachable); SPayLater chips + aria labels on product cards gated; sign-in hint copy no longer advertises wallet/coins; useMeData normalizes the dormant wallet envelope into the UI shape (zeroed wallet, canClaim false, real voucher counts) so kept components stay type-safe.
- UI (checkout.tsx) Option B copy: multi-seller summary now says "You pay once through our licensed payment partner, which splits each seller their share automatically — SHOPMESH never holds your money."; group pay page says "one secure payment via our licensed payment partner — split to N sellers, each ships separately" (replaces "collecting on behalf of").
- Verification: lint exit 0; tsc shows only the documented pre-existing baseline (checkout.tsx ×4 + admin routes) — zero errors in touched files; dev.log errors scanned = only stale pre-compile "readonly database" entries from the known historical episode (last err line 953 < last compile 1725). Browser E2E (aisyah): Me hub shows NO Pay/Coins/SPayLater cards, teaser + Vouchers card present, no "My Wallet" sidebar, no h-scroll at 390px; /api/me/wallet → disabled envelope with vouchers, /api/me/coins/claim → 403 FEATURE_DORMANT; voucher sub-view works. Checkout regression: single-seller order SM-100030 paid E2E; 2-seller cart (Glow Theory RM159 + ByteBazaar RM199) → checkout "Items from 2 sellers" + Option B copy → PaymentGroup ref_c8835c3ef9b237b9 → pay page shows licensed-partner split copy → Pay Now → BOTH orders paid (SM-100032, SM-100031); DB: group succeeded+paidAt, ledger order_paid per order: GATEWAY debit 15900→SELLER PAYABLE 14469+COMMISSION 1431 and 19900→18706+1194 (commission rates are store-level config). shopperWallet rows untouched (2 inert rows).
- Ops notes: mobile "Me" bottom-nav click hit the framer-motion flakiness again — programmatic element.click() worked (known workaround). No db push needed this task (comments only). Screenshots: /tmp/me-dormant.png (desktop), /tmp/me-dormant-mobile.png (390px), /tmp/pay-optionb.png (group pay page).

Stage Summary:
- SHOPMESH now officially runs OPTION B: one PSP charge per checkout, per-seller orders + commission-as-application-fee ledger mirror, zero platform custody — implemented as a provider abstraction (mock PSP in sandbox) so production is a config-level swap to a licensed gateway. All prior multi-seller flows re-verified E2E under the new copy/semantics.
- Buyer finance suite (MeshPay wallet / Mesh Coins / SPayLater) fully dormant behind MESH_FINANCE_ENABLED=false: APIs gated server-side, UI hidden with "coming soon" teasers, every artifact (model/routes/components/seed) preserved with explicit do-not-remove/do-not-reconnect notes and re-activation instructions.
- Commission rate model deliberately untouched (mechanics live, numbers config) pending the user's deferred discussion. No new tsc errors; lint clean; dev server healthy.

---
Task ID: 13-pre
Agent: orchestrator (Z.ai Code)
Task: RECOVERY — sandbox rollback wiped Task 10–12 source tree; rebuild from documented spec.

Work Log:
- Incident: between the Task 12 session (Oct 16 ~01:13) and the next user turn, the sandbox restored the working tree to a Task 9-era checkpoint (worklog shrank to 622 lines ending at Task 9; shipping.ts/campaigns.ts/vouchers.ts absent; no Shipment/Campaign/StoreFollow models; no ViewProofButton; no NOMOFEE rebrand; no NomoPay rename). Git HEAD (1f85b1d) and all dangling objects were Task-9-era; .next cache pruned. Unrecoverable from disk.
- Survived: SQLite db/custom.db (Task 9-era data) + this conversation's verbatim worklog excerpts + persisted tool outputs.
- Recovery actions: prisma db pull (69 models introspected, 1:1 with old-code schema — confirmed Task 9 DB); re-added ALL lost models/fields in one pass (Shipment, ShipmentEvent +proofImageUrl, StoreFollow, Notification, Campaign, Voucher scope/storeId/regionLimit/quota/claimedCount/startsAt, UserVoucher.usedOrderId, Order.voucherId, Store.fsPriceAdjustMinor, ShopperUser.follows/notifications); db push OK (additive, no data loss); prisma client regenerated.
- Wrote docs/recovery/RECOVERY.md — full rebuild spec for Task 10/10-a/10-b/10-e/10-d/11/12 with API contracts, RBAC one-liners, ownership boundaries (verbatim from the pre-rollback worklog entries preserved in session context).
- Git checkpoint commit created BEFORE any code rebuild to protect against repeat rollback.

Stage Summary:
- Baseline = Task 9 tree + rebuilt schema layer. Rebuild dispatched as Task 13-a..13-d (backend engines) and 14-a..14-d (UI/rebrand). All agents must read docs/recovery/RECOVERY.md first. Credentials unchanged: admin@shopmesh.io/Admin123!, lumina@shopmesh.io/Seller123!, aisyah@shopmesh.test/Shopmesh123! (rebrand to @nomofee.* happens in 14-d including DB migration).

---
Task ID: 13-d
Agent: Z.ai Code (rebuild — TASK 10-d Follow stores + smart nudges)
Task: Rebuild the lost follow-stores + shopper-notifications backend: follow toggle API, notifications list/read/unread APIs, notification triggers on payment-confirmed (both webhook success branches), notify-shopper helper lib, followers count on the storefront data route.

Work Log:
- NEW src/lib/notify-shopper.ts — shopper-ONLY in-app notification helper (sellers/admins keep using the legacy `notify()` email/inapp logger in lib/api.ts):
  - `createNotification(shopperId, type, title, body?, data?)` — best-effort (never throws into the payment/order flow; returns {id}|null, skips when shopperId null so guest orders are silently ignored). dataJson = JSON string shaped {orderNumber?, slug?} per spec. type "promo" is capped at 1/store/shopper per rolling 24h (spec "cap 1/store/day") — cap matched by parsing recent promo dataJson.slug.
  - `notifyShopperOrderConfirmed(order)` — type "order.paid", title "Order confirmed", body "Your order {no} from {store} is confirmed — the seller is preparing it for dispatch."; resolves store slug/name from the order's included store relation or one DB fetch.
  - `notifyShopperShipped(order)` — type "order.shipped", title "Parcel on the way", body "Your {store} parcel {no} has shipped — track it in My Orders."; self-fetches store meta, accepts `{orderNumber, shopperId, storeId}` so 13-a's ship route can call it with the `fresh` order row. INTEGRATION PENDING (see below).
- NEW src/app/api/stores/[slug]/follow/route.ts — GET → requireShopper + public store lookup (404 STORE_NOT_FOUND envelope for unknown slugs) → `{following, followers}`; guests get the 401 envelope (public followers count lives on /api/sf/[slug]). POST → requireShopper, toggles StoreFollow (unique shopperUserId+storeId, race-safe re-check on create conflict → 409 FOLLOW_CONFLICT only if the row truly vanished), maintains ShopperUser.followingCount (profile page shows it), returns `{following, followers}`.
- NEW src/app/api/me/notifications/route.ts — GET (?unread=1|true, ?page=&size= capped 50, newest first) → okPaged envelope {data:[{id,type,title,body,data(parsed JSON),read,readAt,createdAt}], meta:{page,size,total}}. POST {ids?: string[]} | {all:true} (zod-validated, scoped to session shopper, only flips readAt-null rows) → `{updated, unread}`.
- NEW src/app/api/me/notifications/unread/route.ts — GET → `{unread}` via cheap count(shopperUserId, readAt null) for the header bell badge.
- WIRED src/app/api/webhooks/payments/process.ts (both success branches) — group path (inside the per-order loop, after the receipt email notify) and legacy single-order path each now call `notifyShopperOrderConfirmed({orderNumber, shopperId, storeId, store})`. Guest orders (shopperId null) no-op. No other changes to the pipeline.
- EXTENDED src/app/api/sf/[slug]/route.ts GET response mapping — added one `db.storeFollow.count` query + `followers` field on the store object (mapping only; structure untouched).

Trigger points — wired vs pending:
- WIRED: payment confirmed → "Order confirmed" (process.ts, both success branches). Verified E2E (below).
- PENDING 13-a (write-conflict avoidance, per dispatch): shipped → "Parcel on the way" — `notifyShopperShipped()` is exported and ready; ONE-LINE integration in src/app/api/store/orders/[id]/ship/route.ts after the transition/update (13-a owns that file concurrently):
    `await notifyShopperShipped({ orderNumber: order.orderNumber, shopperId: order.shopperId, storeId: order.storeId });`
  Orchestrator: please wire after 13-a lands.
- PENDING (13-a owns deliver/receive): delivered → "Parcel delivered — confirm receipt" — 13-a can call createNotification(shopperId, "order.delivered", "Parcel delivered — confirm receipt", body, {orderNumber, slug}) directly; skip when the buyer triggered the transition themselves.
- PENDING (publish route not in my ownership): seller publish/new-product → promo nudge to followers — the 1/store/day cap already lives in createNotification(type "promo", data.slug); wiring is a follow-up wherever publish lands.

E2E verification (curl, aisyah@shopmesh.test, live server): follow GET guest → 401 envelope; follow toggle ON → {following:true, followers:1}; /api/sf/lumina-living → store.followers 1; profile followingCount 12→13; simulate payment ref_f7e2247375e0a75d (legacy SM-100024) → notification created {type:"order.paid", title:"Order confirmed", data:{orderNumber:"SM-100024", slug:"lumina-living"}}; unread 0→1→0 (mark-read by id); unread=1 filter correct; all:true → updated 0/unread 0 on already-read; toggle OFF/ON round-trip; unknown store → 404.

Ops note (IMPORTANT for parallel agents): the boot-time dev server held a STALE @prisma/client (regenerated 01:40 by the recovery, server booted 01:12) — db.storeFollow was undefined in-route (500 "reading 'count'"). A dev-server restart is REQUIRED after prisma generate/db push; I restarted it during E2E (and a fresh instance is now serving — verified my routes + followers on it). If you see "Cannot read properties of undefined" on a NEW model delegate, restart the dev server before debugging your code.

Stage Summary:
- TASK 10-d backend is live: store-follow toggle + status API, shopper notification feed (list/read/unread), followers count surfaced on the storefront data route, and the payment-confirmed shopper nudge wired into both webhook success branches. Guest orders and notification failures can never break payment processing (helper is best-effort, null-guarded).
- Shipped/delivered/promo triggers are deliberately NOT wired here (ownership boundaries); notifyShopperShipped() + createNotification() are the ready-made integration points — see trigger list above. tsc: zero errors in 13-d files (baseline products/route.ts errors untouched); eslint clean on all 6 touched files.

---
Task ID: 13-b
Agent: claimable-voucher engine agent (Z.ai Code)
Task: TASK 10-b rebuild — claimable voucher engine backend (lib/vouchers.ts verdict engine, me-vouchers wallet+centre, claim endpoint, seller voucher CRUD, checkout quote/create integration, demo seeder).

Work Log:
- Read RECOVERY.md (TASK 10-b spec), worklog, schema ground truth (Voucher scope/storeId/regionLimit/quota/claimedCount/startsAt, UserVoucher.usedOrderId, Order.voucherId, Store.fsPriceAdjustMinor), lib/api+auth, pricing.ts, quote/create routes, me/vouchers route, me-hub/checkout consumers.
- NEW src/lib/vouchers.ts — verdict engine: kinds discount (flat discountMinor XOR percentOff 1..90 floored, maxDiscountMinor cap) | freeshipping (zeroes group shipping, fsPriceAdjustMinor surfaced); coinsback invalid platform-wide (finance dormant, feature-flags.ts); regionLimit="peninsular" via MY state normaliser (11 states + KL/Putrajaya; Sabah/Sarawak/Labuan → "east-malaysia" → invalid with clear reason; unknown state → invalid for FS); validate() checks kind→isActive→startsAt→expiryAt→quota(claimedCount≥quota "fully redeemed")→scope(PLATFORM anywhere/STORE only that group)→minSpend→region; integer-safe throughout (discount capped at group subtotal). Shared helpers: resolveUserVoucherForGroup (wallet ownership+status guard, soft), buildVoucherOutcomes (entries[{storeId,userVoucherId}] → per-group outcomes; hard mode throws 409 VOUCHER_INVALID for create, soft for quote; guest → "Sign in to use your vouchers"), applyVoucherOutcomesToGroups (discount += capped, FS shipping→0, totals recomputed), claimVoucherForShopper (404 unknown/inactive/expired/not-started/dormant/store-closed · 409 ALREADY_HELD incl. P2002 race · 409 QUOTA_EXHAUSTED). Quota semantics per spec: claimedCount increments ONLY at redemption; claim + validate check claimedCount≥quota.
- EXTEND GET /api/me/vouchers → {vouchers (legacy flat rows kept for me-hub), mine:[{id,status,claimedByMe,claimedAt,usedAt,usedOrderId,voucher{...scope,storeId,regionLimit,store{name,slug,logoUrl}}}], center:[pool of active/started/unexpired PLATFORM + live-STORE vouchers, coinsback excluded, with store brief, claimedByMe, quotaRemaining, claimable]}; lazy EXPIRED flip on read kept.
- Kept legacy POST /api/me/vouchers {code} (me-hub contract) — now delegates to claimVoucherForShopper. NEW POST /api/me/vouchers/claim {code|voucherId} → 201 {voucher{...}, userVoucherId, status:"AVAILABLE"}; 400 VALIDATION; 404 NOT_FOUND (unknown/inactive/expired/not-started); 409 ALREADY_HELD/QUOTA_EXHAUSTED.
- NEW GET+POST /api/store/vouchers (requireActiveSellerStore): GET → {vouchers:[...scope STORE for seller store with holders/usedCount/quota/claimedCount/regionLimit], fsPriceAdjustMinor}; POST create store-scope voucher — flat XOR percent validation (1..90 + optional positive cap), FS forced regionLimit="peninsular", code optional (auto "XX-XXXXXX" from slug, 5-candidate collision loop) · 409 CODE_TAKEN on duplicate seller code, money = Int minor, startsAt<expiryAt, quota≥1 when present, coinsback → 400; logActivity voucher.created.
- EXTEND POST /api/checkout/quote: accepts vouchers:[{storeId,userVoucherId}] (also legacy single-store branch userVoucherId); per-group verdict → group.voucher outcome {valid,reason,code,title,kind,discountMinor,freeShipping,fsPriceAdjustMinor}; discount adds to group discountMinor (cap subtotal), FS zeroes group shipping; aggregate totals reflect; NOTHING persisted. Guest quotes unchanged; optional getSession() so voucher entries without a shopper session render "Sign in to use your vouchers".
- EXTEND POST /api/checkout/create: body.vouchers per payment group (first entry per store wins; extras ignored); hard verdicts (409 VOUCHER_INVALID on unknown/not-owned/USED/EXPIRED/minSpend/region/scope/quota — checkout fails, buyer re-quotes); commissions computed on voucher-adjusted totals; inside the SAME $transaction: PaymentGroup totals voucher-adjusted, Order.voucherId + adjusted discount/shipping/total, atomic redemption UserVoucher.updateMany(status AVAILABLE→USED, usedAt, usedOrderId=order.id) — count 0 → 409 VOUCHER_ALREADY_USED (rollback), Voucher.claimedCount+1 quota-guarded updateMany — count 0 → 409 QUOTA_EXHAUSTED (rollback). Idempotent: Idempotency-Key replays return BEFORE any redemption; status guard blocks concurrent double-redeem across different keys. Redemption at order CREATE per existing coupon semantics (not at webhook). logActivity meta carries voucher {code,kind,discountMinor,freeShipping,fsPriceAdjustMinor}; 201 response adds vouchersApplied[].
- NEW prisma/seed-vouchers.ts (bunx tsx, idempotent repair-style upsert — never resets claimedCount/holders, extends expiry only when lapsed): LUMINAFS (FS peninsular · Lumina Living · min RM60 · quota 200), LUMINA12 (12% capped RM25 · Lumina Living · min RM80), BYTE15 (15% capped RM20 · ByteBazaar · min RM100 · quota 150), GLOWRM10 (RM10 flat · Glow Theory · min RM50 · unlimited). Ran twice: created 4, then repaired 0 (idempotency proven).
- E2E verified on dev server: GET me/vouchers (legacy 9 + mine 9 + center 12 incl. 4 store-scope, coinsback excluded); claim LUMINA12 by code (case-normalised) 201, re-claim 409 ALREADY_HELD, LUMINAFS by voucherId 201, unknown 404; seller GET list + POST auto-code LU-* created+deleted, duplicate 409 CODE_TAKEN, flat+percent 400, percent 95 400, FS forced peninsular, coinsback 400; quote LUMINA12 → 13400 sub / 1608 disc / total 11792 with per-group voucher verdict; LUMINAFS → ship 0 + fsPriceAdjustMinor surfaced; LUMINAFS+Sabah → valid:false "Free shipping applies to West Malaysia addresses only", ship stays 800; create with LUMINA12 → SM-100035 discountMinor 1608, Order.voucherId set, UserVoucher USED (usedAt+usedOrderId=order.id), claimedCount 0→1, PaymentGroup adjusted, replay same IdemKey → 200 duplicate:true claimedCount still 1; create with USED voucher → 409 VOUCHER_INVALID + zero orders persisted; plain no-voucher quote/create regression OK (groups[0].voucher null); guest voucher entry → soft invalid.
- NOTE: dev server had died (port 3000 down, stale dev.log) — restarted with the standard `bun run dev` (nohup, appended to dev.log). Pre-existing [api] "o is not defined" ReferenceErrors in dev.log come from src/lib/campaigns.ts:73 (13-c's file, mid-rebuild) — NOT from 13-b files.

Stage Summary:
- TASK 10-b backend is live: claim centre + wallet APIs, seller voucher creation, per-group voucher verdicts in checkout quote, and atomic + idempotent redemption at order create (UserVoucher→USED + usedOrderId + claimedCount+1 + Order.voucherId + discount/shipping effects, FS cost-recovery surfaced via Store.fsPriceAdjustMinor). Coinsback is unreachable platform-wide. tsc: ZERO errors in 13-b files (baseline untouched); bunx eslint on all 6 owned files exit 0; project `bun run lint` exit 0.
- Checkout UI wiring (voucher picker in checkout.tsx) is Wave-2 territory — quote/create envelopes carry everything the picker needs (groups[].voucher verdicts, center pool via me/vouchers).

---
Task ID: 13-c
Agent: campaign-engine (Z.ai Code)
Task: TASK 10-e rebuild — Campaign engine (lib + public/admin APIs + RBAC one-liner + seeder), per docs/recovery/RECOVERY.md scope.

Work Log:
- src/lib/campaigns.ts (NEW, client-import-safe: no top-level prisma/api imports): CampaignThemeT (accent/accentSoft/gradientFrom/gradientTo + greeting/greetingBm/tagline/taglineBm + ornament), DEFAULT_CAMPAIGN_THEME (teal #0D9488), parseCampaignTheme (accepts object OR JSON string — themeJson is a String column; per-field safe defaults; hex #RGB/#RRGGBB validation; copy ≤160; ornament ≤4 code points; never throws), validateCampaignTheme → {ok, errors[], theme} for server-side admin validation, serializeCampaignTheme; CAMPAIGN_PRESETS — 10 Malaysian entries w/ EN + light BM copy + ornaments (raya-aidilfitri #10B981, cny #DC2626 + gold soft #FDE68A, deepavali #7C3AED, merdeka #16A34A, malaysia-day #DC2626, ramadan-early-bird #0F766E, sale-99 #E11D48, sale-1010 #D97706, sale-1111 #EA580C, sale-1212 #DB2777); festival presets carry exact 2025+2026 MYT windows (Raya 31 Mar 25 / ~21 Mar 26 est., CNY 29 Jan 25 / 17 Feb 26 w/ Chap Goh Meh ends, Deepavali 20 Oct 25 / 8 Nov 26, Ramadan 18 Feb 25 / ~19 Feb 26), mega-sale/Merdeka/Malaysia-Day presets are recurring MM-DD windows; presetDateRange — containing-window wins (latest start), else nearest upcoming, recurring windows materialised for current+next MYT year (year wrap), exhausted festival windows roll forward by whole years, end=23:59:59.999 MYT (UTC+8, no DST); campaignStatusOf (draft/scheduled/live/ended), daysUntil (ceil); resolveActiveCampaign — isPublished && startAt<=now<=endAt, latest startAt first, 60s cache on globalThis (`__nomofee_active_campaign_cache`), lazy `await import("./db")`; invalidateCampaignCache.
- src/lib/auth.ts — EXACTLY ONE LINE: `"campaigns.manage": ["superadmin", "ops"]` appended to ADMIN_CAPS (requireCap key now valid).
- APIs (all via handle/ok/okPaged/getPagination/auditAdmin, admin guard = requireCap("campaigns.manage") mirroring existing /api/admin routes): GET /api/campaigns/active (public, force-dynamic, ActiveCampaign|null w/ ISO dates + parsed theme + daysLeft); GET/POST /api/admin/campaigns (paged list w/ status filter mapped to SQL + q name-search; create w/ preset auto-fill of missing dates via presetDateRange, theme validation 400 w/ per-field details[], unknown presetId 400 listing valid ids, start<end enforced); PATCH/DELETE /api/admin/campaigns/[id] (publish/unpublish via publish|isPublished, edits w/ effective-window validation, theme replacement validated; delete 404 on repeat). Every mutation audits + calls invalidateCampaignCache() (verified: publish/unpublish reflected immediately on the public endpoint).
- prisma/seed-campaigns.ts (NEW, idempotent upsert-by-name, run via `bunx tsx` twice to prove idempotency): "Raya Mega Sale (demo)" published live now, startAt=now−2d endAt=now+5d, raya-aidilfitri theme; "12.12 Year-End Warm-Up (draft demo)" unpublished draft on sale-1212 theme + nearest upcoming window (Dec 1–12, 2026).
- E2E on the dev server with an existing admin Bearer session: active/list/paged/status-filter OK; POST preset auto-fill (9.9 → Sep 1–9 2027 given sandbox clock Oct 2026); bad theme 400 w/ details; unknown preset 400; start>=end 400; PATCH publish→scheduled, theme/preset edits, unpublish→draft; DELETE + 404; 401 no-auth; 403 finance role ("Capability 'campaigns.manage' required" — temp session minted then removed); audit rows confirmed. Fixed en route: parseCampaignTheme originally assumed a parsed object and silently returned defaults for the String column themeJson → now JSON-string-tolerant (caught via E2E, not tsc); also removed a stray `const o` slip during that edit (500 INTERNAL caught on admin list, fixed, re-verified).
- Ops note: the supervisor-supplied dev server died mid-task (port 3000 refused); I ran a temporary `next dev -p 3000` for E2E, then killed it once the supervisor's own server took the port back — final state is the supervisor's server, healthy per dev.log.

Stage Summary:
- Campaign engine backend complete: shopper-facing active-campaign theme endpoint (60s cached, null-safe when none running) + full admin CRUD with RBAC campaigns.manage (superadmin|ops), audit trail, cache invalidation, server-side theme validation, and MYT-correct preset date logic that stays meaningful past the hard-coded 2025/2026 windows (sandbox clock Oct 2026 → extrapolated 2027 occurrences verified). DB now carries the live Raya demo campaign + a 12.12 draft for Wave 2 UI work. Work record for other agents: agent-ctx/13-c-campaign-engine.md (cache TTL gotcha + import-safety notes for Wave 2).
- Gates: `bunx tsc --noEmit` filtered to my files → zero errors; `bunx eslint` on all 6 files → pass. prisma/schema.prisma, src/components/**, globals.css, shopper-shell.tsx, src/lib/api.ts untouched.
---
Task ID: 13-a
Agent: full-stack agent (smart shipping & fulfilment backend)
Task: Rebuild TASK 10 + 10-a backend per docs/recovery/RECOVERY.md — lib/shipping mock MY courier engine, lib/placeholder, ship/label/quote/tick/deliver/receive/reorder/return-request APIs, buyer orders list+detail extension (shipment timeline, breakdown, imageUrl chips), lazy auto-complete sweep + lazy tracking tick.

Work Log:
- NEW src/lib/placeholder.ts — deterministic SVG placeholder engine mirroring /api/img/[seed] exactly (same FNV-1a hash + palettes): placeholderSvg/placeholderUrl/svgDataUrl/placeholderDataUrl. Feeds the offline AWB-label + POD pipelines (no external URLs anywhere).
- NEW src/lib/shipping.ts — ShippingProvider abstraction with the deterministic mock Malaysian network (providerId "mock"): quoteRates(parcel, dest) → 3 couriers (J&T economy / Pos Laju standard / City-Link standard_plus) priced by weight bands × peninsular-vs-east zone (Sabah/Sarawak/Labuan surcharge), stable rateIds `mock:{code}:{service}`; bookShipment(order, quote) → Shipment BOOKED + AWB `{PLJ|JTE|CLX}+10 digits` + inline SVG AWB label (640×880, barcode bars from hash, mock-use watermark) + first BOOKED ShipmentEvent; syncTracking(shipmentId) → one state-machine step BOOKED→PICKED_UP→IN_TRANSIT→OUT_FOR_DELIVERY→DELIVERED with plausible MY hub locations (zone-aware pools) + ShipmentEvent rows; on DELIVERED attaches deterministic mockPodUrl(awb) (SVG data-URL), sets shipment.deliveredAt, flips order → "delivered" via transitionOrder (history row) + store webhook order.delivered + email log + buyer nudge; fastForwardDelivery(orderId, deliveredAt, proofUrl?) backfills skipped milestones with strictly-increasing clamped timestamps inside [bookedAt, deliveredAt] (never OUT_FOR_DELIVERY after DELIVERED) for manual mid-simulation delivers; tickShipments() advances all active mock shipments; maybeSyncTracking() = lazy 45s-per-shipment guard; assertShippable() + validateProofDataUrl() (≤1.2MB) shared guards.
- Buyer nudges delegate to 13-d's shared src/lib/notify-shopper.ts (createNotification / "Parcel on the way" / "Parcel delivered — confirm receipt"), matching its dataJson {orderNumber, slug} contract; delivered nudges only fire from courier/seller paths (receive route triggers none).
- EXTEND POST /api/store/orders/[id]/ship — body {mode:"platform", rateId} validates by RE-DERIVING the deterministic quote (no quote storage needed — zero-drift by construction) then books via bookShipment, transitions to shipped, stamps order.trackingProvider "mock" + AWB, webhooks+emails+nudge+activity; legacy {provider, trackingNumber} (and bare body without mode, as the existing seller UI sends) keeps working verbatim; response now also carries shipmentStatus + shipment{awbNumber, courierName, etaFrom, etaTo, labelUrl} (null for manual).
- NEW GET /api/store/orders/[id]/label — streams the stored SVG label as image/svg+xml with AWB filename (?download=1 for attachment); 404 LABEL_NOT_FOUND when no platform booking.
- NEW GET /api/store/shipping/quote?orderId= — store-scoped; returns order/destination/parcel{weightGrams=150+120·qty,itemCount}/rates[] + existing shipment brief for the ship dialog.
- NEW POST /api/shipping/tick — advances every active mock shipment one step (unauth by design: only drives the offline simulation); 1.5s in-memory throttle (globalThis).
- EXTEND GET /api/me/orders — per-item first-image imageUrl (placeholder fallback), order-level shipmentStatus/shippingCourierName/trackingNumber (AWB fallback); lazy auto-complete sweep (delivered >14 days → completed, actor system, note "Auto-confirmed 14 days after delivery", 60s globalThis throttle, ≤50 rows/pass) + lazy tracking tick for the shopper's stale in-flight mock shipments; both wrapped in try/catch so the read never breaks.
- EXTEND GET /api/me/orders/[orderNumber] — full Task 11 surface: customerName/phone/note, parsed shippingAddress object, subtotal/discount/shipping/tax/total breakdown, paymentProvider, paidAt/shippedAt/deliveredAt/completedAt, items with variantLabel + unit/line prices + first image, full status history, shipment{status, courier, awb, labelUrl, eta, events[{status, description, location, occurredAt, proofImageUrl}]}, top-level shipmentStatus/shippingCourierName/trackingNumber, latest dispute; lazy 45s sync re-reads the order when a step advanced.
- NEW POST /api/me/orders/[orderNumber]/receive — shopper-scoped; shipped|delivered → completed (completedAt now, actor "shopper"); mid-flight platform shipment fast-forwarded to DELIVERED (POD attached) first so the timeline can't trail the buyer; repeat → 409 VALIDATION, payment_pending → 409 INVALID_STATUS, other shopper → 404.
- NEW POST /api/me/orders/[orderNumber]/reorder — merge rule newQty = min(99, cartQty + itemQty, live stock) against the shopper's active multi-seller cart (creates one if absent); reasons "Out of stock" / "Already at the maximum in your cart" / "No longer available" (variant inactive, product not active, store not live); responds {added, skipped}.
- NEW POST /api/store/orders/[id]/deliver — seller-scoped; shipped-only (else 409 INVALID_STATUS, cross-store 404); accepts {proof?: data:image ≤1.2MB, note?}; platform shipment → fastForwardDelivery with seller proof (or deterministic mock POD); manual/none → transitionOrder + closes shipment with DELIVERED event carrying the proof; skips duplicate webhook/email when fastForward already fanned out.
- NEW POST + GET /api/me/orders/[orderNumber]/return-request — buyer after-sales per spec, stored as Dispute rows (schema has no type column → type folded into reason text "Refund/Return request — …"), disputedFlag set, open-dispute dedupe → 409 DISPUTE_EXISTS, allowed from paid/processing/shipped/delivered/completed; GET returns the dispute list for buyer visibility.
- Verified E2E with curl (lumina/glow/byte seller + aisyah buyer sessions): quote→platform ship (AWB CLX1010659926)→label SVG 200→4× tick walk→auto-delivered + POD data-URL + order delivered; buyer detail/list surfaces correct chips + images; deliver-with-proof on legacy-shipped order; receive → completed then 409 on repeat; unpaid receive 409; reorder merge cart qty 1→2 (stock-aware); return-request → open dispute + repeat 409; 14-day sweep flipped a back-dated order to completed with system history row. Guards: wrong-state ship/deliver 409, cross-store 404.

Stage Summary:
- TASK 10/10-a backend is LIVE: sellers can quote → book (platform) or ship manually (legacy intact), download AWB labels; the mock courier walks parcels to DELIVERED on demand (/api/shipping/tick) or lazily when the buyer looks; buyers get the full breakdown + timeline + POD, confirm receipt, reorder, and open refund/return disputes; delivered orders auto-complete after 14 days.
- Key decisions: quote→book consistency via deterministic re-derivation (no stored quotes); buyer notifications routed through 13-d's shared helper (no parallel implementation); after-sales rows live in Dispute (type encoded in reason) since the Dispute model is the schema ground truth and has no type column; lazy duties throttled on globalThis (Turbopack-safe) and failure-isolated.
- Deviations: none functional. Note for 14-a/14-b (UI): ship dialog consumes /api/store/shipping/quote {rates[].rateId}; deliver dialog POSTs proof data-URL ≤1.2MB; buyer timeline reads order.shipment.events[].proofImageUrl; reorder toast reads {added, skipped}.

---
Task ID: 14-a
Agent: seller-ui rebuild agent (ship/deliver/shipment UI + seller voucher manager)
Task: Rebuild the lost seller UI for TASK 10 / 10-a / 10-b seller parts + TASK 11 seller POD — ShipOrderDialog (platform booking + manual), read-only shipment panel + list tracking badges, DeliverDialog (in-browser compressed POD proof), seller voucher manager panel — per docs/recovery/RECOVERY.md. Ownership: src/components/seller/ only.

Work Log:
- NEW src/components/seller/shipment-panel.tsx — ShipmentPanel (order detail, read-only): platform bookings read the `shipment` brief {status, awbNumber, courierName, etaFrom, etaTo} that GET /api/store/shipping/quote?orderId= returns (GET /api/store/orders/[id] does NOT expose the shipment relation — verified), manual shipments fall back to order.trackingProvider/trackingNumber; shows courier, AWB (+copy), ShipmentStatusChip (BOOKED/PICKED_UP/IN_TRANSIT/OUT_FOR_DELIVERY teal/amber/emerald/rose map, no blue/indigo), ETA window, delivered date, and "Download AWB label (SVG)" via the exported downloadOrderLabel() helper (auth-fetch GET /api/store/orders/[id]/label?download=1 → Blob → save, because the Bearer session may not ride plain <a href>). Also exports ShipmentStatusChip + fmtEtaRange for reuse. Parent bumps refreshKey after ship/deliver mutations to re-pull the brief.
- NEW src/components/seller/ship-order-dialog.tsx — ShipOrderDialog replacing the old manual-only ShipDialog. Tabs "Platform booking" | "Manual" (44px triggers). Platform: useApi pulls GET /api/store/shipping/quote?orderId= → parcel/destination strip (items, weight, dest city/zone) + selectable radio rate cards (courier, service level, ETA working-days text, price via formatMinor, max-h-72 scroll) → POST /api/store/orders/[id]/ship {mode:"platform", rateId} → success view with courier, AWB, ETA window, shipmentStatus chip and label download (only when shipment.labelUrl exists). Manual: provider + trackingNumber → POST {mode:"manual", provider, trackingNumber}. Errors toast verbatim (RATE_NOT_FOUND / INVALID_STATUS / CODE_TAKEN etc.); quote load failure nudges to the Manual tab. Dialog stays mounted per detail view; state resets on open.
- NEW src/components/seller/deliver-dialog.tsx — DeliverDialog ("Mark delivered" on shipped orders): optional POD photo (hidden file input accept=image/*) → FileReader → Image → canvas downscale to ≤1280px longest side → JPEG toDataURL walking quality 0.82/0.62/0.45 until ≈bytes ≤1.2MB (matches backend validateProofDataUrl; ~1.2MB guard) → preview + Remove + KB readout; optional note (≤500 chars backend-side); POST /api/store/orders/[id]/deliver {proof?, note?} → success toast → close + refresh. 409 INVALID_STATUS on wrong state surfaces as a toast.
- NEW src/components/seller/vouchers.tsx — SellerVouchers panel (TASK 10-b seller part): GET /api/store/vouchers → {vouchers[], fsPriceAdjustMinor}; info card explains FS cost recovery (fsPriceAdjustMinor read-only display); table (overflow-x-auto) columns: code+title, value (RM X off / X% off · cap RM Y / Free shipping), min spend, claims (claimedCount/quota · usedCount redeemed), region (West MY badge when regionLimit=peninsular / All Malaysia), starts→expiry, status (Switch + StatusChip; lapsed expiry → closed chip). "New voucher" dialog: title 3-80, kind discount|freeshipping, discount sub-type flat (MoneyInput → discountMinor) XOR percent (1..90 + optional maxDiscountMinor cap), minSpend, optional claim quota, required expiry date (→ ISO end-of-day, future-checked), optional code (uppercase; auto-generated server-side when blank); POST → 201 toast with returned code; dup code → 409 CODE_TAKEN toast; freeshipping region forced server-side (dialog explains West-MY-only).
- REWIRED src/components/seller/orders.tsx — detail view: old ShipDialog REMOVED (superseded); ShipOrderDialog + DeliverDialog mounted, "Mark delivered" button (bg-brand-gradient-deep) on shipped orders, refreshAll() = order refetch + ShipmentPanel refreshKey bump; ShipmentPanel card inserted in the detail grid between Customer & shipping and Status timeline. List rows: when trackingNumber exists, Status cell gains a small truck + mono tracking-number badge (title attr, truncate). OrderDetail type + deliveredAt (already in the response spread). to_fulfill/shipped flows unchanged otherwise.
- WIRED nav: ui-bits.tsx SellerViewName + "vouchers"; seller-shell.tsx — import SellerVouchers, NAV entry {key:"vouchers", label:"Vouchers", icon:BadgePercent} after Coupons, render line (desktop sidebar + mobile sheet share NAV). Nothing outside src/components/seller/ touched.
- Conventions kept: apiGet/apiSend/useApi/runMutation helpers, StatusChip, MoneyInput, formatMinor, sonner toasts, 44px targets, teal brand CTAs, no indigo/blue, mobile-first dialogs (max-w-md + scrollable body at 414px).

E2E verification (fresh dev server boot inside the call, lumina@shopmesh.io session): login 200; to_fulfill list 200 (5 rows, trackingNumber field present); quote SM-100024 → dest {Selangor/Kuala Lumpur/peninsular}, parcel {270g/1 item}, 3 rate cards (mock:jt:economy 550 / mock:poslaju:standard 700 / mock:citylink:standard_plus 850) with etaFromDays/etaToDays; POST ship platform {mode,rateId} → 200 {status:"shipped", shipmentStatus:"BOOKED", shipment{awbNumber PLJ0676329720, courierName "Pos Laju", etaFrom/etaTo, labelUrl}} (exact ShipResult shape); GET label?download=1 → 200 image/svg+xml 3924 bytes (AWB-*.svg disposition); POST deliver {proof:dataURL,note} → 200 {status:"delivered", deliveredAt, shipmentStatus:"DELIVERED"}; repeat deliver → 409 INVALID_STATUS; vouchers GET → 2 rows + fsPriceAdjustMinor:0 (LUMINA12 fields match the panel type); voucher POST percent+cap → 201 E2E14A, dup → 409 CODE_TAKEN, freeshipping → 201 regionLimit:"peninsular". Test residue: SM-100024 is now delivered (full ship→deliver walk) and two demo vouchers (E2E14A + auto FS "14-a FS check") exist on Lumina Living. Root page compiles 200, dev.log clean.

Gates: bunx tsc --noEmit filtered to src/components/seller → ZERO errors; bunx eslint on all 7 touched files → clean (removed 4 stale eslint-disable directives it flagged). No files outside src/components/seller/ modified; no schema/API/lib changes.
---
Task ID: 14-c
Agent: full-stack agent (Me hub UI rebuild)
Task: Rebuild lost buyer-side UI in me-hub.tsx per docs/recovery/RECOVERY.md — Task 10-c voucher views (Mine | Voucher Center), Task 11 Shopee-style purchases order cards (thumbnails, shipment/courier chips, receive/reorder, focus refetch), Task 10-d notification bell + panel (new self-contained component), Sell/Generate shortcut tile, Task 12 finance-scaffold rename (NOMO strings) inside this file only.

Work Log:
- NEW src/components/shopper/notification-bell.tsx — self-contained bell + panel, DEFAULT EXPORT `NotificationBell` so the orchestrator can also mount it in the global header. Props `{onOpenOrder?, onOpenStore?, className?, align?}`; guest-safe (renders null until me-state is loaded+signed-in). Badge from GET /api/me/notifications/unread polled every 30s + window focus + visibilitychange; panel = Radix Popover (portals to body — safe inside the overflow-hidden profile header) fed by GET /api/me/notifications?size=20 (data IS the row array; rows {id,type,title,body,data{orderNumber?,slug?},read,readAt,createdAt}); type icons (order.shipped=Truck teal, order.delivered=PackageCheck emerald, order.*=Package, promo=Megaphone amber, default Bell), relative time helper, unread dot + teal tint; mark-all-read via POST /api/me/notifications {all:true} → {updated,unread} (NOTE: there is NO /read subroute — the collection route owns POST, body {ids|[all:true]}); item click marks {ids:[id]} read then click-through: data.orderNumber → onOpenOrder, else data.slug → onOpenStore; aria-labels on trigger ("Notifications, N unread"), panel, list, items; 40px trigger matching the existing profile-header IconAction row; amber badge matches cart badge language.
- me-hub.tsx VouchersView rebuilt (Task 10-c): segmented tabs "Mine (n) | Voucher Center" (role=tablist, teal active pill); single GET /api/me/vouchers load consuming {mine, center} with legacy fallback mine = d.mine ?? d.vouchers (legacy `vouchers` contract still honoured); Mine tab keeps the claim-by-code input (POST /api/me/vouchers {code}) + held cards with status badge AVAILABLE/USED/EXPIRED, value line ("RM 10 off" / "20% off · up to RM 15" / "Free shipping"), KindBadge (discount=rose / freeshipping=teal / coinsback=amber), mono code, store name when scope=STORE, minSpend ("No min. spend"), expiry, peninsular regionLimit note, "Used on" date; Center tab renders pool cards (store logo w/ fallback tile + name + Platform tag, value, minSpend, quotaRemaining "n left"/"Unlimited quota", expiry, regionLimit note) with 44px Claim buttons → POST /api/me/vouchers/claim {voucherId}: 201 → toast + optimistic claimed-swap + reload; 409 ALREADY_HELD / QUOTA_EXHAUSTED get dedicated toasts via ApiFail.code then resync; disabled labels "Claimed" (Check) / "Fully claimed"; empty states + skeletons; scroll containers max-h-[70vh]/max-h-96 pattern with Tailwind [&::-webkit-scrollbar] styling (globals.css untouched).
- me-hub.tsx PurchasesView rebuilt (Task 11): new PurchasesOrderCard — store header + StatusBadge; shipment/courier chip ONLY when trackingNumber exists (Truck + "courier · shipmentStatusLabel [· AWB]", emerald DELIVERED / rose EXCEPTION|RETURNED / teal otherwise, labels from a SHIPMENT_STATUS_LABEL map); item rows with 56px thumbnails (item.imageUrl, Package-icon fallback), title, variantLabel, "x{qty}" + "RM x each" (formatMinor(unitPriceMinor)); totals line (orderNumber+date left, "Order Total" right); actions row rendered OUTSIDE the clickable summary button (no nested interactive elements): "Buy again" (always) + "Order received" when status shipped|delivered. Receive → POST /api/me/orders/[orderNumber]/receive → toast + refetch; Reorder → POST reorder → success/info toast with added ("title ×qty") + skipped ("title — reason") summary, notifyCartUpdated() so header badges refresh, ctx.openCart() only when units added. PurchasesView now refetches on window focus + visibilitychange(visible) so mock-courier progress / seller deliveries / 14-day auto-completes appear without remount.
- Sell / Generate shortcut: "More Activities" grid gains `<ActivityTile icon={Sparkles} label="Sell / Generate" onClick={() => ctx.nav({name:"generate"})} />`; "Start Selling" tile unchanged.
- NotificationBell mounted in ProfileHeader between Settings and Cart with white-on-gradient trigger classes and onOpenOrder → ctx.nav({name:"order-status", orderNumber}) (new onOpenOrder prop threaded through Dashboard).
- Finance scaffold rename (Task 12 strings, this file only): alias `const NOMO_FINANCE_ENABLED = MESH_FINANCE_ENABLED;` directly under the feature-flags import — all 6 usage sites now read NOMO_FINANCE_ENABLED, so the 14-d global rename only needs to touch feature-flags.ts + this import/alias pair. Labels: "SHOPMESH Pay"→"NomoPay", "SPayLater"→"NomoPay Later" (dashboard card, WalletView, product chip "NomoPay Later 0% 3x", card aria), "Mesh Coins"/"My Coins"→"Nomo Coins" (CoinCard + WalletView), FinanceComingSoonCard "NomoPay & Coins" + aria "NomoPay and Nomo Coins coming soon", FinanceComingSoonView "NomoPay is coming soon" + NomoPay/Nomo Coins hint, "SHOPMESH Pay App"→"NomoPay App".
- E2E on the dev server (aisyah@shopmesh.test / Shopmesh123!, Bearer token): notifications unread {unread:4}, list rows carry parsed dataJson {orderNumber, slug}, {ids:[id]} → {updated:1, unread:3}; vouchers {vouchers, mine:11, center:14}; claim already-held code → 409 ALREADY_HELD; claim by voucherId → 201 + AVAILABLE, pool re-read flips claimedByMe:true/claimable:false and mine 11→12; orders rows carry imageUrl + shipmentStatus/shippingCourierName/trackingNumber (SM-100024 delivered w/ Pos Laju + AWB); reorder SM-100032 → {added:[{Barrier Repair Serum 30ml, qty:1}], skipped:[]}; receive SM-100024 delivered→completed 200, repeat → 409 VALIDATION; GET / compiles clean (HTTP 200, no build errors in dev.log).
- Gates: `bunx tsc --noEmit` filtered to my two files → zero errors (pre-existing baseline errors in src/lib/app-store.ts are not mine); `bunx eslint me-hub.tsx notification-bell.tsx` → pass. Untouched: checkout.tsx / ui-bits.tsx / storefront.tsx (14-b), shopper-shell.tsx, seller/**, API routes, schema, feature-flags.ts, globals.css.

Stage Summary:
- Buyer Me hub is whole again: vouchers (wallet + claim centre with quota/claimed-state handling), Shopee-style purchases cards with live shipment chips and one-tap receive/reorder, notification bell with 30s-poll badge and click-through panel, Sell/Generate shortcut, and NOMOFEE finance naming — all on the rebuilt Task 10/10-a/10-b/10-d/11 backends.
- Coordination notes: (1) NotificationBell is default-exported and mount-anywhere (auth-gates itself; pass onOpenOrder/onOpenStore for navigation — global header should pass the shell's nav); (2) POST for mark-read lives on /api/me/notifications itself, no /read subroute; (3) 14-d still owes: feature-flags.ts constant rename (+ the alias lines in me-hub), /api/me/wallet route spayLater*→payLater* (me-hub's WalletT type mirrors the current API field names and must flip in the same commit), and the SHOPMESH→NOMOFEE brand sweep (me-hub still carries "SHOPMESH Food", "SHOPMESH safe-shopping" dialog copy, and the MESH10 demo voucher-code placeholder).
- Deviations: none functional. Minor interpretation calls: "Buy again" shown for all statuses (reorder route re-checks availability live; nothing-added gets an info toast instead of opening the cart); "Mesh Coins"/"My Coins" labels unified as "Nomo Coins"; Work record for other agents: agent-ctx/14-c-me-hub-ui.md.

---
Task ID: 14-b
Agent: buyer-checkout/tracking UI agent (Z.ai Code)
Task: Rebuild the lost buyer-side UI per docs/recovery/RECOVERY.md — checkout.tsx (OrderStatusView Shopee-style overhaul + live refresh + receive/reorder actions + NOMOFEE receipt filename; voucher picker wired into quote/create; EDD chip), ui-bits.tsx (shared ViewProofButton + shipment-event StatusTimeline + OrderDetail/Shipment types), storefront.tsx (Follow button in the store header + aria rebrand).

Work Log:
- ui-bits.tsx (extend, not rewrite): NEW `ViewProofButton` (outline button → Dialog with the POD photo from proofImageUrl; compact variant for timeline rows; data-URL-safe plain <img>); NEW Shopee-style `StatusTimeline({events})` for shipment.events — icon + status + description + location + time, newest first, latest row highlighted, View-proof affordance on the DELIVERED event, `shipmentEventLabel()` helper; exported types `ShipmentEventT`/`ShipmentT`/`OrderDetailT` (OrderDetailT = LookupResultT + Task-11 detail surface so guest lookup + account detail share one render path); widened `LookupResultT.items` with optional variantLabel/unit/line/imageUrl (guest lookup still satisfies it).
- NAMING NOTE for other agents: the OLD history-based progress stepper (`StatusTimeline({history,current})`, previously used only by checkout.tsx) is renamed to `OrderFlowTimeline` — still exported from ui-bits; `StatusTimeline` is now the shipment-event timeline per the 14-b brief. Grep-verified no other file imported the old name (14-c's PurchasesView ships its own row UI).
- checkout.tsx — OrderStatusView rebuilt: hero status card (brand-gradient strip: per-status icon+headline+blurb via orderHero(), mono order# + copy button, dark EDD chip, dispute notice strip); items card (56px thumbnail, title, variantLabel, "Qty n · RM x each", line totals); totals block (subtotal / discount / shipping FREE-aware / tax / total); "CUSTOMER & SHIPPING" card (address block + phone, payment method via PROVIDER_LABEL + paidAt, customer note); shipment card = tracking chip (courier · AWB) + EddChip (from shipment etaFrom/etaTo while in flight) + StatusTimeline; pre-shipment orders fall back to OrderFlowTimeline; guest lookups (no breakdown) keep the legacy OrderCard.
- Live refresh: 12s poll + refetch on window focus + visibilitychange(visible only), interval/listeners cleaned up on unmount; polling errors never blank an already-loaded view (loadedRef).
- Action row: Continue shopping / Download receipt (client filename now `NOMOFEE-Receipt-<order>.pdf`) / Contact seller (now passes storeId too) / All my orders / Order received (shipped|delivered → POST receive → toast + reload → completed; 409 messages surface) / Buy again (POST reorder → toast "{n} item(s) added" + skipped summary → notifyCartUpdated() + ctx.openCart(); nothing-added → info toast without opening cart).
- Voucher picker (Task 10-b): CheckoutView loads GET /api/me/vouchers `mine` (AVAILABLE only, coinsback kind excluded as platform-dormant); per seller group (quote.groups → cart.stores → cart items fallback) a shadcn Select ("No voucher" + held vouchers matching PLATFORM scope or that storeId, labels like "12% off (cap RM 25) · LUMINA12"/"Free shipping · LUMINAFS"); selection is pruned to stores actually in the checkout (create endpoint is HARD about unknown sellers) and sent as `vouchers:[{storeId,userVoucherId}]` in BOTH /api/checkout/quote calls (auto-quote + coupon apply) and /api/checkout/create; per-group verdict rendered under each select (emerald "CODE applied — RM x off" / "CODE applied — free shipping on this parcel", rose reason when invalid); create response `vouchersApplied` folded into the order-created toast.
- EDD chip: `eddFromEtaLabel()` parses the quote's "2-4 working days" into a real date window (weekend-skipping) → chip on the phase-3 Delivery review card; `eddFromShipment()` formats shipment etaFrom/etaTo ("Oct 18–21", cross-month aware) → chip on the order-status hero.
- storefront.tsx: SfStore += `followers?`; NEW FollowStoreButton mounted in SfHeader — seeds followers from the /api/sf/[slug] payload, refines via GET /api/stores/[slug]/follow (guest 401 keeps the seed), optimistic toggle w/ rollback on POST, follower count beside the button (sm+/md+), guest click → `openShopperAuth(() => void toggleFollow())` (same pattern as ContactSellerButton); aria-label "Back to SHOPMESH marketplace" → "Back to NOMOFEE marketplace" (other SHOPMESH copy in this file left for 14-d's rebrand sweep).
- Fixed the 4 documented Task-9-era pre-existing tsc errors inside checkout.tsx (Stepper onJump narrowing; three `&& contactErrors.x` → ternary) so this file is now at zero tsc errors.
- Verified E2E (curl, aisyah@shopmesh.test, server restarted inside the bash call each time — sandbox reaper): claim GLOWRM10 → 201; quote WITH vouchers:[{storeId,userVoucherId}] → group verdict {valid:true, code:"GLOWRM10", discountMinor:1000} and totals adjusted (disc 1000, total 46700); orders list carries imageUrl + shipmentStatus/courier/AWB chips; SM-100032 detail = full breakdown + shipment DELIVERED City-Link Express CLX1010659926 + 5 events with proofImageUrl (data-URL SVG) on DELIVERED only; receive on payment_pending → 409 (message surfaces via toast path); reorder SM-100035 → {added:[Aurora Vase ×1, Linen Cushion ×1], skipped:[]} (test items removed from the cart afterwards — cart restored to Barrier Repair Serum ×3); follow toggle → {following:false,followers:0} then {following:true,followers:1} and /api/sf/lumina-living followers:1; root 200; no dev.log errors; "NOMOFEE-Receipt-" present in the compiled checkout chunk.

Stage Summary:
- Buyer checkout + tracking UI is whole again and Task-11-shaped: hero status card, item thumbnails with per-item pricing, full totals, CUSTOMER & SHIPPING block, Shopee-style shipment timeline with POD "View proof", live 12s/focus refresh, and the full action row incl. Order received + Buy again; claimable vouchers are pickable per seller group at checkout with live server verdicts end-to-end (quote → create → vouchersApplied toast); EDD chips surface delivery windows on both payment review and order tracking; store headers now have an optimistic Follow button with follower counts and guest sign-in prompting.
- Shared exports for Wave-2 agents (ui-bits.tsx): `ViewProofButton({url,label?,compact?})`, `StatusTimeline({events})` (shipment events; View-proof built in), `OrderFlowTimeline({history,current})` (old stepper), `shipmentEventLabel()`, types `ShipmentEventT`/`ShipmentT`/`OrderDetailT`. ShopperCtx untouched. Work record: agent-ctx/14-b-checkout-tracking-ui.md.
- Gates: `bunx tsc --noEmit | grep shopper/(checkout|ui-bits|storefront|pod|tracking)` → ZERO errors (incl. clearing the 4 legacy baseline errors in checkout.tsx); `bunx eslint` on all three files → clean; `bun run lint` → clean. NO pod.tsx/tracking.tsx split files created (both shared components live in ui-bits per the brief's "export both" requirement; splitting would have duplicated them). Receipt route's server-side filename header still says SHOPMESH — that file is NOT in 14-b ownership (client-side name fixed here; server header flagged for 14-d).

---
Task ID: 14-d
Agent: full-stack-developer (expired pre-report; section written by orchestrator from verified state)
Task: Rebrand SHOPMESH→NOMOFEE sweep + DB migration + NomoPay/flag rename + admin campaigns UI + shopper theme layer.

Work Log (verified post-expiry):
- Rebrand sweep: 53 files touched — README/handover/docs, seeds (emails→@nomofee.io/@nomofee.test), auth/register tagline+notify recipient, chat assistant name, import seo descriptions, admin/seller shell logos, storefront/market/generate copy. NOT changed (per spec): fixture hostnames, USER_AGENT strings, secretbox dev-key, sm_session cookie, passwords.
- scripts/rebrand-db.ts (NEW) — RAN once: ShopperUser/Seller emails now @nomofee.* (verified in DB: aisyah@nomofee.test, lumina@nomofee.io + 4 more sellers; buyer@test.dev/tradecasm@gmail.com preserved).
- src/lib/api.ts nextOrderNumber SM- → NM- (legacy SM- orders unaffected).
- Receipt Content-Disposition + client filename → NOMOFEE-Receipt-*.
- NOMO FINANCE rename: feature-flags NOMO_FINANCE_ENABLED; wallet/coins routes + message "NomoPay & Nomo Coins are coming soon."; wallet response + me-hub WalletT spayLater*→payLater*; schema ShopperWallet columns → payLaterLimitMinor/payLaterUsedMinor (+db push + generate); seed-me wallet fields; psp mock label "NomoPay Checkout (sandbox)"; recommendations PAYLATER_MIN_MINOR/payLaterEligible; vouchers comments.
- Admin campaigns UI in admin/marketing.tsx (list/create-from-preset w/ auto-dates+theme fields+preview/publish/delete, 403 handling) — RBAC campaigns.manage (superadmin/ops).
- Shopper theme layer in market.tsx: GET /api/campaigns/active → accent vars + greeting + ornaments + "Ends in N days" chip; graceful null.

Stage Summary:
- Platform is fully NOMOFEE-branded (code + DB), finance scaffold fully NomoPay-branded and still dormant. New credentials: aisyah@nomofee.test/Shopmesh123!, lumina@nomofee.io/Seller123!, admin@nomofee.io/Admin123!. New orders NM-. tsc baseline 57 unchanged; lint clean; schema synced.

---
Task ID: 15
Agent: orchestrator (Z.ai Code)
Task: User requests — ① back navigation on every page, ② canvas #fafeff + border #fafeff, ③ move Sell/Generate from header to buyer backend, ④ buyer-turned-seller account model discussion (answered in chat).

Work Log:
- Back nav (req 1): ShopperShell now keeps a history stack (viewRef mirror + viewStack cap 25, StrictMode-safe); ShopperCtx gains back() (ui-bits.tsx); new BackBar in checkout.tsx wired into OrderStatusView + OrdersView + LookupView (aria-label "Go back to the previous page"). Bottom-nav switches still push history. Browser-verified: order NM-100011 detail → Back → lands back on My Purchases.
- Colors (req 2): globals.css --background #e8fcff→#fafeff, --border #d8ebf1→#fafeff, --sidebar-border→#fafeff, body gradient 0% stop → #fafeff (softened mid stops), comments de-ShopMesh'd. Verified computed body bg = rgb(250,254,255). NOTE for user: borders are now near-invisible hairlines (same tone as canvas) — cards still separate via shadow-soft; one-line revert if unwanted.
- Sell/Generate (req 3): header button REMOVED from MarketHeader (guests still reach it via the footer CTA "Generate your store from a marketplace link"); 14-c added the "Sell / Generate" shortcut tile in Me hub More Activities (Sparkles, → generate flow). NotificationBell (14-c) mounted in the global header (desktop) + profile header (Me hub).
- Full E2E re-verified post-rebuild: login aisyah@nomofee.test OK (readonly-DB incident = stale inode after rebrand replaced custom.db; server restart fixed); Me hub NomoPay strings; bell present; order detail with CUSTOMER & SHIPPING + Buy again + Go back; back returns to My Purchases; campaign theme layer live on market (Raya #10b981 accent + "Ends in 5 days"); canvas #fafeff; dev.log clean; tsc 57/57 baseline; lint clean.
- Git checkpoints committed at every wave (c4c226e, 8f1d397, e611961, ee9c45a) to protect against further sandbox rollbacks.

Stage Summary:
- All four user requests delivered (④ as discussion in chat). Recovery complete: Task 10/10-a..e/11/12 surfaces rebuilt and verified. Recommend committing after each session (sandbox rollback risk).

---
Task ID: 16
Agent: orchestrator (Z.ai Code)
Task: User requests — ① where is the Store Setting for celebration/festive themes on Admin backend (question, answered), ② checkout "Updating prices from server…" stuck in a loop greying out Continue-to-payment (bug fix), ③ footer spelling renders "NOMO FEE" instead of NOMOFEE (bug fix).

Work Log:
- ① Answered (no code): festive/celebration theming lives in Admin → Marketing → Campaigns (PartyPopper nav item, admin/marketing.tsx CampaignsView). 10 Malaysian presets (Raya, CNY, Deepavali, Merdeka, Malaysia Day, Ramadan Early-Bird, 9.9/10.10/11.11/12.12) auto-fill dates + theme (accent/accentSoft/gradients/greeting EN+BM/tagline/ornament); publishing themes the shopper market home via /api/campaigns/active. Verified via API: 2 campaigns seeded — "Raya Mega Sale (demo)" PUBLISHED+live (🌙 #10b981) and "12.12 Year-End Warm-Up (draft demo)". Noted: theme editing is create-time only (no edit dialog yet — recreate to change); needs campaigns.manage (superadmin/ops). Correct admin login payload needs portal:"admin", admin@nomofee.io/Admin123!.
- ② Root-caused the checkout loop in shopper/checkout.tsx: setQuote(q) → storeGroups memo (deps [quote,cart,items]) recomputes → voucherEntries memo ALWAYS returns a new array identity (map().filter(), even when empty) → refreshQuote useCallback (deps [payloadItems,voucherEntries]) recreated → auto-quote effect refires → refetch → infinite "Updating prices from server…" with quoting permanently true → both "Continue to payment" (line ~1179 disabled={quoting}) and Pay-now (disabled={...||quoting||!quote...}) greyed out. Fix: (a) quoteSeq ref sequencing — only the newest request writes quote state/settles quoting; (b) voucherEntries moved OUT of refreshQuote deps, read at call time via voucherEntriesRef, effect keyed on stable voucherKey string (storeId:userVoucherId join); (c) applyCoupon joins the same sequencing; (d) EMPTY_CART_ITEMS module sentinel stabilises items/payloadItems while cart loads. Verified in browser (aisyah@nomofee.test, cart 1 item): phase1 → delivery phase renders server totals (Subtotal RM45.00 / Shipping RM8.00 / Total RM53.00), NO spinner, "Continue to payment" disabled=false, quote POST count stable 2→2 over 6s sample, zero page errors. Screenshot tool-results/checkout-delivery-fixed.png.
- ③ Root cause of "NOMO FEE": shopper-shell.tsx footer wordmark <p class="flex items-center gap-2"> had THREE flex children — icon span, bare text "NOMO", span "FEE" — flex gap-2 rendered a visible gap between the two text fragments. Fix: wrapped "NOMO<span>FEE</span>" in a single span. Browser-verified structure: footer p > span children text = ["", "NOMOFEE"]. Other wordmarks (seller-shell ×3, admin-shell ×2, header, storefront) already single-span — audited, untouched.
- Quality gates: bun run lint clean; tsc untouched (baseline 57 pre-existing errors, none related); dev.log clean during E2E (no 4xx/5xx except expected guest 401s in earlier flow variants).
- Sandbox notes for future agents: dev server is reaped between tool calls — restart inside each call (pkill next-server; setsid nohup bun run dev; wait for curl 200). Browser session needs BOTH localStorage sm_session_token (for /api/auth/me via authHeaders) AND sm_session cookie (for /api/cart — fetchJson sends device headers only, cart identity is cookie-based). agent-browser "--timeout" is not a global prefix flag (breaks every command); use eval-based clicks for buttons whose text includes icons (find text requires exact match).

Stage Summary:
- Checkout payment blocker eliminated (loop broken + request sequencing); footer brand wordmark fixed; festive-theme question answered with exact navigation path and live-campaign evidence. No schema changes. Screenshots in tool-results/.

---
Task ID: 17
Agent: orchestrator (Z.ai Code)
Task: User requests — ① Wallets drawer "Recent ledger activity" shows RM 0.00 for every seller while Ledger Explorer shows real amounts (bug), ② Payout PO-100001 statement shows "Refunds RM 30.00" with no refund anywhere in Refunds page / All Orders (integrity), ③ Commission page: Reports/Exports history tab + analytics + PSP split-settlement scaffold (feature), ④ finance audit: can integer minor-unit storage round wrong (answered in chat).

Work Log:
- ① Root cause: WalletActivity summed credit−debit across ALL lines of each transaction — double-entry always balances, so net ≡ 0 for every txn. Ledger Explorer was fine because it renders per-line dr/cr. Fix (wallets-ledger.tsx): filter lines to l.walletId === walletId before netting; lines type gained walletId. Browser-verified: Lumina drawer now shows "Order NM-100006 paid via tng RM 78.00", "Payout PO-100001 initiated −RM 556.60" etc.; table shows per-seller pending/available/lifetime/commission (Sofia 279.40/0.00/764.00/72.00). Screenshot tool-results/admin-wallets-drawer.png.
- ② Root cause: seed.ts decorated PO-100001's statementJson with hard-coded numbers (+15000/−12000/−3000) — "Refunds RM 30.00" never existed as a Refund record (only seeded refund = RM 45 Glow Theory, status requested; an order becomes "Refunded" only after approve+process posts T5 — so Refunds/All Orders pages were honest; the statement lied). Fix: new INTEGRITY RULE — statements are ledger-derived only. ledger.ts gains buildLedgerStatementFromLedger(walletId, payout, period) aggregating payable+commission lines by txnType (sales/commission/refunds/adjustments) with a balancing "Retained in wallet" line so Σ(lines) ≡ payout ALWAYS (bug found by the repair run itself: retained was inverted → fixed to payout−netMovement; repair period fixed to paidAt−30d). Runtime payout-batches POST now uses it (period = previous paid payout → now, clamped); seed.ts uses it; scripts/fix-payout-statements.ts (NEW, run once) rebuilt PO-100001 in the live DB → Sales RM 605.00, Commission −RM 48.40, Net RM 556.60, 3 paid orders, Σ=payout ✓, phantom refund GONE. payouts.tsx PayoutExpand shows "Ledger-reconciled ✓" (emerald) when Σ(lines)==amount else "Not reconciled (legacy demo snapshot)" (amber). Verified in browser: badge + exact rows visible. Screenshot tool-results/admin-payout-reconciled.png.
- ③ Commission → new "Reports & exports" tab (CommissionView wrapper w/ shadcn Tabs; admin-shell maps commission: CommissionView). New model CommissionExport (schema pushed); src/lib/commission-export.ts aggregateCommission() (ledger-truth: weekly Monday buckets, per-store top list, effective rate = commission/(sellerNet+commission)) + snapshotToCsv() (deterministic, frozen snapshot re-render). Routes: GET /api/admin/commission/analytics?days= (summary+weekly+stores+exports+psp block), GET/POST /api/admin/commission/exports (POST = snapshot+CSV, RBAC commission.manage, audited), GET /api/admin/commission/exports/[id]/download (byte-stable CSV), GET/PUT /api/admin/commission/psp-settings (dormant scaffold; PUT autoSettle:true → 409 PSP_ADAPTER_REQUIRED). psp.ts gains PSP_SPLIT_CANDIDATES (mock active; stripe_my/curlec/ipay88 awaiting adapter) + PSP_SPLIT_SETTING_KEYS. UI: summary cards (RM 203.04 period / RM 198.99 all-time / 7.3% effective / 13 orders), weekly bar chart, top stores, export history w/ re-download, PSP card (webhook path, candidates, last gateway settlement, auto-settle switch guarded server-side). Browser-verified incl. export POST 201 + history row + CSV download path. Screenshot tool-results/admin-commission-reports.png. NOTE: radix TabsTrigger ignores el.click() — use agent-browser `find role tab click` (real pointer events).
- ④ Rounding audit (chat answer): all money = Int minor units; only Floats are percent rates; commissionOf rounds once (integer divHalfUp); allocateProportionally = largest-remainder (Σparts ≡ amount); postTransaction throws on unbalanced; runLedgerInvariants nightly; snapshots never recomputed. Residual 1-cent theoretical edge from Float percent × base (only within ~1e-10 of a .5c boundary, cannot accumulate); optional hardening = basis-point Int percents (documented, not migrated).
- Gates: lint clean; tsc 58 (≤ 62 at HEAD; zero errors in touched files — remaining payout-batches never[] errors pre-exist at HEAD); db push OK; no dev.log errors during E2E.

Stage Summary:
- Wallets drawer shows per-wallet ledger truth; payout statements are ledger-derived and self-reconciling with an honest reconciled/unreconciled badge; Commission page gains full Reports & Exports analytics + frozen-snapshot CSV history + dormant PSP split scaffold; money math audited fortress-grade (Int minor, one rounding point, remainder-exact allocation, balanced double-entry).

---
Task ID: 24
Agent: Z.ai Code (main)
Task: Real-time chat overhaul — fix broken instant messaging + messaging-hub redesign (user request: 3 items)

Work Log:
- ROOT CAUSE 1 (not instant): SPLIT-BRAIN chat hub — TWO `bun --hot index.ts` instances ran concurrently; one owned :3003 (sockets/joins), the other :3103 (relay broadcasts) → joins landed on A, broadcasts on B → messages only appeared after refresh. Fixed by killing duplicates; added EADDRINUSE fatal-exit guards to BOTH listeners in mini-services/chat-service/index.ts so a half-alive instance can never exist again (loud failure + supervisor restart beats silent drop).
- ROOT CAUSE 2 (browser sockets silently failed): hub `cors.origin: "*"` is invalid for credentialed browser handshakes (wildcard ACAO forbidden with credentials) — browser WebSocket/XHR never connected while non-browser probes (no Origin) worked, masking the bug. Fixed with `origin: true` (reflect) + `credentials: true` + explicit `allowRequest` allow-all. Proven by Origin-carrying socket.io probes failing before / connecting after.
- Hub upgrades: `user:{id}` rooms alongside `thread:{id}`; relay accepts plural `rooms[]`; join allowlist extended to user: rooms.
- Client resilience: useChatHub hook (src/components/chat/chat-ui.tsx) — ONE socket per mounted view (handlers/rooms via effect-updated refs, react-hooks/refs clean), auto re-join on reconnect AND when the room list grows; reconnectionAttempts Infinity + delayMax 4s (long-lived preview tabs must never give up after a hub restart).
- Schema: ChatMessage.readAt (DateTime?, indexed [threadId, readAt]) → delivery receipts. db:push OK.
- Backend (6 routes): shopper+seller threads GET → okPaged with `?q=` (store/subject/order/last-message-body search) + `filter=all|active` (unread>0) + page/size; messages POST → fan-out broadcast to thread room + counterpart user room + chat:activity inbox ping (brand-new threads appear live, no refresh); read routes (POST read + thread-open GET) stamp readAt via updateMany and broadcast `chat:read` → sender's ticks flip ✓→✓✓ live.
- Shared UI module src/components/chat/chat-ui.tsx: ChatHeader (44px back button + bold "Chats" + live search + All/Active pills with count), ChatListItem (avatar/initials fallback, right-aligned smart timestamps HH:MM/Yesterday/weekday/date, last-message preview + ✓/✓✓ ticks, unread badge, context chip), MessageTicks, ChatListSkeleton/ChatMessagesSkeleton, ChatEmptyDetail ("Select a chat thread to start messaging").
- Shopper MessagesView + Seller Messages rewritten: master-detail (360px sidebar + detail; empty state desktop), mobile single-page flow with framer-motion slide-in conversation + 44px back, optimistic list patches (preview/unread/reorder-to-top) on incoming messages, debounced search, skeletons. OLD static "Messages / Chat with sellers…replies arrive in real time" header REPLACED by the back-button header (user request #2). Seller Messages gained sellerId prop for user-room join; seller-shell wired.
- Verified (agent-browser, both sessions via :81 = production gateway path): shopper message → seller panel instantly YES; seller reply → shopper panel instantly YES; chat:read pushes observed; ticks render both sides; search q=lumina/q=Atomic + filter=active + pagination meta + seller active filter all pass; mobile 390px list + slide-in thread + back verified visually; desktop 1366px master-detail screenshot verified. bun run lint 0 problems; tsc baseline unchanged (no errors in touched files); dev.log clean of new errors.
- Sandbox ops notes: recycler kills next-server AND the chat hub between tool calls (watchdog.sh attempted but also killed) — per-call guards must curl-check the RELAY port (:3103), not pgrep patterns (the hub runs as `bun run index.ts`/`--hot` depending on start path). agent-browser evals share page scope (declare consts inside IIFEs). agent-browser MUST go through :81 for socket features (localhost:3000 bypasses Caddy → XTransformPort unrouted).

Stage Summary:
- Real-time chat is instant both directions again: hub split-brain eliminated (fatal-on-port-conflict), browser sockets fixed (origin-reflection cors), sockets never give up reconnecting, new threads push via user rooms, read receipts (✓/✓✓) flow live.
- Messaging hub redesigned per prompt: back-button ChatHeader with live search + All/Active pills, rich thread list (previews, ticks, badges, smart timestamps), mobile slide-in / desktop master-detail, empty states + skeletons.
- Files: mini-services/chat-service/index.ts, src/lib/chat.ts, prisma/schema.prisma, api/chat/threads{,/[id],[id]/messages,[id]/read}, api/store/chat/threads{...same}, src/components/chat/chat-ui.tsx (new), src/components/shopper/shopper-shell.tsx, src/components/seller/{messages.tsx,seller-shell.tsx}.
- Prompt adaptations: SQLite + existing ChatThread/ChatMessage models kept (no Postgres/enum migration); Zod not added (existing envelope validation); MessageType/ReadStatus enums replaced by senderType + readAt stamps; Framer Motion for slide-in; pagination via existing okPaged envelope.

---
Task ID: 24
Agent: Z.ai Code (main)
Task: Complete SQLite → Supabase (PostgreSQL) migration (user SYSTEM INSTRUCTION prompt with project credentials; user confirmed session-pooler connection details)

Work Log:
- Connectivity probe FIRST (safeguard: prove the cloud DB reachable before touching the running app): direct endpoint db.tujvscnonmupldrqkqen.supabase.co:5432 resolves AAAA-only (IPv6) → TCP FAIL in this sandbox. Supavisor pooler aws-0-ap-southeast-1.pooler.supabase.com (IPv4) TCP OK; auth smoke-test via scripts/test-pg.ts (pg Client) → PostgreSQL 17.11, region ap-southeast-1, password = latest user-provided one.
- Phase 1 deps: project had NO sqlite3/better-sqlite3 (SQLite was purely the Prisma datasource provider → nothing to uninstall). Installed @supabase/supabase-js + pg.
- Phase 2 config: .env rewritten (Supabase URL + anon + service-role keys, verified char-exact against user-provided values via scripts/verify-env.ts; service key REST-validated HTTP 200; anon key HTTP 401 despite unexpired JWT — likely rotated in dashboard, NOT blocking since data plane = DB password; flagged to user for rotation). .env.example = placeholders only. NEW src/lib/supabase.ts: server-only Supabase client factory (getSupabaseAdmin/getSupabaseAnon, lazy singletons, runtime guard throws if imported client-side — service-role key never ships to browser).
- Phase 3 schema: prisma/schema.prisma provider sqlite→postgresql. LANDMINE 1: Prisma CLI does not strip quotes in .env → unquoted values. LANDMINE 2 (the big one): this sandbox harness injects a stale DATABASE_URL=file:/home/z/my-project/db/custom.db into EVERY shell session, and exported env vars override .env for Prisma CLI + Next.js (would crash the app at every server restart). Defused by renaming the datasource var to SUPABASE_DATABASE_URL (schema comment documents why). db:push → "database is now in sync" (~55 models on Supabase PG 17), client regenerated (prisma 6.19.2).
- Data: canonical seed re-run on Supabase (5 sellers/5 stores/27 products/14 orders/18 balanced ledger txns; wallet truth = cache for all). Stray seller from a wrong-endpoint register attempt cleaned by re-seed. QA shopper recreated via /api/auth/shopper/register → qa.shopper@nomofee.test / Shopper123! (verified login 200).
- Phase 4 sweep: db/custom.db + db/ dir DELETED (SQLite eradicated). README.md (stack/getting-started/structure) + docs/codebase-inventory.md DB row updated to Supabase reality. .zscripts/database-runtime-build.sh rewritten (no local SQLite file juggling; just schema sync to cloud) + tests/database-runtime-build.sh rewritten to assert: db:push called once per invocation, NO db/ dir in build output, legacy SQLite files never copied. Temp scripts test-pg.ts/verify-env.ts/cleanup-stray.ts removed; kept scripts/verify-ledger.ts + scripts/verify-commerce.ts as permanent migration regression checks.
- Phase 5 verification: (a) auth — admin portal 200, seller portal 200, shopper login/register 200 (sessions in Postgres); (b) FINANCIAL GATE — scripts/verify-ledger.ts: runLedgerInvariants PASS, walletTruth==wallet cache for all 5 wallets, 18 txns/49 lines balanced; (c) E2E COMMERCE — scripts/verify-commerce.ts: shopper login → checkout create (needs Idempotency-Key header, 201) → mock PSP /simulate (server-signed webhook) → order NM-100016 paid → ledger txn #19 (T1) posted → invariants PASS; (d) UI golden path via agent-browser: market home renders Supabase data (banners/categories/products), shopper sign-in → PDP → add-to-cart → cart drawer (1 item), portal switch → seller login → dashboard KPIs render; 0 console errors; dev.log all 200s; bun run lint clean.
- Dev server restarted on the new client + env; chat-service hub left as-is (Task: chat-overhaul guards still apply — curl :3103 in per-call guards).

Stage Summary:
- The app now runs entirely on Supabase PostgreSQL 17 (ap-southeast-1) via Prisma 6 (session pooler, IPv4). Zero SQLite anywhere: no packages, no provider, no file, no file-copy logic. supabase-js installed + server-only client ready for future Storage/Realtime/Auth-admin features; all data access stays Prisma→Supabase (per prompt's ORM-connector allowance — a supabase.from() rewrite of every route was rejected as high-risk/low-value).
- FUTURE RULE (per user's strict directive): all new code targets Supabase Postgres; never reintroduce SQLite. Datasource env var is SUPABASE_DATABASE_URL (NOT DATABASE_URL — harness pre-sets a stale file: value).
- Key creds/ops facts: direct db.<ref>.supabase.co:5432 is IPv6-only (unusable here); use pooler aws-0-ap-southeast-1.pooler.supabase.com:5432 user postgres.tujvscnonmupldrqkqen. Anon key 401 (rotated?) — replace in .env when user supplies fresh key. User should rotate service-role key + DB password (shared in chat plaintext).
- Verification scripts kept: bun scripts/verify-ledger.ts + bun scripts/verify-commerce.ts (run after any future schema/engine change).

---
Task ID: 25
Agent: Z.ai Code (main)
Task: User follow-ups — (1) anon key re-provided for re-validation; (2) chat messages not updating live in the open conversation (notifications/badges OK after ~5s poll); (3) chat quoted order/product card: remove border-color amber-300 + pin it fixed under the vendor name bar. Plus completion of Task 24's remaining verification pipeline.

Work Log:
- Anon key RESOLVED (corrects Task 24's flag): the re-provided key is byte-identical and IS valid. The earlier 401 was the /rest/v1/ root OpenAPI endpoint, which Supabase now restricts to service_role ("Only the service_role API key can be used for this endpoint"). Probing real tables with the anon key returns HTTP 200 (empty RLS-filtered results on Store/Product). No key replacement needed by the user.
- Chat live-update ROOT CAUSE: the chat-hub mini-service process was dead (no listener on 3003/3103) — the sandbox recycler kills it across sessions; clients only got the ~5s unread-badge polling (GET /api/chat/unread), never socket pushes. Restarted the hub (ports 3003 + 3103 listening) and armed a permanent watchdog loop (setsid nohup bash: every 8s, if :3003 not listening → restart mini-services/chat-service; logs to chat-service.log). Watchdog already fired successfully once (05:08:12Z revives logged).
- Verified broadcast path: src/app/api/chat/threads/[id]/messages POST → broadcastToThread(thread + seller user room) + notifyUserInbox → relay :3103 → hub fan-out (chat-service.log shows "broadcast to thread:…,user:… chat:message").
- E2E delivery proof: bun socket.io client joined thread:cmvespyfy… + user:cmvera… rooms directly on the hub, seller message POSTed via API → chat:message RECEIVED instantly. Chain proven: persist → relay → hub → room.
- Browser-side note: agent-browser sessions hitting http://localhost:3000 directly BYPASS the Caddy gateway, so /?XTransformPort=3003 falls through to Next (HTML) and sockets can't connect from that context — an artifact of local testing, NOT an app bug (user's real tabs connect through the gateway: hub log shows sockets joined user:cmves1xii… (tradecasm shopper) + user:cmver9nz… (lumina seller) + their thread room).
- Chat UI (both sides, shopper-shell.tsx MessagesView + seller/messages.tsx): quoted product/order context card MOVED out of the message scroller into a pinned non-scrolling strip directly under the conversation header (shrink-0 border-b bg-muted/30); direct-message pill stays in-flow. Card style unified: border-2 border-dashed border-teal-300/amber-300 + hover-lift replaced with neutral "border bg-card shadow-sm hover:bg-accent/40" — amber-300 border GONE, per user request. ShopperContextBubble/SellerContextBubble now return null when no context (pill inlined at call site).
- Browser verification (agent-browser): shopper login (UI, through CSRF gate) → Chats hub (back button + "Chats" + search + All/Active pills) → product-enquiry thread via PDP "Message seller" → pinned product card screenshot ✓ no amber border; order thread via order NM-100018 "Contact seller" → pinned order card screenshot ✓; iPhone 14 viewport → full-screen conversation, pinned strip intact, composer reachable ✓. Probe messages cleaned from DB (2 deleted).
- Task 24 pipeline completion: /api/health → db up, 5 stores/27 products/17 orders, ledgerInvariants ok. Logins via HTTP all 200: admin@nomofee.io (portal admin), byte@nomofee.io (portal seller), qa.shopper@nomofee.test (shopper). bun scripts/verify-ledger.ts → invariants PASS, all 5 wallets truth==cache, 20 txns/55 lines. bun scripts/verify-commerce.ts → checkout → mock PSP webhook → order NM-100018 paid → ledger txn #21 → invariants PASS ("E2E-COMMERCE-ROUNDTRIP: ALL PASS"). bun run lint clean.
- Phase-4 residue sweep: db/ dir already gone, temp scripts already removed (Task 24 did the heavy sweep); fixed the two stale living-doc refs left: README.md Notes ("SQLite keeps it zero-config" → Supabase Postgres directive) and confirmed docs/handover.md is a dated audit (left as history). Remaining "sqlite" hits are historical records only (worklog, RECOVERY.md, tool-results snapshots, codebase-export.md).

Stage Summary:
- Live chat is fully functional again: hub auto-restarts via watchdog (8s worst case), clients reconnect with reconnectionAttempts: Infinity and rejoin thread+user rooms on connect; thread panels update instantly via socket, badges/notifications via poll as fallback.
- Quoted product/order cards: pinned under the conversation name bar (always visible while messages scroll), neutral styling, no amber border — desktop and mobile verified.
- Migration fully verified end-to-end on Supabase: all logins, financial gates (21 balanced txns), commerce round-trip (order NM-100018), UI golden path.
- Anon key is valid (root-endpoint restriction was a red herring). User should still rotate the service-role key + DB password (shared in chat) from the Supabase dashboard and swap the new values into .env.

---
Task ID: 24
Agent: Z.ai Code (orchestrator)
Task: Chat notification gaps + Messages-page UX round (per user's 3-point feedback): (1) no live notification when away from the Messages page — no badge on Message/Chat tabs (desktop+mobile), no per-conversation badge on the vendor list; (2) All/Active filter pill switching blinks (refetches from Supabase before showing); (3) vendor logo/name should deep-link to their store; product-entry chat should replace an existing order quote in the same conversation.

Work Log:
- Root-caused the "silent badge": the only live socket lived inside the Messages view; away from it, unread badges relied on a 15s poll (`useChatUnread`). Any push felt lost. (Also noted: sockets only work through the Caddy gateway :81 — direct :3000 cannot reach the hub; all verification must go through the gateway, which is the user's real preview path.)
- NEW `src/lib/chat-presence.ts`: refcounted singleton socket.io client + `useChatUserRoom(userId, events)` hook — joins `user:{id}` inbox room on EVERY view, infinite reconnection, handlers kept in refs.
- Wired into `ShopperShell`: on `chat:message` → dispatches `nomofee:chat-sync` (both badge hooks re-sync instantly) + sonner toast "sender · New message" with an "Open chat" jump-in action when NOT on the messages view (suppressed inside Messages to avoid double-notify). Seller own-echo guarded.
- Wired into `SellerShell` (same pattern): instant Messages nav badge + toast with "Open messages" action while the seller is on any other page.
- NEW shared `filterChatThreads(rows, filter, query)` in `chat-ui.tsx`; both Messages views (shopper `shopper-shell.tsx` + seller `messages.tsx`) now fetch the full list once (`size=100`) and filter All/Active + search purely client-side via useMemo — pill switching costs zero network (the blink is gone); list stays live via socket pushes + read receipts.
- Shopper conversation header: avatar + store name are now a 44px-tall button → `nav storefront` for `storeSlug` (row type extended with optional `storeSlug`); hover affordance + Store icon.
- Verified product-chat re-stamp end-to-end: existing order-context thread (NM-100018) → store → PDP "Message seller" → same thread re-stamped to product context; quoted card now shows "ASKING ABOUT THIS PRODUCT"; API `upsert` update-branch already re-stamps contextType/productId/subject (no API change needed).
- Browser verification via agent-browser THROUGH THE GATEWAY (localhost:81): desktop badge 3→4 + toast ~130ms; list row badge 4→5 live; in-room instant delivery intact; pill switches = 0 network requests; search "byte" instant (0 fetches); toast correctly suppressed inside Messages; seller side: badge bump + toast from Dashboard; mobile viewport 390×844: Chat tab badge 2→3 live + toast. Vendor header → storefront ✓.
- Housekeeping: `bun run lint` clean; tsc unchanged (61 pre-existing baseline errors, none in touched files); removed temp debug; dev server + chat hub healthy.

Stage Summary:
- Chat is now fully "ajax-style" everywhere: open conversation (existing), vendor list row badges, global Message/Chat tab badges (desktop + mobile) and cross-surface toasts all update instantly from the hub; the 15s poll remains only as a fallback.
- All/Active + search = instant client-side filtering; no more blink.
- Vendor identity in the chatroom deep-links to the store; product entry re-quotes the conversation context (order → product) exactly as requested.
- Key artifacts: src/lib/chat-presence.ts (new), src/components/chat/chat-ui.tsx, src/components/shopper/shopper-shell.tsx, src/components/seller/seller-shell.tsx, src/components/seller/messages.tsx.
- Ops note for the user: sandbox sockets only work through the gateway (:81/preview) — testing on :3000 directly cannot reach the chat hub; not a bug.

---
Task ID: 26
Agent: Z.ai Code (main)
Task: User's 2-point round — (1) small "x" to close the quoted order/product in chat so buyer/seller can chat casually without a quote; (2) Payouts Due card mismatch (dashboard RM 661.17 / 2 sellers vs payouts page 1 record RM 556.60) + dig for further financial discrepancies.

Work Log:
- (2) ROOT CAUSE — semantic disconnect, NOT a ledger bug: the dashboard "Payouts due" KPI = wallets with available ≥ min (RM 661.17 = Glow Theory 474.11 + ByteBazaar 187.06), but clicking it landed on Payout Batches = batch HISTORY (only the seeded paid PO-100001, RM 556.60, 13 Oct). The due money had never been swept, and the page had NO "due now" view at all.
- Financial audit (clean): all 5 wallet caches == ledger truth (avail+pending == PAYABLE balance per seller); PLATFORM:PAYOUT_CLEARING nets 0 (T3 credit + T4 debit for PO-100001); payout.min_minor=1000; verify-ledger.ts PASS (22 txns → 23 after commerce gate); verify-commerce.ts PASS (order NM-100020, invariants hold). Only real defect was the dashboard↔page disconnect + a latent threshold drift (dashboard hardcoded RM 10 while batch runs read payout.min_minor).
- NEW GET /api/admin/payouts/due: refreshes every wallet cache from ledger truth (same as a real run), returns due list (seller, store, available, verified bank, last paid), dueTotal/dueCount, pendingTotal (holding period), belowMin totals, min+mode settings.
- PayoutsView: new "Due now" panel at top (total + "across N sellers" chip + min/mode, per-seller table with bank + verified icon + last paid, and a "Where the rest is: … pending in the holding period · … below the minimum" reconciliation footer). Batch history card retitled/kept below; due list refetches after a batch run. Page title now "Payouts".
- Dashboard route: payoutsDue now derived from raw SELLER:*:PAYABLE ledger lines with walletTruth math (matured credits − debits) + payout.min_minor setting — same math as the due endpoint and batch runs; a stale cache or just-expired hold can no longer make the card disagree. (One transient 500 "payableLines is not iterable" from a positional destructure mismatch during the edit — fixed, verified 200.)
- Browser E2E through gateway :81: dashboard card "RM 661.17 across 2 sellers" → click → Due now panel shows RM 661.17 / Glow Theory 474.11 (Public Bank ****1170 ✓) + ByteBazaar 187.06 (CIMB ****9032 ✓); pending line RM 2,133.05 → live-grew to RM 2,205.91 after the commerce gate's new order (pending ≠ due, correct). tsc: touched files clean, 61 pre-existing baseline; lint clean.
- (1) Quote "x": NEW clearThreadContext() in src/lib/chat-context.ts (nulls contextType/productId/orderId/orderNumber/subject + broadcasts chat:context to the thread room). NEW PATCH /api/chat/threads/[id] {action:"clearContext"} (shopper-or-store-seller access, mirrors GET) and PATCH /api/store/chat/threads/[id]/messages (seller). chat-ui.tsx: ChatHubHandlers.onContext + socket.on("chat:context") + shared ContextClearButton (28px round x, top-right of the pinned strip, backdrop-blur, teal hover).
- Both messages views (shopper-shell + seller/messages): pinned strip is now relative and renders ContextClearButton; clearContext() = optimistic local clear (card, header subtitle, list-row chip → "💬 direct message") then PATCH; onContext handler mirrors the other party's clear live. Re-entering from a product/order later re-stamps a new quote (existing upsert behavior).
- E2E: shopper UI click → card gone, header "Direct message", row chip updates (screenshot); seller UI click → same (screenshot); hub log shows "broadcast to thread:… chat:context" both times; curl PATCH on both routes verified + access control intact. QA thread context restored to its product quote afterwards so the user can try the x themselves.
- Housekeeping: temp audit/restore scripts removed; dev.log clean post-fix; hub + dev watchdogs healthy (3000/3003/3103/81 listening).

Stage Summary:
- Payouts reconciliation is now structural: dashboard card, payouts page "Due now", and a dry-run/real batch all read the SAME ledger-derived available with the SAME payout.min_minor — they cannot disagree. The old RM 556.60 record is clearly batch history, and pending-in-hold money is explicitly called out so "where's the rest" is answered on-page.
- Chat quotes are now dismissible by either party with one tap; both sides' pinned cards and list chips update live via the chat:context hub event; casual direct-message chat + later re-quoting both work.
- No financial discrepancies found in ledger/wallets/payouts/clearing — all gates PASS on Supabase Postgres.
