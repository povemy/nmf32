# Blueprint Support 04 — Database Schema & Data Model (Part F)

Source: full read of `prisma/schema.prisma` (1,215 lines) + live read-only DB verification (Python sqlite3 `mode=ro`; `sqlite3` CLI unavailable). Labels [V]/[I]/[P].

## F.1 Overview

- **76 models, 0 enums** (SQLite+Prisma: enums are Strings + app-level validation). IDs: `String @id @default(cuid())` except `CommissionSetting.id Int` and `Counter.key String`. Every model has `createdAt`; most `updatedAt`. JSON = `String` columns (helpers `json.ts`; 21 files still raw-`JSON.parse`). [V]
- **Money columns are Prisma `Int`** (int32, ceiling 2^31−1 sen ≈ RM 21.47M; SQLite itself stores 64-bit). Since 2026-10-18 (Task 3-a, FIN-09) every write boundary is guarded by `assertInt32Safe` (`money.ts`): all ledger posting recipes (T1–T6 line + txn totals) and checkout order/group/item totals throw `Money overflow: <field>=<n> sen exceeds Int32 max` (checkout surfaces 400 `MONEY_OVERFLOW`) instead of persisting an out-of-range value. Widening to BigInt columns is deferred to the PostgreSQL migration plan — no schema change this round. [V]
- **Live DB**: 77 tables (76 + `sqlite_sequence`); `_prisma_migrations` **absent** (no migration ledger — workflow is `prisma db push`, `package.json:10` with `--accept-data-loss`). [V]
- Row counts at inspection: Store 5, Seller 5, Product 27, Order 15, OrderItem 21, LedgerTransaction 19, LedgerLine 52, Wallet 5, PaymentIntent 14, PaymentGroup 1, Refund 1, PayoutBatch 1, Payout 1, CommissionExport 2, FeeHoliday 1, FinMigrationBackup 31, Session 7, ShopperUser 3, Voucher/Campaign/Shipment/ShopperWallet 0 (seed-me/vouchers/campaigns outputs absent from live DB). [V]

## F.2 Model catalogue (grouped; key fields only — full DDL in schema.prisma)

### Identity & Access (10)
| Model | Purpose | Key fields/constraints |
|---|---|---|
| `AdminUser` | Back-office login | email @unique; role dft "ops" (superadmin/ops/finance/moderator); passwordHash; isActive |
| `Seller` | Vendor account | email @unique; status lifecycle `onboarding→pending_review→active|rejected|suspended|terminated`; riskTier; **commissionOverrideBps Int?**; holdDaysOverride; kycStatus; planCode dft "free" |
| `ShopperUser` | Buyer account | email/username @unique; membershipLevel dft "SILVER"; status |
| `Session` | DB-backed sessions | token @id (cuid per schema; runtime uses 64-hex), userType(admin/seller/shopper), userId **polymorphic no-FK**, expiresAt |
| `KycDocument` / `SellerNote` | KYC + admin notes | FK sellerId (no onDelete) |
| `BankAccount` | Payout destination | accountNumberMasked + **accountNumberEnc (enc-prefixed last-4 only)**; verified |
| `Address` | Shopper addresses | ownerToken + shopperId? (Cascade) |
| `ApiKey` | Store API keys | hash + scopesJson; revokedAt |
| `Wallet` / `ShopperWallet` | Balances | sellerId/userId @unique 1-1; **pending/available/reserved/lifetimeEarned/lifetimeCommissionMinor Int dft 0** (derived caches); payLater* dormant scaffold; coinBalance Int (coins ≠ money) |

### Catalogue (10)
| Model | Key fields/constraints |
|---|---|
| `Store` | sellerId? @unique 1-0..1; slug @unique; status draft/live/suspended; currency MYR; themeJson; **fsPriceAdjustMinor Int** (seller FS cost-recovery display) |
| `Category` | parentId self-FK; slug @unique; **commissionBps Int?** |
| `Product` | storeId FK (NO ACTION); slug; status `draft/pending_review/active/rejected/banned`; **priceMinor Int**; **commissionBpsOverride Int?**; ratingAvg **Float** (only non-audit Float; non-money); sourcePlatform/sourceShopId/sourceProductId (import provenance); **@@unique([storeId,slug], [storeId,sourcePlatform,sourceProductId])** |
| `ProductVariant` | productId Cascade; **priceMinor Int** (no default); compareAtPriceMinor?; stock; lowStockThreshold |
| `ProductImage` / `InventoryLog` / `Review` (orderId no FK) / `Collection`+`CollectionProduct` / `CmsPage` (draftJson/publishedJson + draftVersion/publishedVersion) / `SeoMeta` (polymorphic @@unique) |

### Cart / Checkout / Orders (13)
| Model | Key fields/constraints |
|---|---|
| `Cart`/`CartItem` | token @unique; shopperId? @unique; storeId no-FK |
| **`Order`** | storeId FK (NO ACTION → store delete strands orders); **orderNumber @unique**; status `payment_pending/paid/processing/shipped/delivered/completed/cancelled/refunded/partially_refunded`; **subtotal/discount/shipping/tax/totalMinor Int**; idemKey? @unique; paidAt..cancelledAt; **holdDays Int? — payout hold resolved by the commission engine at checkout (CommissionOverride.holdDays > Seller.holdDaysOverride > global; null = legacy order → webhook keeps the old fallback)** (FIN-01 R1, additive 2026-10-18); voucherId? FK; paymentGroupId? FK; @@index([shopperId],[paymentGroupId]) |
| **`OrderItem`** | orderId Cascade; productId?/variantId? nullable no-cascade (survives deletion); **unitPriceMinor/lineSubtotalMinor/discountMinor/shippingMinor/commissionBps (Int, FROZEN snapshot per schema comment :595-597)/commissionMinor/fixedFeeMinor/sellerNetMinor/refundedMinor**; breakdownJson |
| `OrderStatusHistory` | from/to status + actor |
| `PaymentIntent` | orderId Cascade; **providerRef @unique**; amountMinor; status |
| `PaymentGroup` | ref @unique; shopperId Cascade; **idemKey? @unique**; subtotal/discount/shipping/totalMinor; expiresAt; redirectUrl |
| `PaymentWebhookLog` | provider/providerRef/eventType; payloadJson; signatureValid/processed; orderId no-FK; **no unique key** |
| `Shipment`/`ShipmentEvent` | orderId @unique; status literal set incl. `PENDING_BOOKING…RETURNED`; awbNumber |
| `Coupon`/`CouponRedemption` | code @unique; type percent/fixed/freeship; **percentBps Int?** (converted from legacy `percent`); amountMinor/minSpendMinor; redemption stores discountMinor + customerEmail (denormalised) |

### Payments / Finance (9)
| Model | Key fields/constraints |
|---|---|
| `Plan` | code @unique; monthlyFeeMinor; **commissionBps Int?** (schema comment :15) |
| `CommissionSetting` | singleton id Int=1; **defaultBps Int dft 800**; appliesToShipping dft false; basePriceRule paid_price/list_price; fixedFeeMinor; minCommissionMinor; payoutHoldDays dft 7; holdReleaseRule; graceDaysAfterDelivered |
| `CommissionOverride` | scope; categoryId?/sellerId?/productId? (loose strings, **no FKs**); **bps Int?**; **fixedFeeMinor? / holdDays? — APPLIED by the winning row since FIN-01 R1 (2026-10-18): fee replaces the per-order global fixed fee, hold wins over Seller.holdDaysOverride; out-of-range stored values are IGNORED with audit flags (`applyOverrideFields`), the admin API validates 0..MONEY_INT_MAX / 0..3650**; validFrom/To; isActive |
| **`FeeHoliday`** | name; scope all/categories/sellers; scopeIds?; **bps Int dft 0 — the commission rate CHARGED during the window (0 = full fee holiday)**; startsAt/endsAt; isActive. ~~Stale schema comment claimed engine grants full holiday~~ **FIN-07 RESOLVED 2025-10-18**: comment corrected to charged-rate semantics, matching `commission.ts:79-92` (engine applies h.bps clamped ≤ normal) |
| **`CommissionExport`** | periodFrom/To; totalMinor; orderCount/lineCount; format csv; **snapshotJson** (v1 rows carry `summary.effectiveRatePct` percent-float; v2 rows carry `schemaVersion:2` + bps — discriminator **inside** snapshotJson, no columns) |
| `LedgerAccount` | **code String @id**; type; walletId? (per-wallet subaccounts) |
| `LedgerTransaction` | txnType `order_paid/gateway_settlement/refund/admin_adjustment/payout_initiated/payout_confirmed/payout_failed`; refType?/refId? — **no unique on (txnType,refType,refId) ⇒ idempotency is app-level only** |
| `LedgerLine` | txnId Cascade; accountCode (**no FK to LedgerAccount**); direction debit/credit; **amountMinor**; walletId?; availableAt? (hold maturity) |
| `PayoutBatch`/`Payout` | batch: runType/status/totalMinor/payoutCount; payout: **referenceNo @unique** (`PO-…`); amountMinor; status processing/paid/failed; method manual_csv; bankAccountId?; **statementJson** |
| `Refund` | orderId Cascade; amountMinor; status requested/approved/rejected/processed; requestedBy; restock dft true; **commissionReversalMinor** |

### Marketing / Support / Platform (18)
`Campaign` (no unique name), `Voucher` (code @unique; kind discount/freeshipping/coinsback; **discountMinor**; **percentOff Int? — residual whole-percent unit, deliberately not bps**; scope PLATFORM|STORE; regionLimit; quota), `UserVoucher` (@@unique; AVAILABLE/USED/EXPIRED), `MarketplaceBanner`, `FeaturedSlot`, `Notification`, `UserActivity` (@@unique LIKE/VIEWED), `StoreFollow` (@@unique), `SupportTicket`+`SupportMessage` (storeId no-FK), `Announcement`, `ChatThread` (@@unique([shopperId,storeId])) + `ChatMessage`, `NotificationTemplate` (@@unique event+channel) + `NotificationLog`, `Setting` (key @id), `FeatureFlag` (key @id, rolloutPercent), `AdminAuditLog`, `ActivityLog`, `Counter` (key @id; order_number, payout_number), **`FinMigrationBackup`** (migration/table/rowId/field @@unique; **oldValue Float (legacy percent) / newValue Int (bps)** — audit anchor, intentional Float), `ExportJob`, `MarketplaceConnection` (@@unique platform+shopId; accessTokenEnc/refreshTokenEnc sealed), `ImportJob` (trackingToken @unique; isFixture) + `ImportJobItem`, `StoreClaim` (**tokenHash @unique**), `StoreDomain` (domain @unique), `StoreIntegration`, `WebhookEndpoint` (**secret plaintext**) / `WebhookDelivery`.

## F.3 Money & rate storage map (complete)

**Post M-FIN-1: zero Float/Decimal money or rate columns remain** in live tables. Convention: money = Int sen (minor units); rates = Int bps (`BPS_DENOM=10_000`, `src/lib/money.ts:53`). [V]

| Field(s) | Unit | Note |
|---|---|---|
| `Plan.monthlyFeeMinor` / `Plan.commissionBps` | sen / bps | |
| `CommissionSetting.defaultBps/fixedFeeMinor/minCommissionMinor` | bps / sen / sen | singleton |
| `CommissionOverride.bps/fixedFeeMinor` | bps / sen | dead config (FIN-01) |
| `FeeHoliday.bps` | bps | **rate charged during window**; 0 = full waiver |
| `Seller.commissionOverrideBps`, `Category.commissionBps`, `Product.commissionBpsOverride` | bps | engine chain (product→category→seller→global) |
| `Order.{subtotal,discount,shipping,tax,total}Minor` | sen | 5 columns |
| `OrderItem.{unitPrice,lineSubtotal,discount,shipping,commission,fixedFee,sellerNet,refunded}Minor` | sen | frozen at create |
| `OrderItem.commissionBps` | bps | frozen snapshot, never recomputed |
| `PaymentIntent.amountMinor`, `PaymentGroup.{subtotal,discount,shipping,total}Minor` | sen | |
| `Refund.amountMinor/commissionReversalMinor` | sen | |
| `Wallet.{pending,available,reserved,lifetimeEarned,lifetimeCommission}Minor` | sen | **derived caches** of ledger truth |
| `LedgerLine.amountMinor`, `Payout.amountMinor`, `PayoutBatch.totalMinor` | sen | |
| `Coupon.percentBps/amountMinor/minSpendMinor`, `CouponRedemption.discountMinor` | bps / sen | |
| `Voucher.discountMinor/maxDiscountMinor/minSpendMinor` | sen | |
| **`Voucher.percentOff`** | **whole percent 1..90** | the only percent-typed rate left; guarded ×100 conversion (`vouchers.ts:122`) |
| `ShopperWallet.balanceMinor/payLater*/coinBalance` | sen / coins | dormant |
| `Store.fsPriceAdjustMinor` | sen | display only |
| `CommissionExport.snapshotJson` | mixed | v1 percent-float vs v2 bps, discriminator inside JSON |
| `FinMigrationBackup.oldValue/newValue` | percent Float / bps Int | audit-only |
| `Product.ratingAvg` | Float | non-money |

## F.4 Seeds

| Seed | Destructive? | Contents |
|---|---|---|
| `prisma/seed.ts` (866 ln) | **YES — wipes 60+ models children-first** (deliberately preserves FinMigrationBackup; **omits CommissionExport**, so export snapshots survive reseeds) | Plan free (800 bps); CommissionSetting id=1; 7 settings + 5 flags; 4 AdminUsers (admin@nomofee.io superadmin + demo password — not reproduced); 8 categories (bps 600–1000); 5 sellers/stores + wallets + CMS pages + KYC + banks; 27 products; **14 orders NM-100001..NM-100014** (13 with ledger); **1 Refund RM4,500 status requested** (Glow Theory) + 1 Dispute; **PayoutBatch + Payout referenceNo "PO-100001"** amount = min(available, RM2,000.00)=55,660 with **ledger-derived statement**; FeeHoliday "Merdeka F&B" (categories, bps 0); CommissionOverride (seller, 1000 bps); templates/integrations/webhooks/tickets/announcement/audit logs; Counter |
| `seed-me.ts` | no (upserts) | 8 platform vouchers (**uses `percentOff`**), demo shopper aisyah@nomofee.test wallet (balance RM128.40, coins 1,250, dormant payLater), UserVouchers/activity; **skips silently if shopper absent** (seed.ts never creates shoppers) |
| `seed-vouchers.ts` | no (repair-only) | 4 STORE vouchers (LUMINAFS/LUMINA12/BYTE15/GLOWRM10); never resets claimedCount/holders |
| `seed-campaigns.ts` | no (upsert by name) | Raya Mega Sale (published) + 12.12 (draft) |

**PO-100001 provenance (resolved)**: the historic "Refunds −RM 30.00" line was **hard-coded decoration in the OLD seed** with no Refund row behind it; `scripts/fix-payout-statements.ts:4-8` documents the lie; statements are now ledger-derived (`buildLedgerStatementFromLedger`), and the live PO-100001 statement (`Sales +60,500 / Platform commission −4,840 / retained 0`, Σ=55,660 ≡ payout) contains **no refunds line**. Current seed creates exactly one Refund (RM45, unrelated to the payout, status `requested`, no T5). [V]

## F.5 Integrity & anomaly observations

1. **No DB CHECK constraints** (SQLite+Prisma): bps ranges 0..10,000 and `direction ∈ {debit,credit}` enforced only app-level (`fin-reconcile` section A polices live data). [V]
2. **FK actions mostly NO ACTION** — deleting a Store strands Orders; `LedgerLine.accountCode` has **no FK**; polymorphic refs (Session, SeoMeta, Review.orderId, PaymentWebhookLog.orderId, LedgerAccount.walletId) unenforceable; CouponRedemption has no FKs. Cascades exist on the shopper-side graph. Product deletion is "archive" (isActive=false) in practice, which mitigates. [V]
3. **Good business-key uniqueness**: orderNumber, Payout.referenceNo, PaymentIntent.providerRef, PaymentGroup.ref/idemKey, Order.idemKey, voucher/coupon codes, claim tokenHash, FinMigrationBackup natural key. **Missing**: LedgerTransaction idempotency key; Campaign.name. [V]
4. **Transaction boundaries**: `$transaction` in only **7 route files** (checkout/create, auth/register, claim/bind, checkout/addresses ×2, store/inventory/adjust, store/collections/[id]/products). **Non-transactional**: webhook success (status→T1→notifications), refund process (T5+order+item+restock+refund), payout batch loop, mark-paid/fail, variant+price recompute. Ledger postings themselves are atomic (nested create) with in-app balance validation (`ledger.ts:63-72`). [V]
5. **Secrets at rest**: passwordHash (scrypt), ApiKey.hash, BankAccount.accountNumberEnc (enc-prefixed last-4 only), MarketplaceConnection tokens AES-256-GCM sealed, WebhookEndpoint.secret **plaintext**, Session tokens **plaintext**. [V]
6. **Integer-width caveat**: all money columns are Prisma `Int` (nominally 32-bit ≈ RM21.47M) though SQLite stores 64-bit; engine math is BigInt-safe in memory but persistence past 2^31 sen is untested (FIN-09). [P]
7. `db push --accept-data-loss` + no migration ledger ⇒ schema history lives only in worklog + FinMigrationBackup (Support 09 §P). [V]
