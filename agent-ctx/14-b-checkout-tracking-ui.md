# Task 14-b — Buyer checkout/tracking UI rebuild (checkout.tsx, ui-bits.tsx, storefront.tsx)

## Files owned & changed
- `src/components/shopper/ui-bits.tsx` — EDITED (extended)
- `src/components/shopper/checkout.tsx` — EDITED (OrderStatusView rebuilt, CheckoutView extended)
- `src/components/shopper/storefront.tsx` — EDITED (Follow button, aria fix)
- NO `pod.tsx` / `tracking.tsx` created — both shared components live in ui-bits per the brief ("export both"); a split would have duplicated them.

## Shared exports from ui-bits.tsx (for orchestrator / Wave-2 agents)
```tsx
import {
  ViewProofButton,        // {url: string; label?: string; compact?: boolean} — POD dialog
  StatusTimeline,         // {events: ShipmentEventT[]; className?} — Shopee-style shipment-event
                          //   timeline (newest first, View-proof on DELIVERED, built in)
  OrderFlowTimeline,      // {history: {toStatus,createdAt}[]; current: string} — the OLD
                          //   history-based stepper, RENAMED from StatusTimeline
  shipmentEventLabel,     // (s: string) => string
  type ShipmentEventT,    // {id?, status, description, location, occurredAt, proofImageUrl?}
  type ShipmentT,         // shipment block incl. etaFrom/etaTo/events
  type OrderDetailT,      // LookupResultT + full /api/me/orders/[orderNumber] surface
} from "@/components/shopper/ui-bits";
```
NAMING: `StatusTimeline` changed signature (history-based → shipment-events-based) per the 14-b brief.
Grep-verified the old name was imported ONLY by checkout.tsx (mine). `ShopperCtx`/nav signatures untouched.

## API shapes consumed (all verified E2E with aisyah@shopmesh.test)
- GET `/api/me/orders` → okPaged `{bucketCounts, orders:[{..., shipmentStatus, shippingCourierName, trackingNumber, items[{imageUrl,...}]}]}` (list UI in me-hub 14-c; used here for E2E only).
- GET `/api/me/orders/[orderNumber]` → full detail: money breakdown (subtotal/discount/shipping/tax/total), customerName/Phone/Note, shippingAddress object, paymentProvider, paidAt..., items[{variantLabel, unitPriceMinor, lineTotalMinor, imageUrl}], history, `shipment{status, courierName, awbNumber, etaFrom, etaTo, events[{status, description, location, occurredAt, proofImageUrl}]}`, shipmentStatus/shippingCourierName, dispute{status,resolution}.
- POST `/api/me/orders/[orderNumber]/receive` → `{orderNumber, status:"completed", completedAt}`; payment_pending → 409 INVALID_STATUS.
- POST `/api/me/orders/[orderNumber]/reorder` → `{added:[{title,qty}], skipped:[{title,reason}]}`.
- GET `/api/me/vouchers` → `{mine:[{id, status, voucher{code,title,kind,discountMinor,percentOff,maxDiscountMinor,minSpendMinor,scope,storeId,regionLimit,store}}], center, vouchers(legacy)}` — picker uses `mine` filtered AVAILABLE + kind!=="coinsback" + (scope PLATFORM || storeId match).
- POST `/api/checkout/quote` body now also carries `vouchers:[{storeId,userVoucherId}]` → `groups[].voucher` = verdict `{valid, reason, code, title, kind, discountMinor, freeShipping}`; totals pre-adjusted.
- POST `/api/checkout/create` body carries `vouchers` too → response `vouchersApplied:[{code,kind,discountMinor,freeShipping}]` folded into the success toast.
- GET/POST `/api/stores/[slug]/follow` → `{following, followers}` (GET 401 envelope for guests — UI keeps the `/api/sf/[slug]` `store.followers` seed).

## Key UI behaviours
- OrderStatusView: hero card (per-status icon/headline/blurb + order# copy + dark EDD chip + dispute strip) → items card (56px thumbs, "RM x each", line totals) → totals block → CUSTOMER & SHIPPING card → shipment card (courier·AWB chip + EddChip + StatusTimeline) or OrderFlowTimeline fallback → actions: Continue shopping / Download receipt (`NOMOFEE-Receipt-<order>.pdf`) / Contact seller / All my orders / Order received (shipped|delivered) / Buy again. Live refresh: 12s poll + focus + visibilitychange(visible), cleaned up on unmount; poll errors never blank loaded data. Guest lookups (no breakdown) keep the legacy compact card.
- Checkout voucher picker: per seller group in the summary aside (quote.groups → cart.stores fallback); selection pruned to in-checkout stores (create is HARD about unknown sellers); verdict lines emerald/rose under each select.
- EDD chip: quote "2-4 working days" → real date window (weekend-skipping) on phase-3 review; shipment etaFrom/etaTo → "Oct 18–21" on the tracking hero (in-flight only).
- Storefront header: optimistic Follow toggle w/ rollback + follower count + guest `openShopperAuth(() => toggle())` pattern.

## E2E (curl, dev server restarted inside each bash call — sandbox reaper)
- claim GLOWRM10 → 201; quote with voucher → verdict `{valid:true, code:"GLOWRM10", discountMinor:1000}`, totals disc 1000 / total 46700.
- SM-100032 detail → shipment DELIVERED (City-Link Express · CLX1010659926), 5 events, proofImageUrl (data-URL SVG) on DELIVERED only.
- receive on payment_pending → 409 (surfaces via toast); reorder SM-100035 → added 2 items (test additions removed; cart restored to Barrier Repair Serum ×3).
- follow toggle lumina-living → {false,0} then {true,1}; /api/sf/lumina-living followers:1. Root 200; no dev.log errors; "NOMOFEE-Receipt-" present in the compiled checkout chunk.

## Gates
- `bunx tsc --noEmit` filtered to shopper/(checkout|ui-bits|storefront|pod|tracking) → ZERO errors (also cleared the 4 documented Task-9 baseline errors inside checkout.tsx: Stepper onJump narrowing + 3 `&& contactErrors.*` ternary fixes).
- `bunx eslint` on the 3 files → clean; `bun run lint` → clean.

## Deviations / flags for orchestrator
- Order-detail totals show plain "Discount" (TicketPercent icon) — the detail API does not return the voucher code, so no voucher-specific label is possible client-side (voucher naming is surfaced at create time via vouchersApplied toast).
- Receipt route's server-side `Content-Disposition` filename still says SHOPMESH-Receipt- — `src/app/api/orders/receipt/route.ts` is outside 14-b ownership; client filename fixed. Flag for 14-d.
- Other SHOPMESH copy in storefront.tsx (chrome strip "SHOPMESH MARKETPLACE", setMeta fallback) left untouched — rebrand sweep is 14-d.
