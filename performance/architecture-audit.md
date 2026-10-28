# Architecture audit (LT) — 2026-10-22

Verified by code reading + runtime probes (full detail in REPORT.md §2, §5; agent audit in worklog):

- Runtime: Next.js 16.1.3 dev (Turbopack), Node 24 via bun; caddy :81→:3000; socket.io chat mini-service :3003 (memory rooms, no auth on sockets, local relay :3103).
- DB: remote Supabase Postgres 17 via Supavisor SESSION pooler (port 5432); Prisma pool `connection_limit=10`; server max_connections=60; pooler pool_size 15 (LT-2 discovery); RTT ≈40 ms.
- Auth: custom DB sessions (Session table, 7-day) — 2 reads per authed request; Bearer or cookie.
- Checkout: POST /api/checkout/create (Idempotency-Key required) → server-side re-pricing → per-line variant reads inside tx → conditional stock decrement `updateMany(stock>=qty)` → paymentGroup(requires_payment, 30-min expiry) → client-triggered POST .../simulate OR webhook → Serializable claim-first confirmation (orders→paid, ledger T1, wallet cache, cart clear in one tx).
- Stock: decremented at create; NOT restored on payment failure/expiry (only admin-refund increments) — code-verified.
- Caching: NONE server-side; all market routes force-dynamic; search = ILIKE %token% (unindexable) + JS relevance ranking over a 200-row window ordered by salesCount.
- Rate limiting: in-memory fixed-window, first-XFF-keyed; ONLY on webhook(60/min), simulate(10/min), payout-admin routes.
- Monitoring before LT: /api/health only (full-ledger scan ~1.2s). After LT: /api/health/live, /api/health/ready, token-gated /api/metrics, Prisma $metrics, pg_stat probes.
- Quirk: db.ts reachable from browser bundle via lib/campaigns.ts (client admin component) — node builtins must stay out of that graph (metrics uses process-keyed shared state + globalThis registry hook).
- Turbopack dev instantiates module graphs PER ROUTE; even globalThis is per-realm; `process` object is shared — used for cross-realm metric aggregation.
