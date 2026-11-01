# Portal code-splitting — assessment + applied split (Phase 2.4)

**Structure found:** one route (`src/app/page.tsx` → `AppRoot`) that statically imported all
three portal shells (shopper/seller/admin) and switches on the zustand `surface` — a single
client bundle carried every portal's code for every visitor.

**Applied (trivial, safe):** `next/dynamic` for `SellerShell` + `AdminShell` in
`src/components/app-root.tsx` (`ssr:false`, spinner fallback) — they render only for
authenticated seller/admin sessions, so shoppers (the default surface) no longer download
those chunks; verified `curl /` → 200 for the shopper session after the change.

**Further opportunities (NOT implemented — heavier refactors):** dynamic-import the
shopper portal's rare views (checkout, generate/claim, affiliate hub, me-hub) and the
seller portal's tab bodies (builder, insights, marketing, wallet) behind their nav gates.

**Expected benefit:** the seller/admin chunks (~40–50% of current component code by line
count) leave the first-load shopper bundle; TBT/parse time on mid-tier mobile should drop
roughly proportionally — measure with `next build` bundle analyzer before/after if needed.
