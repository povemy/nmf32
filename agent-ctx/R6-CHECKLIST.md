# R6 — Checkout refinement round 2 (8-point follow-up)

Scope: `src/components/shopper/checkout.tsx` ONLY (no backend changes).

- [ ] 1. Place Order buttons (mobile bar + desktop aside): amount BEFORE label → "RM 738.00 · Place Order", "Place Order" bold.
- [ ] 2. Terms text: italic + text-justify (shared renderTerms → both breakpoints).
- [ ] 3. Delivery Address card: title 14px (text-sm), chevron smaller (h-4 icon, h-9 button), name/phone/address 12px (text-xs), card fixed h-[120px] with content fitted (filled state only; form/empty states stay auto).
- [ ] 4. Product rows un-bold: mobile shop cards (title font-medium→normal, price font-bold→normal rose, qty font-bold→normal) + desktop aside rows (title, price).
- [ ] 5. Remove "Message for seller" section from checkout (keep draft.note passthrough from cart drawer + MessagesSquare import used by order views).
- [ ] 6. Shipping selected option → rich emerald ribbon card per user prompt: border-2 emerald-600, bg-emerald-50/60, rounded-xl, shadow-sm, top-left folded badge w/ white Check, header "Get by {date}" + price bold, service subtitle, address line, recipient · phone, footer note with top border. No radio buttons anywhere in shipping (selected + unselected).
- [ ] 7. Unselected shipping options: compact radio-less rows (button role=radio), chevron affordance.
- [ ] 8. KEEP: EddChip (used by OrderStatusView), payment method radios (unchanged scope), quote/voucher/order logic untouched.
- [ ] 9. lint 0 + browser E2E mobile 390×844 & desktop 1440×900 + worklog R6.
