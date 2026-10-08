# Marketplace Platform

A multi-vendor marketplace platform built with Next.js 16 (App Router), TypeScript, Prisma (SQLite), and shadcn/ui.

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
- **Database**: Prisma ORM with SQLite (`db/custom.db`, schema in `prisma/schema.prisma`)
- **State**: Zustand (client), TanStack Query ready

## Getting Started

```bash
# 1. Install dependencies (bun or npm/pnpm work)
bun install

# 2. Set up the database
#    Option A: use the included seeded database (db/custom.db) as-is
#    Option B: create fresh + seed
bunx prisma db push
bunx prisma db seed   # runs prisma/seed.ts

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
  schema.prisma               # full data model
  seed.ts                     # demo data seeder
db/custom.db                  # SQLite database (seeded)
upload/                       # original product specification documents
```

## Demo Accounts (after seeding)

Check `prisma/seed.ts` for seeded credentials (admin, sellers, and demo shoppers) and `worklog.md` for the full build history and decisions.

## Notes

- The app is a single-route UI (`/`) with portal shells switched client-side; all data flows through REST APIs under `/api/*`.
- Payments are simulated via webhook endpoints — no external payment provider keys required.
- SQLite keeps it zero-config; swap `prisma/schema.prisma` datasource to Postgres/MySQL for production.
