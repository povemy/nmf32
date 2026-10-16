# RECOVERY BRIEF — read this FIRST (all rebuild agents)

## What happened
A sandbox rollback reset the source tree to the **Task 9 era**. Everything built in
Task 10 / 10-a..10-e / 10-v / 11 / 12 was lost from disk AND git. The **SQLite DB
schema has been fully rebuilt** (prisma db pull + manual upgrade + `db push`) —
prisma/schema.prisma now contains ALL models the lost code used (Shipment,
ShipmentEvent, StoreFollow, Notification, Campaign, upgraded Voucher/UserVoucher,
Order.voucherId, Store.fsPriceAdjustMinor, OrderStatusHistory). Prisma client is
regenerated. **DB data is Task-9-era** (old emails @shopmesh.io/.test, SM- order
numbers) — seeds must keep working against it.

Your job: rebuild the lost code to the documented spec below. The DB schema is
ground truth for field names. Match the old platform's established conventions:
- API helpers: `import { handle, ok, fail, ApiError, getPagination, okPaged, transitionOrder, logActivity, dispatchStoreWebhooks, notify } from "@/lib/api"` (read src/lib/api.ts first).
- Auth: `requireShopper()` / `requireActiveSellerStore()` / admin RBAC via src/lib/auth.ts (roles: superadmin/ops; permission strings like "campaigns.manage").
- Money = Int minor units. `formatMinor` in src/lib/money.ts. Timezone Asia/Kuala_Lumpur.
- Frontend: shadcn/ui + Tailwind 4, teal brand (bg-brand-gradient-deep for CTAs), 44px touch targets, mobile-first, NO indigo/blue.
- ESLint must pass (`bun run lint`) — run it on the files you touched.

## The 6-feature roadmap these tasks implement (user-approved, priority order)
① Smart logistics & returns (FIRST PRIORITY) ② buyer trust ③ smart discovery
④ seller growth assistant ⑤ centralised after-sales buyer protection
⑥ retention tools.

---
## TASK 10 — Smart shipping & fulfilment layer (spec)
**Schema (already in DB):** `Shipment` (orderId unique, providerId default "mock",
status PENDING_BOOKING→BOOKED→PICKED_UP→IN_TRANSIT→OUT_FOR_DELIVERY→DELIVERED/EXCEPTION/RETURNED,
awbNumber, courierName, labelUrl, etaFrom/etaTo, deliveredAt, events[]) and
`ShipmentEvent` (shipmentId, status, description, location, occurredAt, proofImageUrl?).

**src/lib/shipping.ts (NEW)** — provider abstraction `ShippingProvider` with a
**mock Malaysian courier network** (mock provider id "mock"):
- `quoteRates(parcel, dest)` → 2–3 MY courier options (e.g. Pos Laju, J&T, City-Link)
  each {providerId, courierName, serviceLevel, priceMinor, etaFrom, etaTo} — deterministic
  pricing by weight bands + destination zone (peninsular vs east-malaysia surcharge).
- `bookShipment(order)` → creates Shipment (BOOKED) + AWB number like `PLJ` + digits,
  generates label (SVG data-URL or /api shipping label route), first ShipmentEvent BOOKED.
- `syncTracking(shipmentId)` → advances the mock state machine one realistic step
  (BOOKED→PICKED_UP→IN_TRANSIT→OUT_FOR_DELIVERY→DELIVERED) writing ShipmentEvent rows
  with plausible MY locations/timestamps; on DELIVERED attach a deterministic mock POD
  photo URL (`mockPodUrl(awb)` — serve via /api/img placeholder pipeline or an inline
  SVG data-URL) and set shipment.deliveredAt + order.deliveredAt + order status
  "delivered" (via transitionOrder if available) + OrderStatusHistory row.
- `fastForwardDelivery(orderId, deliveredAt, proofUrl?)` — used when a seller marks
  delivered manually mid-simulation: backfill skipped milestone events inside
  [bookedAt, deliveredAt], append DELIVERED event with proof, flip statuses. Keep event
  order sane (never OUT_FOR_DELIVERY after DELIVERED).

**APIs (NEW):**
- `POST /api/store/orders/[id]/ship` — EXTEND the existing manual route: body
  `{mode:"platform", providerId, rateId}` books via lib/shipping (quotes stored from
  prior quote call) OR legacy `{mode:"manual", provider, trackingNumber}` (keep working).
  Order → "shipped" + shipmentStatus surfaced.
- `GET /api/store/orders/[id]/label` — AWB label download (PDF or SVG stream).
- `GET /api/store/shipping/quote?orderId=` — rates for the seller ship dialog.
- `POST /api/shipping/tick` (or internal sweep in existing cron-ish spot) — advances
  all BOOKED+ mock shipments one step; call it opportunistically from GET buyer
  tracking endpoints (lazy sync: sync the order's shipment when the buyer opens the
  timeline, if lastSyncedAt older than ~45s in dev) so the demo advances without cron.
- Buyer tracking: `GET /api/me/orders/[orderNumber]` (EXTEND existing) returns
  `shipment: {status, courierName, awbNumber, etaFrom, etaTo, events:[{status,
  description, location, occurredAt, proofImageUrl}]}` + top-level
  `shipmentStatus`, `shippingCourierName`, `trackingNumber`.
- Buyer list `GET /api/me/orders` items already carry imageUrl? (NO — that was lost):
  add per-item first-image `imageUrl`, plus order-level `shipmentStatus`,
  `shippingCourierName`, `trackingNumber` for card chips.
- Returns: buyer `POST /api/me/orders/[orderNumber]/return-request` (reason, type
  refund|return; store as Dispute rows — Dispute model exists) + buyer-visible status.

## TASK 10-a — Order completion flow (spec)
- `POST /api/me/orders/[orderNumber]/receive` — buyer confirms receipt:
  allowed from "shipped" OR "delivered" → status "completed", completedAt now,
  OrderStatusHistory {from, to:"completed", actorType:"shopper", note}. Repeat → 409
  VALIDATION. payment_pending → 409. Must scope by session shopperId (404 otherwise).
- `POST /api/me/orders/[orderNumber]/reorder` — one-tap re-order: for each item add
  qty to the shopper's active cart for that store (merge rule: newQty = min(99,
  cartQty + itemQty, stock)); respond `{added:[{title,qty}], skipped:[{title,reason}]}`
  with reasons: "Out of stock", "Already at the maximum in your cart", "No longer
  available" (variant/product deactivated). Restore stock checks from Product/Variant.
- `POST /api/store/orders/[id]/deliver` — seller marks delivered: allowed from
  "shipped" → status "delivered", deliveredAt=now, OrderStatusHistory actor seller;
  accepts `{proof?: dataURL image ≤1.2MB, note?}`; calls fastForwardDelivery when a
  platform shipment exists (proof attached to DELIVERED event). Wrong state → 409
  INVALID_STATUS; other store's order → 404 NOT_FOUND.
- Auto-complete sweep: any "delivered" order with deliveredAt older than 14 days →
  "completed" with history {actorType:"system", note:"Auto-confirmed 14 days after
  delivery"} — implement as a lazy sweep inside GET /api/me/orders and
  GET /api/store/orders (cheap WHERE + update, guarded by a 60s in-memory throttle).
- Buyer UI (Wave 2): "Order received" button on order detail + purchases card for
  shipped/delivered; "Buy again" (calls reorder → toast summary + open cart).

## TASK 10-b — Claimable voucher engine backend (spec)
Schema fields already added (see schema.prisma): Voucher.scope/storeId/regionLimit/
quota/claimedCount/startsAt, UserVoucher.usedOrderId, Order.voucherId,
Store.fsPriceAdjustMinor.
- `src/lib/vouchers.ts` (NEW): verdict engine.
  - kinds: `discount` (flat discountMinor XOR percentOff with maxDiscountMinor cap)
    and `freeshipping` (zeroes the group shipping; seller-funded:
    Store.fsPriceAdjustMinor records the seller's FS price-adjust option).
    `coinsback` → invalid platform-wide (NOMO_FINANCE disabled, feature-flags.ts).
  - `regionLimit="peninsular"`: FS voucher only valid when the delivery address is
    West Malaysia (address state list in lib; Sabah/Sarawak/Labuan → invalid with
    clear reason).
  - validate(voucher, groupSubtotalMinor, addressState, storeId?) →
    {valid, reason?, discountMinor} — minSpend, expiry (expiryAt), isActive, scope
    (PLATFORM anywhere / STORE only that store's group), quota/claimedCount.
- `GET /api/me/vouchers` → `{mine:[{...userVoucher, voucher:{...}, claimedByMe:true,
  status}], center:[pool vouchers with store brief {name,slug,logoUrl}, claimedByMe,
  quotaRemaining]}` (paged-friendly).
- `POST /api/me/vouchers/claim {code|voucherId}` → 201 + UserVoucher AVAILABLE;
  409 ALREADY_HELD if held; 409 QUOTA_EXHAUSTED; 404 unknown/inactive/expired.
- `POST /api/store/vouchers` (seller) — create store-scope voucher: validation
  discount flat XOR percent (1..90, optional cap); FS vouchers forced
  regionLimit="peninsular"; auto code unique; 409 on duplicate code.
- `GET /api/store/vouchers` → `{vouchers:[...], fsPriceAdjustMinor}` for seller panel.
- Checkout integration: `POST /api/checkout/quote` (extend existing quote or add) —
  accept `{storeId, userVoucherId}` per payment group; run verdict; on valid
  discount → group discountMinor += voucher discount (cap at subtotal); freeshipping
  → group shippingMinor = 0; mark nothing yet. On order create (`/api/checkout/create`)
  with voucher: atomically set UserVoucher USED (usedAt, usedOrderId), claimedCount+1,
  Order.voucherId + discountMinor applied. Idempotent per order.

## TASK 10-e — Campaign engine (spec)
- `src/lib/campaigns.ts` (NEW): `CampaignThemeT` + `DEFAULT_CAMPAIGN_THEME` +
  `parseCampaignTheme` (per-field safe defaults, hex-validated) +
  `validateCampaignTheme`; `CAMPAIGN_PRESETS` — 10 Malaysian festive/mega-sale
  entries: Hari Raya Aidil Fitri (#10B981), CNY (#DC2626 + gold accents), Deepavali
  (#7C3AED), Merdeka (#16A34A), Malaysia Day (#DC2626), Ramadan Early-Bird (#0F766E),
  9.9 (#E11D48), 10.10 (#D97706), 11.11 (#EA580C), 12.12 (#DB2777) — EN + light BM
  copy each; lunar/festival presets carry exact date windows for 2025 AND 2026
  (Raya/CNY/Deepavali/Ramadan), others month/day windows; `presetDateRange` returns
  the nearest upcoming occurrence (handle year wrap + end-of-day 23:59:59.999);
  `campaignStatusOf` (draft/scheduled/live/ended), `daysUntil`,
  `resolveActiveCampaign` (isPublished && startAt<=now<=endAt, latest startAt first,
  60s in-memory cache stored on **globalThis** — Turbopack duplicates module instances
  per route; lazy `await import("./db")` so client components can import presets),
  `invalidateCampaignCache()` called by every admin mutation.
- APIs: `GET /api/campaigns/active` (public: active campaign theme or null);
  admin CRUD `/api/admin/campaigns` (GET list paged, POST create {name, presetId,
  startAt, endAt, theme}, PATCH /api/admin/campaigns/[id] {publish/unpublish, edits},
  DELETE) guarded by RBAC permission `campaigns.manage` — add to auth.ts roles map:
  `"campaigns.manage": ["superadmin", "ops"]` (one line, nothing else).
- Admin UI (Wave 2): Campaigns dialog/page with preset picker (auto-fills dates from
  preset via presetDateRange — editable), theme color/copy/ornament fields, live
  preview strip, publish toggle, reminder chip showing daysUntil start for scheduled.
- Shopper theme layer (Wave 2): header/campaign bar consumes active theme (CSS vars:
  --campaign-accent etc.), greeting copy, festive ornament decoration (emoji/CSS),
  graceful none.

## TASK 10-d — Follow stores + smart nudges (spec)
- `POST /api/stores/[slug]/follow` (toggle) → `{following: bool, followers: n}`;
  `GET /api/stores/[slug]/follow` → same for the signed-in shopper (401 envelope when
  guest is fine). `GET /api/stores/[slug]` (existing storefront data — extend) include
  `followers` count.
- `GET /api/me/notifications?unread=1&size=` → list; `POST
  /api/me/notifications/read {ids?|all:true}`; `GET /api/me/notifications/unread`
  → `{unread: n}` (merge chat unread if trivial — keep separate).
- Backend triggers (in existing order transition paths): order paid → "Order
  confirmed", shipped → "Parcel on the way", delivered → "Parcel delivered — confirm
  receipt" (skip when the buyer triggered it themselves), seller publish/new-product
  for followers → promo nudge (cap 1/store/day). dataJson carries {orderNumber, slug}.
- Bell UI (Wave 2): header bell with unread badge + panel listing notifications,
  mark-all-read, click-through via dataJson.

## TASK 11 — Buyer order detail overhaul + POD + rebrand (spec)
- `GET /api/me/orders/[orderNumber]` EXTEND to return: customerName/phone, parsed
  shippingAddress object, customerNote, subtotal/discount/shipping/tax breakdown,
  paymentProvider, paidAt, items[] with variantLabel + unit/line prices + first
  product image, shipment timeline events incl. proofImageUrl (same data surface the
  receipt uses).
- Buyer UI OrderCard/OrderStatusView rebuild (Shopee-style): thumbnail rows per item
  with per-item price (+ "RM x each"), totals block, "CUSTOMER & SHIPPING" card
  (address + phone + payment + note), proof "View proof" chip on the Delivered step +
  ShipmentCard events; shared `ViewProofButton` (dialog with photo) in ui-bits.
- Live refresh fix: OrderStatusView polls every 12s + refetch on
  focus/visibilitychange; PurchasesView refetches on focus/visibility.
- Receipt PDF `GET /api/orders/receipt` (EXTEND existing route): full SHIP TO block
  (address + delivery contact), items table with embedded product thumbnails
  (local /public files via sharp; remote http(s) fetched; graceful initials-tile
  fallback), variant labels, NOMOFEE branding + `NOMOFEE-Receipt-*.pdf` filename.
  Note: client-side filename in checkout.tsx must become NOMOFEE too.
- Seller POD upload: "Mark delivered" opens DeliverDialog — in-browser canvas
  downscale to ≤1280px JPEG data URL, preview, optional note → POST deliver {proof}.

## TASK 11/12 — Rebrand SHOPMESH → NOMOFEE + NomoPay rename (spec)
- Sweep ALL case variants (SHOPMESH/ShopMesh/Shopmesh/shopmesh) across src/, seeds,
  metadata/manifest copy, README; logo spans → NOMO<span>FEE</span>; footer logo fix
  (shopper footer still shows SHOP<span>MESH</span>); storefront aria "Back to
  SHOPMESH marketplace" → NOMOFEE; checkout client receipt filename SHOPMESH-Receipt-
  → NOMOFEE-Receipt-; seeds emails → @nomofee.io (seller/admin) / @nomofee.test
  (buyer); nextOrderNumber `SM-` → `NM-` (src/lib/api.ts ~line 189) — legacy SM- rows
  remain valid.
- DB rebrand script scripts/rebrand-db.ts (NEW, idempotent): update User/Seller/
  AdminUser emails, Order.customerEmail, denormalised emails in notification/audit/
  ledger/payout/webhook JSON blobs, seeded copy. Passwords, `sm_session` cookie and
  secretbox key material MUST NOT change. Run it once; verify login still works.
- Finance scaffold rename (idle, MESH_FINANCE_ENABLED stays false, do NOT reconnect):
  `MESH_FINANCE_ENABLED` → `NOMO_FINANCE_ENABLED` (feature-flags.ts + wallet route +
  coins/claim route + me-hub); labels "MeshPay"→"NomoPay", "SPayLater"→"NomoPay
  Later", "Mesh Coins"→"Nomo Coins"; identifiers spayLaterLimitMinor/UsedMinor/
  AvailableMinor → payLater*, spayLaterEligible → payLaterEligible, SPAYLATER_MIN_MINOR
  → PAYLATER_MIN_MINOR; ShopperWallet columns spayLater* → payLater* (+ db push);
  psp.ts mock label → "NomoPay Checkout (sandbox)" (do NOT touch production
  candidates stripe_my/curlec/ipay88).

## OWNERSHIP (do not edit files you don't own; coordinate via worklog)
Wave 1 agents own ONLY their new lib/ + api route files. Nobody edits:
prisma/schema.prisma (final), src/components/** (Wave 2), src/app/globals.css,
src/components/shopper/shopper-shell.tsx, src/lib/auth.ts EXCEPT the one-line RBAC
addition (13-c), src/lib/api.ts EXCEPT the one-line prefix change (14-d).

## Worklog
Before starting: read /home/z/my-project/worklog.md (it contains restored Task 10-12
notes). After finishing: append your section per the template at the top of the file.
