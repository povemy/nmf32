import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

const base = globalForPrisma.prisma ?? new PrismaClient({
    log: ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = base

// ============================================================================
// P2.3-7 (monitoring honesty — Phase 2.3 audit "dead metrics code"):
// lib/metrics.ts was DESIGNED to receive Prisma-observed op durations through
// globalThis.__ltRecordDb (self-registered by lib/metrics.ts at load), but
// this hook was never wired — /api/metrics `db.aggregates` + `slowRing` were
// permanently empty. This $extends query hook completes that designed
// integration: it times every model operation and forwards (model, operation,
// ms) to the registry, which attributes them to the current route via the
// AsyncLocalStorage scope opened by handle() in lib/api.ts.
//
// SAFETY RULES (this is the hottest file in the app):
//  - NEVER statically import lib/metrics.ts here: db.ts is reachable from the
//    browser bundle through lib/campaigns.ts (pre-existing app quirk), while
//    metrics.ts is server-only (fs + async_hooks). The globalThis optional
//    call keeps the browser bundle free of server imports; in Turbopack dev
//    (per-realm globalThis) the call simply no-ops in realms where the
//    registry has not registered itself.
//  - The hook can NEVER fail a query: it only times the call and the record
//    path is wrapped in try/catch; the query result/error path is untouched.
//  - $extends preserves $metrics/$transaction/$queryRaw and every model
//    delegate (verified 2026-11-06 against Prisma 6 client), so /api/metrics
//    Prisma pool telemetry and all existing call sites keep working.
// ============================================================================
// TYPE NOTE: the $extends result is deliberately re-typed as the plain
// PrismaClient. Prisma's extension types are NOT assignable to
// Prisma.TransactionClient (the interactive-tx callback parameter used by
// ~30 existing call sites, several of them change-frozen this phase), while
// the RUNTIME object keeps every delegate plus $metrics/$transaction/
// $queryRaw and passes all queries through the timing hook above. The cast
// is type-level only — no behavior difference.
const extended = base.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const t0 = performance.now()
        try {
          return await query(args)
        } finally {
          try {
            if (model) {
              ;(globalThis as { __ltRecordDb?: (model: string, operation: string, ms: number) => void })
                .__ltRecordDb?.(model, operation, performance.now() - t0)
            }
          } catch {
            /* metrics must never break a query */
          }
        }
      },
    },
  },
})

export const db: PrismaClient = extended as unknown as PrismaClient
