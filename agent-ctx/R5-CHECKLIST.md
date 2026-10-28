# R5 — Checkout polish pass (8 user requirements)

Task ID: R5-CHECKOUT-POLISH
Agent: Z.ai Code (main, orchestrator)
Scope: src/components/shopper/checkout.tsx + src/components/shopper/shopper-shell.tsx (MarketHeader only). NO backend/API changes.

## GLOBAL GUARDS (must survive the pass, verified by final diff review)
- [ ] placeOrder flow untouched: idempotency key, tracking refs, pay redirect, stock/MOQ guards, terms scroll-into-view, SHIPPING_UNAVAILABLE/OUT_OF_STOCK handling
- [ ] refreshQuote sequencing (quoteSeq, voucherEntriesRef, voucherKey) untouched
- [ ] Coupon apply/remove + shop-voucher Select logic untouched
- [ ] Address book ops (save/edit/delete/default) + picker dialog untouched
- [ ] PayView / OrderStatusView (lines ~1530+) untouched
- [ ] Money via formatMinor only; no float math
- [ ] No other agents' files touched

## Requirements → edits
1. Top bar: shell MarketHeader renders compact checkout variant (logo LEFT + centered "Checkout" title, nothing else). Remove checkout page's own mobile sub-header + desktop title block; content shifts up (reduced top padding).
2. Shop card items: show first 3, rest behind per-shop expand/collapse toggle row (chevron icon, "View all N items"/"Show less").
3. Shipping: title 14px (text-sm); options expanded by default; row height ≈45% shorter via restructure — line 1 label+price, line 2 eta + compact EDD chip ("Est. …"); fonts 13px/11px; section padding p-3 sm:p-4.
4. Payment Method: title 14px; rows same structure/height as shipping rows (radio + label + muted subtext + right Check); provider icon tiles removed; PROVIDERS gain `sub`.
5. Promotions: shared compact promosBlock (14px title, h-9 input/apply, applied chip) — desktop keeps left-column card (hidden lg:block); mobile renders INSIDE sticky bottom bar above Place Order row (~100px tall); "NOMO Coins redemption / Coming soon" row REMOVED (Coins import removed).
6. Terms: 12px text (text-xs); checkbox moved to RIGHT of text; scaled 2x (h-8 w-8) + margins.
7. Total Payment text: rose-600 → #00556a (breakdownRows, shared mobile+desktop). Item prices stay rose (not requested).
8. One-payment note: extracted from issuesBlock → rendered BELOW terms on both breakpoints; simplified dynamic text: "One payment, N parcel(s). Our system handles the rest." (N = quote.groups.length).
9. Bottom bar: LEFT back arrow (ArrowLeft → ctx.openCart() = back to cart) + Saved chip; Total moved INTO button: "Place Order · RM X" inline.

## Gates
- [ ] bun run lint exit 0; checkout.tsx tsc --noEmit clean (repo-wide pre-existing errors elsewhere tolerated)
- [ ] agent-browser E2E mobile 390x844: full path cart → checkout (all 8 reqs visually verified) → Place Order → sandbox Pay → Payment confirmed
- [ ] Desktop 1440x900 regression: two-column, compact sections, promos in left column, no mobile bar
- [ ] Final diff review: nothing deleted without replacement
- [ ] Commit + worklog append (template)
