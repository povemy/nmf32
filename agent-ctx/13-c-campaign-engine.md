# Task 13-c — Campaign engine (work record)

Agent: campaign-engine (Task 13-c)
Date: 2026-10-16
Status: DONE — all deliverables built, seeded, E2E-verified, tsc/eslint clean.

## Files created/changed (my ownership only)

| File | Change |
|---|---|
| `src/lib/campaigns.ts` | NEW — full campaign engine lib (see exports below) |
| `src/lib/auth.ts` | ONE LINE only: added `"campaigns.manage": ["superadmin", "ops"]` to `ADMIN_CAPS` |
| `src/app/api/campaigns/active/route.ts` | NEW — public GET |
| `src/app/api/admin/campaigns/route.ts` | NEW — admin GET paged + POST create |
| `src/app/api/admin/campaigns/[id]/route.ts` | NEW — admin PATCH + DELETE |
| `prisma/seed-campaigns.ts` | NEW — idempotent seeder (run via `bunx tsx`) |

No other files touched (schema, components, globals.css, shopper-shell, api.ts all untouched).

## src/lib/campaigns.ts — exports

- Types: `CampaignThemeT` (accent, accentSoft, gradientFrom, gradientTo, greeting, greetingBm, tagline, taglineBm, ornament), `CampaignPresetWindow` (`{year?, start "MM-DD", end "MM-DD"}` MYT), `CampaignPreset`, `CampaignDateRange`, `CampaignStatusT`, `ActiveCampaign`.
- `DEFAULT_CAMPAIGN_THEME` (brand teal #0D9488).
- `parseCampaignTheme(raw)` — accepts object OR JSON string (Campaign.themeJson is a String column); per-field safe defaults; hex-validated colors (`#RGB`/`#RRGGBB`); copy ≤160 chars; ornament ≤4 code points. Never throws.
- `validateCampaignTheme(input)` → `{ok, errors[], theme}` — reports bad fields for admin UX, always returns usable theme; used by POST/PATCH (400 VALIDATION w/ details[]).
- `serializeCampaignTheme(theme)` → themeJson string.
- `CAMPAIGN_PRESETS` (10, see table below) + `findCampaignPreset(id)`.
- `presetDateRange(preset, now?)` — window containing now wins (latest start); else nearest upcoming; recurring month/day windows materialised for current + next MYT year (year wrap); exhausted festival windows roll forward by whole years; end = 23:59:59.999 MYT.
- `campaignStatusOf(c, now?)` → draft | scheduled | live | ended.
- `daysUntil(target, now?)` — ceil days.
- `resolveActiveCampaign(now?)` — published && startAt<=now<=endAt, latest startAt first; 60s cache on globalThis key `__nomofee_active_campaign_cache`; lazy `await import("./db")` (module is client-import-safe — NO top-level prisma/api imports).
- `invalidateCampaignCache()` — called by every admin mutation (POST/PATCH/DELETE).

## Presets + windows (MYT)

| id | name | accent | windows |
|---|---|---|---|
| raya-aidilfitri | Hari Raya Aidilfitri | #10B981 | 2025-03-21→04-07 (Raya 31 Mar 25) · 2026-03-10→03-28 (Raya ~21 Mar 26, est.) |
| cny | Chinese New Year | #DC2626 (+gold #FDE68A soft) | 2025-01-20→02-12 (CNY 29 Jan; Chap Goh Meh 12 Feb) · 2026-02-08→03-03 (CNY 17 Feb; CGM 3 Mar) |
| deepavali | Deepavali | #7C3AED | 2025-10-13→10-27 (20 Oct) · 2026-11-01→11-15 (8 Nov) |
| merdeka | Merdeka Sale | #16A34A | recurring 08-17→08-31 |
| malaysia-day | Malaysia Day Sale | #DC2626 | recurring 09-09→09-16 |
| ramadan-early-bird | Ramadan Early-Bird | #0F766E | 2025-02-18→03-30 · 2026-02-19→03-20 |
| sale-99 | 9.9 Mega Sale | #E11D48 | recurring 09-01→09-09 |
| sale-1010 | 10.10 Mega Sale | #D97706 | recurring 10-01→10-10 |
| sale-1111 | 11.11 Mega Sale | #EA580C | recurring 11-01→11-11 |
| sale-1212 | 12.12 Year-End Sale | #DB2777 | recurring 12-01→12-12 |

Each preset carries EN + light BM greeting/tagline + ornament emoji (🌙 🏮 🪔 🇲🇾 🔥 ⚡ 🎁 🎉).

## Endpoint signatures

- `GET /api/campaigns/active` — public, no auth → `{data: ActiveCampaign | null}`; ActiveCampaign = `{id, name, presetId, isPublished, startAt ISO, endAt ISO, theme, daysLeft}`. `dynamic = "force-dynamic"`.
- `GET /api/admin/campaigns?page&size&status&q` — RBAC `campaigns.manage` → `okPaged(rows, {page,size,total})`; rows = campaign + parsed `theme` + derived `status` + `daysUntilStart`/`daysLeft`; status filter maps to SQL (draft/scheduled/live/ended); q = name contains.
- `POST /api/admin/campaigns` — body `{name, presetId?, startAt?, endAt?, theme?, isPublished?}`; preset auto-fills missing dates via presetDateRange; theme validated (400 w/ per-field details); audits `campaign.create`; invalidates cache.
- `PATCH /api/admin/campaigns/[id]` — body `{publish?|isPublished?, name?, presetId?, startAt?, endAt?, theme?}`; effective-window validation (start<end across combined edits); audits `campaign.update`; invalidates cache. 404 unknown.
- `DELETE /api/admin/campaigns/[id]` — audits `campaign.delete`; invalidates cache. 404 unknown.

## Seed rows (prisma/seed-campaigns.ts, idempotent upsert-by-name; verified re-run)

1. **"Raya Mega Sale (demo)"** — published, LIVE now, startAt = now−2d, endAt = now+5d, preset raya-aidilfitri theme (#10B981, 🌙, "Selamat Hari Raya Aidilfitri").
2. **"12.12 Year-End Warm-Up (draft demo)"** — unpublished draft, sale-1212 theme + nearest upcoming 12.12 window (Dec 1–12, 2026), status draft.

## E2E verified (system dev server, admin Bearer session)

- active returns Raya demo w/ parsed theme; admin list paged + status/q filters OK.
- POST: preset auto-fill dates (9.9 → Sep 1–9 2027 given now=Oct 2026) ✓; bad theme 400 w/ details[] ✓; unknown presetId 400 w/ valid ids ✓; start>=end 400 ✓.
- PATCH publish → scheduled; theme/preset edits ✓; invalid theme 400 ✓; unpublish → draft ✓; DELETE ✓ + repeat 404 ✓.
- Cache invalidation: publish/unpublish reflected immediately on public endpoint (no 60s staleness).
- RBAC: no auth → 401; finance role → 403 "Capability 'campaigns.manage' required" (temp session minted + cleaned up).
- auditAdmin rows confirmed (campaign.create/update/delete w/ before/after).

## Gotchas for other agents

- **Turbopack cache gotcha**: globalThis cache persists across route recompiles — if you seed/change campaign rows externally, the public endpoint may serve the old result for up to 60s. Wave 2 admin UI mutations MUST go through my admin routes (they invalidate); for direct DB fiddling in dev, wait out the TTL.
- `parseCampaignTheme` accepts a JSON **string** — pass `Campaign.themeJson` directly, no manual JSON.parse needed.
- Wave 2 shopper theme layer: import `{ resolveActiveCampaign }` ONLY in server components/routes; import presets/theme types freely in client components (no prisma pulled).
- Wave 2 admin UI: `GET /api/admin/campaigns` rows carry `status`, `daysUntilStart`, `daysLeft` for the reminder chip; preset picker should call nothing server-side — `presetDateRange` is pure and client-safe for auto-fill preview; server re-fills dates anyway if omitted.
- Sandbox clock = Oct 2026: 2025/2026 festival windows are already past; extrapolation branch returns 2027+ occurrences (verified: Raya→Mar 2027, CNY→Jan 2027, Deepavali→Oct 2027).
- Dev-server note: the supervisor-supplied `bun run dev` died mid-task; I briefly ran a replacement `next dev -p 3000`, then killed it once the supervisor's own server (PIDs writing dev.log) took the port back. Final state = supervisor's server, healthy (see dev.log 200s).
