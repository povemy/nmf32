# NOMOFEE — Marketplace Platform

A multi-vendor marketplace platform built with Next.js 16 (App Router), TypeScript, Prisma (PostgreSQL via Supabase), and shadcn/ui.

## What's Inside

| Area | Description |
|---|---|
| **Storefront (shopper)** | Marketplace home, store pages, product detail pages, cart, checkout, order lookup |
| **Seller Portal** | Onboarding, dashboard, products/variants/collections, orders & fulfillment, storefront page builder, domains, webhooks, coupons, wallet & payouts, settings |
| **Admin Console** | Seller KYC approval, product moderation, orders, refunds, disputes, commission engine (holidays/overrides/simulation), payouts & batches, wallets & ledger, categories, banners, announcements, tickets, reports, feature flags, audit logs |
| **Payments** | Webhook-driven payment providers with a simulator, checkout quote/pricing, wallet ledger |
| **Specs** | Original product specs in `upload/` (PART0–PART6: master plan, product spec, DB DDL, module specs, wireframes, OpenAPI contract, orchestrator) |

## Tech Stack

- **Framework**: Next.js 16 (App Router) + TypeScript 5
- **Styling**: Tailwind CSS 4 + shadcn/ui (New York) + Lucide icons
- **Database**: Prisma ORM with PostgreSQL on **Supabase** (schema in `prisma/schema.prisma`; connection string in `.env` — see `.env.example`. The datasource reads `SUPABASE_DATABASE_URL`)
- **State**: Zustand (client), TanStack Query ready

## Getting Started

```bash
# 1. Install dependencies (bun or npm/pnpm work)
bun install

# 2. Set up the database (Supabase Postgres — credentials in .env)
bunx prisma db push
bun prisma/seed.ts    # canonical demo data seeder

# 3. Run the dev server
bun run dev           # or: npm run dev

# 4. Open http://localhost:3000
```

## Project Structure

```
src/
  app/
    page.tsx                  # Single-entry UI (all portals mount here)
    api/                      # REST API routes
      auth/                   # register / login / logout / me
      admin/                  # admin console APIs (KYC, moderation, finance, ...)
      store/                  # seller portal APIs
      shopper (sf)/           # storefront APIs ([slug] = store handle)
      checkout/               # quote, create, payments, simulate
      cart/                   # cart operations
      market/                 # marketplace discovery
      webhooks/payments/      # payment provider webhooks
  components/
    admin/                    # admin console UI
    seller/                   # seller portal UI
    shopper/                  # storefront UI
    ui/                       # shadcn/ui primitives
  lib/                        # db client, auth, money, ledger, commission, utils
  hooks/                      # use-toast, use-mobile
prisma/
  schema.prisma               # full data model (PostgreSQL provider → Supabase)
  seed.ts                     # demo data seeder
supabase/                     # (cloud DB — no local database files; SQLite removed in the SQLite→Supabase migration)
upload/                       # original product specification documents
```

## Store Generator (Nexova-style)

Paste a Shopee / TikTok Shop URL (or a demo fixture link) on the **"Sell / Generate store"** page → NOMOFEE validates the link, imports the authorised catalogue (products, variants, images), auto-generates SEO, and creates a **claimable draft storefront**. The verified owner claims it (token + account + marketplace authorisation), configures it in the seller portal (**Imports & Publish**, **SEO**), publishes, and trades — checkout, orders, payments and ledger all reuse the platform's existing commerce engine.

- Docs: `docs/handover.md` (full technical handover), `docs/marketplace-integration-research.md` (official API verification), `docs/codebase-inventory.md`, `docs/implementation-plan.md`
- Import APIs: `POST /api/import/resolve`, `POST /api/import/jobs`, `GET /api/import/jobs/{id}?token=…`, `POST /api/import/jobs/{id}/resume?token=…`, `POST /api/claim/bind`, `POST /api/store/publish`
- Demo imports use `https://demo.shopmesh.fixture/shop/{name}` and are labelled "Demo data" everywhere; they never masquerade as live marketplace imports.

## Marketplace Configuration (env)

Live imports require the official platform credentials (server-side only — never exposed to the client):

```bash
SHOPEE_PARTNER_ID=...        # Shopee Open Platform partner id
SHOPEE_PARTNER_KEY=...       # Shopee partner key
SHOPEE_ENV=sandbox|live
TIKTOK_SHOP_APP_KEY=...      # TikTok Shop Partner Center app key
TIKTOK_SHOP_APP_SECRET=...
TIKTOK_SHOP_SERVICE_ID=...   # optional
PUBLIC_APP_ORIGIN=https://your-domain   # OAuth redirect + canonical URLs
IMPORT_TOKEN_ENC_KEY=...     # AES key for sealing marketplace tokens
```

Without them, the UI shows "Server credentials missing" and real-marketplace jobs park in `awaiting_authorisation` — by design (official APIs require seller authorisation; URL-only scraping is neither possible nor permitted). See `docs/research-shopee.md` / `docs/research-tiktok.md` for the verified endpoint contracts and registration steps.

## Demo Accounts (after seeding)

Check `prisma/seed.ts` for seeded credentials (admin, sellers, and demo shoppers) and `worklog.md` for the full build history and decisions.

## Notes

- The app is a single-route UI (`/`) with portal shells switched client-side; all data flows through REST APIs under `/api/*`.
- Payments are simulated via webhook endpoints — no external payment provider keys required.
- SQLite keeps it zero-config; swap `prisma/schema.prisma` datasource to Postgres/MySQL for production.
