# Task 14-c — Me hub UI rebuild (vouchers / purchases / bell / finance rename)

## Files owned & changed
- `src/components/shopper/me-hub.tsx` (rebuilt views inside, ~2050 lines now)
- `src/components/shopper/notification-bell.tsx` (NEW)

## NotificationBell export shape (for the orchestrator / global-header mount)
```tsx
import NotificationBell from "@/components/shopper/notification-bell";
// props: { onOpenOrder?: (orderNumber: string) => void;
//          onOpenStore?: (slug: string) => void;
//          className?: string;   // trigger styling hook (me-hub passes white-on-gradient classes)
//          align?: "start" | "center" | "end"; }  // panel alignment, default "end"
```
- Default export; self-contained: own auth gate via `useApp(s => s.me)` (renders **null** for guests), own badge state.
- Badge: GET `/api/me/notifications/unread` → `{unread}`; **poll every 30s + window focus + visibilitychange**.
- Panel: Radix Popover (portals to body, so it is safe inside the me-hub `overflow-hidden` profile header). Opens → GET `/api/me/notifications?size=20` (data IS the row array — okPaged). Rows: `{id, type, title, body, data:{orderNumber?, slug?}, read, readAt, createdAt}`.
- Mark-all-read: POST `/api/me/notifications` body `{all:true}` (note: the route is the collection route, there is NO `/read` subroute) → `{updated, unread}`; single-item read on click uses `{ids:[id]}`.
- Click-through: `data.orderNumber` → `onOpenOrder()`, else `data.slug` → `onOpenStore()`; panel closes first, item marked read.
- In me-hub it is mounted in ProfileHeader between Settings and Cart with `className="text-white/90 hover:bg-white/20 hover:text-white"` and `onOpenOrder={(n) => ctx.nav({name:"order-status", orderNumber:n})}`.

## VouchersView (Task 10-c)
- Segmented tabs `Mine (n) | Voucher Center` (role=tablist, teal active pill).
- Loads GET `/api/me/vouchers` once; consumes `{mine, center}` with legacy fallback `mine = d.mine ?? d.vouchers ?? []` (legacy `vouchers` field still honoured).
- Mine: claim-by-code input (POST `/api/me/vouchers {code}`) + held cards: title, status badge AVAILABLE/USED/EXPIRED, value line ("RM 10 off" / "20% off · up to RM 15" / "Free shipping"), KindBadge (discount=rose, freeshipping=teal, coinsback=amber), mono code, store name when `scope==="STORE"`, minSpend, expiry, "West Malaysia delivery only" when `regionLimit==="peninsular"`, "Used on …" when USED. Scroll container max-h-[70vh] + Tailwind `[&::-webkit-scrollbar]` styling (globals.css untouched).
- Center: pool cards with store logo (fallback Store icon tile) + name + "Platform" tag, value, KindBadge, minSpend, `quotaRemaining` ("n left" / "Unlimited quota"), expiry; Claim button (44px) → POST `/api/me/vouchers/claim {voucherId}` → 201 toast + optimistic claimed-swap + reload; **409 ALREADY_HELD / QUOTA_EXHAUSTED get dedicated toasts** (matched via `ApiFail.code`), then resync. Disabled labels: "Claimed" (Check icon) / "Fully claimed".

## PurchasesView (Task 11)
- `PurchasesOrderCard`: store header + `StatusBadge`; shipment/courier chip (Truck icon, `courierName · shipmentStatusLabel [· AWB]`) rendered **only when trackingNumber exists** (tone: emerald DELIVERED, rose EXCEPTION/RETURNED, else teal); per-item rows with 56px thumbnail (`item.imageUrl`, Package-icon fallback), title, variantLabel, `x{qty}` + `{formatMinor(unitPriceMinor)} each`; totals line (order number + date left, "Order Total" right); actions row **outside the clickable summary button** (no nested buttons): "Buy again" always, "Order received" when status shipped|delivered.
- Receive → POST `/api/me/orders/[orderNumber]/receive` → success toast + refetch (repeat → API 409 surfaces in toast).
- Reorder → POST `.../reorder` → toast summary `"{n} item(s) added to cart"` with `title ×qty` / `title — reason` detail; `notifyCartUpdated()` fires so header badges refresh; `ctx.openCart()` only when something was added; "Nothing added to your cart" info toast otherwise.
- Refetch on **window focus + visibilitychange** (visible only), plus normal tab-change load.

## Sell / Generate tile
- `More Activities` grid: `<ActivityTile icon={Sparkles} label="Sell / Generate" onClick={() => ctx.nav({name:"generate"})} />` — "Start Selling" tile untouched (grid now 7 tiles).

## Finance rename (Task 12 strings, this file only)
- `const NOMO_FINANCE_ENABLED = MESH_FINANCE_ENABLED;` alias right after imports; ALL usages (6 sites) renamed to the alias. **14-d only needs to touch feature-flags.ts + this import/alias pair.**
- Labels renamed: "SHOPMESH Pay"→"NomoPay" (wallet card + WalletView balance), "SPayLater"→"NomoPay Later" (card + WalletView + product chip "NomoPay Later 0% 3x" + aria "…NomoPay Later available"), "Mesh Coins"/"My Coins"→"Nomo Coins" (CoinCard + WalletView), FinanceComingSoonCard aria "NomoPay and Nomo Coins coming soon" + "NomoPay & Coins", FinanceComingSoonView "NomoPay is coming soon" + hint, "SHOPMESH Pay App"→"NomoPay App".
- `WalletT` fields stay `spayLater*` — they mirror the live `/api/me/wallet` response (route not yet renamed); 14-d must rename route + these type fields together.

## E2E verified (aisyah@shopmesh.test, dev server)
- notifications: unread `{unread:4}`, list rows carry parsed dataJson {orderNumber, slug}; `{ids:[id]}` → `{updated:1, unread:3}`.
- vouchers: `{vouchers(legacy), mine:11, center:14}`; claim held code → 409 ALREADY_HELD; claim by voucherId → 201 + AVAILABLE; pool re-read shows claimedByMe:true / claimable:false; mine 11→12.
- orders: rows carry imageUrl + shipmentStatus/shippingCourierName/trackingNumber; reorder SM-100032 → `{added:[Barrier Repair Serum 30ml ×1], skipped:[]}`; receive SM-100024 (delivered→completed) → 200, repeat → 409 VALIDATION.
- `GET /` compiles clean (200, no build errors in dev.log).

## Gates
- `bunx tsc --noEmit | grep shopper/(me-hub|notification-bell)` → zero errors (baseline errors exist in src/lib/app-store.ts — pre-existing, not mine).
- `bunx eslint me-hub.tsx notification-bell.tsx` → pass.
- Did NOT touch: checkout.tsx / ui-bits.tsx / storefront.tsx (14-b), shopper-shell.tsx, seller/**, API routes, schema, feature-flags.ts, globals.css.
