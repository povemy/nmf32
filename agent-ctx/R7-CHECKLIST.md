# R7 CHECKLIST — Checkout refinement round 2 + platform features

Parent commit: e8fed8b (R6 round 1 already landed). This round refines R6 and adds 2 platform features.

## Task R7-CHECKOUT (main thread) — src/components/shopper/checkout.tsx ONLY

User points (verbatim intent):

1. **Shipping Option — selected card restyle**
   - [ ] Selected option border width = 1px (`border-2` → `border`)
   - [ ] Remove ALL shadows on the selected card (`shadow-sm` gone)
   - [ ] Un-bold ALL text in selected option → font-weight 300 (`font-light`) EXCEPT "Get by [date range]" → font-weight 500 (`font-medium`)
   - [ ] Price: 13px, stays on the right, unbold (`font-normal`)
   - [ ] REMOVE the address-info line + name/phone line
   - [ ] REMOVE footer sentence "Delivered to your address by the date shown — each seller's parcel is dispatched separately."
   - [ ] REPLACE both with static line "Doorstep Delivery" (11px, fw 300)
   - Final card lines: "Get by Oct 23-26" (13px/fw500) | price right (13px/normal) · "{label} · {eta}" (11px/fw300) · "Doorstep Delivery" (11px/fw300)
   - [ ] Keep the emerald ribbon badge + Check (not asked to remove)
2. **Shipping unselected rows**
   - [ ] Price unbold (`font-bold` → `font-normal`), keep 13px + right position
3. **Payment Method**
   - [ ] Remove the radio (RadioGroupItem) from selected & unselected rows — keep the teal Check icon
   - [ ] Convert RadioGroup/Label markup to plain role=radiogroup buttons (no orphan htmlFor)
   - [ ] Remove now-unused RadioGroup import
4. **Item list in vendor card**
   - [ ] Price font-size 12px (`text-sm` → `text-xs`), stays unbold (mobile shop cards; desktop aside already 12px)
5. **Terms of Service — removed from checkout FOREVER**
   - [ ] Delete renderTerms definition + both usages (mobile + desktop)
   - [ ] Delete placeOrder agreed-guard + termsRef + data-terms-block scroll logic
   - [ ] Remove `agreed` from DraftT/base/loadDraft (strip stale sessionStorage key)
   - [ ] Update stale comments referencing terms
6. **Place Order button**
   - [ ] "Place Order" text font-weight 900 (`font-bold` → `font-black`) on BOTH mobile bar + desktop aside (amount-first layout from R6 stays)

Protected (must NOT change): quote/voucher/idempotency/placeOrder payload logic, ledger flows, EddChip, delivery address card (R6 state), order views.

## Task R7-PLATFORM (subagent full-stack-developer)

4. **ToS at buyer registration (compulsory)**
   - [ ] ShopperAuthDialog register form (shopper-shell.tsx): standard-layout compulsory checkbox "acknowledge Terms of Service"; blocks Create-account until checked; sends agreedToS
   - [ ] POST /api/auth/shopper/register: 400 when agreedToS !== true
6. **Admin Hide/Show footer toggle (overall app)**
   - [ ] Public GET /api/settings/site → { footerVisible } from Setting key `ui.footer_visible` (default true)
   - [ ] shopper-shell: render ShopperFooter only when footerVisible
   - [ ] Admin → System → Settings: "Appearance" card with Switch bound to `ui.footer_visible` via existing PUT /api/admin/settings
   - [ ] No schema change (Setting model exists) → no db:push

## Verification (main thread, after both tasks)
- [ ] bun run lint → 0 new issues
- [ ] dev.log clean (no compile/runtime errors)
- [ ] agent-browser mobile 390×844: card spec (border 1px, no shadow, fw mapping, 3 lines), payment radios gone, item price 12px, no terms block anywhere, "RM X · Place Order" fw900
- [ ] Desktop 1440×900 regression
- [ ] Golden path: Place Order → sandbox PAY → order confirmed (terms no longer required)
- [ ] Register flow: checkbox blocks submit unchecked; API rejects agreedToS=false
- [ ] Admin toggle hides/shows footer on shopper surface
