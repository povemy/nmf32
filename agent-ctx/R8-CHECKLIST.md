# R8 — Admin UX Round: Friendly Settings + Featured Stores Control

## User asks (verbatim intent)
1. **Admin → System → Settings**: stop editing raw JSON. Booleans → ON/OFF toggles;
   every other value type gets a natural control (numbers, RM money, selects,
   provider chips, weight inputs). Also: there are TWO footer on/off controls
   (the R7 "Appearance" card + the `ui.footer_visible` JSON row) — keep exactly one.
2. **Admin backend**: there is no way to control the **featured stores** shown on the
   marketplace home ("Featured stores" section). Add buttons/section for it.

## Current state (verified)
- `system.tsx` SettingsView: R7 "Show footer across the app" Card + raw JSON table
  (`key / valueJson / description` + Edit dialog). `ui.footer_visible` appears in BOTH.
- Settings in DB: `maintenance.mode`(bool), `moderation.first_n`(num),
  `payments.providers`(array of 4), `payout.min_minor`(num minor units),
  `payout.mode`("manual_csv"), `payout.schedule.day`("monday"),
  `ranking.weights`({recency,sales,rating,ctr}), `ui.footer_visible`(bool).
- `maintenance.mode`, `payments.providers`, `payout.schedule.day` are seeded-only
  (no consumer yet) — still expose friendly controls; descriptions must not overclaim.
- `payout.mode` consumers: payouts/due + payout-batches (`method: mode`, default manual_csv).
- `moderation.first_n` consumer: store/products/helpers.ts (first N listings of a new
  store go to pending_review).
- `ranking.weights` — ranking helper (recency/sales/rating/ctr, 0..1 floats).
- Featured **products** control exists (Marketing → Featured → FeaturedView + /api/admin/featured).
- Featured **stores**: NONE. `/api/market/home` falls back to "first 6 live stores by
  createdAt" (`topStores` → `featuredStores`). No admin surface.
- `/api/admin/stores?search=` exists (returns all statuses; includes productCount, status).

## Changes

### A. Backend — featured stores
- NEW `src/app/api/admin/featured-stores/route.ts`:
  - GET → `{ stores: [{id,name,slug,tagline,logoUrl,productCount,status}], source: "setting"|"fallback" }`
    (setting key `home.featured_stores`, resolved live-status per store).
  - PUT `{ storeIds: string[] }` → validate ids exist, dedupe, cap 12, persist JSON array,
    auditAdmin "featured_stores.update" (before/after). Return same shape as GET.
- `src/app/api/market/home/route.ts`: read `home.featured_stores`; non-empty →
  live stores ordered by that list; empty/missing → existing fallback (6 by createdAt).

### B. Frontend — FeaturedView gains a "Featured stores" card (marketing.tsx)
- Ordered list: logo, name, slug, productCount, StatusChip; NOT-live store →
  amber "Hidden (not live)" hint. Up/Down reorder buttons + Remove (ConfirmDialog).
- "Add a store" search → GET /api/admin/stores?search= (debounced, reuse pattern from
  product search). Live stores: Add button (disabled if already featured). Non-live:
  disabled Add with hint.
- PageHeader description updated to mention stores.

### C. Frontend — SettingsView friendly controls (system.tsx)
- REMOVE the standalone R7 Appearance card (dedupe; footer switch becomes a row).
- Friendly rows (instant-save via PUT /api/admin/settings, toast + per-row busy state):
  - `ui.footer_visible` → Switch "Show footer across the app"
  - `maintenance.mode` → Switch "Maintenance mode"
  - `payments.providers` → 4 provider chips w/ checkbox state (fpx_toyyibpay/tng/grabpay/
    card_stripe + unknown values preserved); guard: cannot disable the last one
  - `payout.mode` → Select: manual_csv | auto
  - `payout.schedule.day` → Select: monday…sunday
  - `payout.min_minor` → RM input (RM value ↔ minor units), commit on blur/Enter, invalid → revert+toast
  - `moderation.first_n` → integer input (0..500), commit on blur/Enter
  - `ranking.weights` → 4 inputs (0..1 step 0.05) + live sum indicator, commit per-field on blur
  - Unknown keys → "Advanced — raw JSON" collapsible with the existing table + Edit dialog
- Empty-state: if a friendly key is missing from DB, render from the KNOWN spec with its
  default value (saving creates the row via upsert).

## Protected (do not touch)
- checkout.tsx (R6/R7 checkout), shopper-shell footer gate logic (consumes
  /api/settings/site — unchanged), /api/admin/settings PUT semantics (normalization +
  audit), FeaturedView product flows, all payout/commission business logic.

## Verification plan
- lint 0; tsc clean for touched files.
- agent-browser: Admin → Settings — toggle footer ON/OFF (shopper footer follows),
  maintenance switch, provider chip off/on (last-one guard), payout mode/day select,
  RM + first_n + weights inputs commit; Advanced section shows unknown keys only.
- Admin → Marketing → Featured: add/remove/reorder featured store; verify
  marketplace home "Featured stores" reflects order/removal (fallback when empty).
- Regression: featured products card still works.
