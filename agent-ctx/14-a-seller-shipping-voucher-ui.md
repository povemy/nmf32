# Task 14-a — Seller shipping/POD UI + voucher manager (rebuild)

Agent: Z.ai Code (14-a). Scope: ONLY src/components/seller/.

## Files
| File | Status | Purpose |
|---|---|---|
| src/components/seller/shipment-panel.tsx | NEW | ShipmentPanel (order detail), ShipmentStatusChip, fmtEtaRange, downloadOrderLabel(orderId, awb) helper |
| src/components/seller/ship-order-dialog.tsx | NEW | ShipOrderDialog — Platform booking (quote rate cards) / Manual tabs + success view (AWB + label download) |
| src/components/seller/deliver-dialog.tsx | NEW | DeliverDialog — canvas-compressed POD photo (≤1280px JPEG, ~1.2MB guard) + note → POST deliver |
| src/components/seller/vouchers.tsx | NEW | SellerVouchers — list + create dialog + fsPriceAdjustMinor info card |
| src/components/seller/orders.tsx | EDITED | Old ShipDialog removed; ShipOrderDialog + DeliverDialog + ShipmentPanel mounted; list rows get tracking badge; refreshAll = refetch + shipmentTick |
| src/components/seller/ui-bits.tsx | EDITED | SellerViewName + "vouchers" (one line) |
| src/components/seller/seller-shell.tsx | EDITED | import SellerVouchers, NAV "Vouchers" entry (BadgePercent icon), render line |

## Mount points
- Seller ▸ Orders ▸ order detail: "Ship order…" → ShipOrderDialog (paid/processing); "Mark delivered" (bg-brand-gradient-deep, shipped) → DeliverDialog; ShipmentPanel card in the detail grid.
- Seller ▸ Orders list: Status cell shows truck + mono tracking badge when trackingNumber exists.
- Seller ▸ sidebar/mobile sheet: "Vouchers" nav (after Coupons) → SellerVouchers.

## API shapes consumed (verified E2E)
- GET /api/store/shipping/quote?orderId= → {orderId, orderNumber, orderStatus, shipment:{status,awbNumber,courierName,etaFrom,etaTo}|null, destination:{state,city,zone}, parcel:{weightGrams,itemCount}, rates:[{rateId,providerId,courierName,serviceLevel,priceMinor,etaFromDays,etaToDays}]}. NOTE: the seller order detail endpoint does NOT expose the shipment relation — the quote endpoint is the read source for the shipment brief.
- POST /api/store/orders/[id]/ship {mode:"platform",rateId} | {mode:"manual",provider,trackingNumber} → {id,status,shippedAt,trackingNumber,trackingProvider,shipmentStatus,shipment:{awbNumber,courierName,etaFrom,etaTo,labelUrl}|null}.
- GET /api/store/orders/[id]/label?download=1 → image/svg+xml stream (auth-fetched as Blob for download; Bearer may not ride plain anchors).
- POST /api/store/orders/[id]/deliver {proof?:dataURL ≤1.2MB, note?} → {id,orderNumber,status,deliveredAt,shipmentStatus}; wrong state → 409 INVALID_STATUS (toasted).
- GET /api/store/vouchers → {vouchers:[{id,code,title,kind,discountMinor,percentOff,maxDiscountMinor,minSpendMinor,expiryAt,startsAt,isActive,scope,regionLimit,quota,claimedCount,holders,usedCount,createdAt}], fsPriceAdjustMinor}.
- POST /api/store/vouchers → 201 {voucher:{...}}; 409 CODE_TAKEN dup; freeshipping forced regionLimit:"peninsular".

## Gotchas for later agents
- Label download + any seller file GET must go through authHeaders() fetch → Blob (cookies alone are unreliable in the sandboxed preview iframe).
- ShipmentPanel refetch is driven by a refreshKey prop bump (refreshAll in OrderDetailView) — keep bumping it after ship/deliver mutations.
- PROOF_MAX_BYTES=1_200_000 in deliver-dialog.tsx must stay in sync with lib/shipping.ts validateProofDataUrl.
- Test residue on Lumina Living: SM-100024 walked to delivered; vouchers E2E14A (12% cap 25) + auto-coded FS voucher added.

## Gates
- bunx tsc --noEmit | grep "src/components/seller" → 0 errors.
- bunx eslint on all 7 files → clean.
- Root page compiles 200 on a fresh dev server; dev.log clean.
