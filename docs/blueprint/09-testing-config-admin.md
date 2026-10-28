# Blueprint Support 09 — Testing & QA, Configuration & Deployment, Administration (Parts O, P, Q)

## PART O — Testing and quality assurance

### O.1 Test inventory (executed? NO — read-only mandate; results are worklog claims [U])

| Artifact | Type | Runner | Contents |
|---|---|---|---|
| `scripts/fin-tests.ts` (585 ln) | Pure unit suite (own harness on `node:assert/strict`, no DB) | manual `bun scripts/fin-tests.ts` | **56 tests / 11 sections**: half-up boundaries; 5,000 randomized bpsOf vs independent BigInt oracle; overflow (RM85T / MAX_SAFE_INTEGER); 10,000 largest-remainder allocations Σ≡amount; refunds ×3,000 (T5 balance, reversal bound); split payments ×2,000 (ΣsellerNet+Σcommission ≡ buyer total); digit-exact parse/format round-trips; float-trap guardrails; fee-holiday semantics (partial/clamped/invalid-ignored, refunds-on-holiday, earnings identity ×2,000); legacy export byte-stability (v1 "7.3") + v2 round-trip; rate-precision reject-never-round matrix incl. boolean-smuggling regression |
| `scripts/fin-reconcile.ts` (543 ln) | Live-DB invariant suite (independent inline oracle; imports nothing from src/lib; read-only) | manual `bun scripts/fin-reconcile.ts` | **25 checks A–M**: bps ranges; order header≡lines; commission re-derivation from frozen bps; all txns balanced + T1 identities (gateway≡total, seller≡Σnet, Σnets+Σcommission≡buyer total) + T5 re-derived; group≡Σorders; coupon≡oracle+redemptions; refund bounds; batch totals + statement Σ≡payout + T3; wallet caches≡ledger truth; FinMigrationBackup 31/31 round-trip; holiday snapshots re-derived; export integrity era-correct; webhook idempotency (order_paid↔paidAt 1:1) |
| `scripts/e2e-fin-issues.sh` | Live-API E2E (curl) | manual; **not CI-safe** (restarts dev server, hardcoded credentials/IDs, assumes seeded rows) | fee-holiday partial/clamp/overlap/scheduled + export byte-stability |
| `scripts/verify-migration-freeze.ts` | Read-only freeze proof | manual, safe anytime | legacy columns absent (PRAGMA + DMMF reflection); bps columns present; ≥31 backups round-trip; JSON↔table 1:1; no npm script references frozen script; migrations dir absent |
| `tests/*.sh` (3) | Sandbox deploy-infra harness checks | n/a | **Not app tests** (docker runner/fake-bun plumbing) |

### O.2 Posture conclusion

- **No test runner, no CI**: `package.json` has no `test` script; zero vitest/jest/playwright/cypress configs or files. [V]
- **Covered (manually runnable)**: money/rate/CSV primitives; DB financial invariants; migration freeze. Worklog records fin-tests 56/56 and fin-reconcile 25/25 passes plus browser E2E — **not re-executed for this blueprint** [U].
- **Zero automated coverage**: auth/session lifecycle, RBAC caps, cart, checkout quote/create, webhook processing, refunds flow, seller fulfilment, mock-shipping, chat/socket, campaigns, voucher claim, import pipeline, storefront render, notifications, membership, guest lookup/receipt, admin CSV export. [I from inventory]

## PART P — Configuration, dependencies and deployment

### P.1 Runtime & build

- **Toolchain**: bun; Next.js **16.1.1** (App Router, Turbopack dev), React 19, TypeScript 5 (`strict: true` but `noImplicitAny: false`, `next.config.ts` sets `typescript.ignoreBuildErrors: true` — build gate bypassed), Tailwind **v4** PostCSS with a legacy v3-style `tailwind.config.ts` alongside (hybrid; v4 auto content detection does the real work), ESLint 9 (next preset, ~25 rules disabled incl. `no-explicit-any`, `no-console`). [V]
- **Scripts** [V]: `dev` (`next dev -p 3000 | tee dev.log`), `build` (standalone + copy static/public), `start` (`NODE_ENV=production bun .next/standalone/server.js | tee server.log`), `lint`, `db:generate`, **`db:push` (`prisma db push --accept-data-loss`)**, `db:migrate`/`db:reset` (reference non-existent migrations dir — vestigial).
- **Key deps** [V]: @prisma/client+prisma 6.11.1, socket.io(-client) 4.8.4, zod 4, zustand 5, framer-motion 12, recharts 2.15.4, pdf-lib, date-fns, @dnd-kit, sonner, lucide-react. **Installed-but-unused majors**: next-auth, next-intl, @tanstack/react-query, @tanstack/react-table, @mdxeditor/editor, react-markdown, react-syntax-highlighter, react-hook-form(+resolvers), sharp, uuid, z-ai-web-dev-sdk, @reactuses/core; 20 of 49 shadcn ui components unused (Support 10 §3).
- **No CI/CD, no Dockerfile/compose, no vercel.json** [M]. Deployment = sandbox harness: `.zscripts/dev.sh` (bun install → db:push → next dev + mini-services scan) and `.zscripts/start.sh` (production layout: NODE_ENV=production, `DATABASE_URL=file:/app/db/custom.db`, bun server.js + mini-services, **caddy as PID 1**). Staging/prod distinction: none beyond NODE_ENV [V].

### P.2 Environment variables (names & purpose only — no values)

| Var | Consumer | Purpose | State |
|---|---|---|---|
| `DATABASE_URL` | `prisma/schema.prisma:8` | SQLite file URL | set (.env sole entry) |
| `PUBLIC_APP_ORIGIN` | sitemap, seo, OAuth begin/callback | canonical origin / redirect base | unset → localhost fallback |
| `IMPORT_TOKEN_ENC_KEY` | `secretbox.ts:12` | AES-256-GCM key for marketplace tokens | unset → dev fallback key (F-16) |
| `SHOPEE_ENV/PARTNER_ID/PARTNER_KEY`, `SHOPEE_REDIRECT_URI` | `marketplaces/shopee.ts` | sandbox/live API + OAuth | unset → connector parked |
| `TIKTOK_SHOP_APP_KEY/SECRET/SERVICE_ID`, `TIKTOK_SHOP_REDIRECT_URI` | `marketplaces/tiktok.ts` | same | unset |
| `NODE_ENV`, `HOSTNAME` | db.ts singleton guard; secretbox fallback entropy | env mode / dev-key entropy | harness-set |

### P.3 Gateway & routing

Caddyfile (:81, verbatim mechanism): any request with query `XTransformPort=<n>` → `reverse_proxy localhost:<n>`; everything else → `localhost:3000`. Chat clients use `io("/?XTransformPort=3003")`; the internal relay :3103 is localhost-only by usage. Single externally exposed port. **No TLS block** (F-18). [V]

### P.4 Database workflow

No `prisma/migrations/` directory, no `_prisma_migrations` table — **schema-sync workflow via `db:push`** (forward-only; `--accept-data-loss` standing hazard). The M-FIN-1 bps migration was a one-off bun script (frozen; see Support 04 §F.4 + `verify-migration-freeze.ts`). Schema history lives in worklog + `FinMigrationBackup` + `db/backup/fin-migration-*.json`. [V]

## PART Q — Administration and operational controls

| Domain | Capability | Safeguards |
|---|---|---|
| Users/vendors | Seller lifecycle (approve/reject/suspend/activate/terminate), risk tier, notes, KYC queue + doc verdicts, bank verify/reject | `sellers.approve`/`sellers.suspend` caps; audited [V] |
| Product moderation | pending_review queue; approve/reject/ban | `products.moderate`; audited [V] |
| Orders | Full dossier viewer; refunds (approve/process/reject `refunds.manage`); disputes (`disputes.manage`; no money movement) | audited; no impersonation wired (`impersonate` cap unused) [V] |
| Payments/payouts | Batch dry-run + run; mark-paid/fail; wallet adjustments (T6); ledger viewer (accounts/transactions) | `payouts.manage` (superadmin+finance); audited [V] |
| Commission | Settings (diff dialog), overrides CRUD (dead config — FIN-01), fee holidays, exports + downloads, simulator, analytics, PSP scaffold (409-blocked) | `commission.manage`; audited [V] |
| Marketing | Banners, featured, coupons, campaigns (presets; publish gates shopper theme) | `campaigns.manage` [V] |
| Platform | Settings KV (`settings.manage` superadmin-only), feature flags (incl. dormant NomoPay finance suite), announcements (backend-only), audit/activity/notification logs (`logs.view`), system health | [V] |
| **Gaps** | No audit-log tamper-evidence/retention policy; separation of duties relies on role matrix only; destructive `db:reset` script present; webhook-deliveries replay has no UI; domain verify button broken (admin/stores.tsx:64); no operational runbooks [M] | |

---

## P1 ops round (addendum)

The "no CI/CD" (§P.1) and "no operational runbooks" (§Part Q gaps) findings were partially closed
by the P1 ops round:

- **Backup script + npm script**: `scripts/backup-db.ts` / `bun run db:backup [label]` →
  `db/backup/custom.db.<label>-<UTC ts>`; prefers the SQLite backup API via the `sqlite3` CLI
  (`.backup`), falls back to `fs.copyFileSync` with a live-copy WARNING; refuses overwrites.
- **CI workflow**: `.github/workflows/ci.yml` — bun install → prisma generate → `db push` +
  seed against a throwaway `db/custom.db` in the runner workspace (absolute `DATABASE_URL` via
  `${{ github.workspace }}`) → gates: `bun run lint`, `bun scripts/fin-tests.ts` (56),
  `bun scripts/fin-reconcile.ts` (25, seeded DB). `bunx tsc --noEmit` is INFORMATIONAL
  (`continue-on-error: true`) for the pre-existing type-error baseline (measured ~31 at the
  time of writing — `src/lib/app-store.ts`, `prisma/seed.ts`, `skills/*`, several admin routes;
  historically ~57 — tracked separately). No `bun run build` in CI by design.
- **Ops docs**: `docs/ops/postgresql-migration-plan.md` (SQLite→PostgreSQL strategy, type
  mapping incl. the Int-sen RM21.47M ceiling and the 35 JSON-in-String columns; answers §W5 of
  Support 10) and `docs/ops/production-readiness.md` (full `process.env.*` inventory — 11 static
  refs in `src/` + `DATABASE_URL` + 2 dynamically-read `*_REDIRECT_URI` = 14, staging-vs-prod
  table, backup/restore drill, monitoring incl. `/api/health` auth-gating note, known
  limitations, go-live checklist). The two docs cross-link each other.

Note: this blueprint originally referred to a "09-operational-limitations" doc; no such file
exists — this file (09, Configuration & Deployment / Administration) and Support 10
(§R.1 sandbox infrastructure) are the operational-limitation records, so this addendum lives here.

---

## Next-round addendum (Task 22, 2025-10-18)

The six "next-round candidates" from the P1 round were executed:

- **R1 — override fixedFee/holdDays semantics (FIN-01 completion)**: CommissionOverride
  rows now apply ALL non-null fields (bps → rate; fixedFeeMinor → per-order fixed fee;
  holdDays → payout hold; a bps-null row is no longer dead). Table wins over the static
  seller hold override; fee holidays still replace the rate only. `Order.holdDays Int?`
  freezes the resolved hold at checkout and BOTH webhook T1 sites use
  `order.holdDays ?? seller.holdDaysOverride ?? settings.payoutHoldDays`. Strict FIN-10
  validation on the admin override routes (400 on non-integer/negative/out-of-range).
  Suite counts moved 68→**78** (fin-tests, section [15]) and 25→**26** (fin-reconcile,
  new section N: T1 `availableAt == paidAt + Order.holdDays` re-derivation).
- **R2 — session rotation/revocation (F-09)**: `rotateSession()` (delete-first, cookie or
  Bearer) wired at the new `POST /api/me/password`; `revokeUserSessions()` wired on seller
  suspend/terminate/reject; logout honours the Bearer bridge. Live-proven: old token 401 /
  new 200 after rotation; suspended seller re-login 403. See Support 07 F-04/F-09 rows.
- **R3 — resume-payment CTA (UX gap from Task 21)**: `/api/me/orders` (+ detail) now carry
  the live payment session (`{ref, status, expiresAt?, amountMinor?}`, status "expired"
  server-computed) for unpaid orders; shopper **order detail** shows a "Resume payment"
  button and the Me-hub **To Pay cards** show a "Pay now" chip — both navigate to the
  hosted pay screen (`nav "pay"`), closing the abandoned-gateway loop. Browser E2E:
  NM-100038 resumed and paid via the list chip (exactly one T1, no duplicate idempotency
  keys); NM-100037 resumed via the detail button; paid orders show no resume affordance.
- **R4 — pluggable rate-limit store (F-04)**: `RateLimitStore` interface with the original
  in-memory store as default and a Redis adapter (`RATE_LIMIT_REDIS_URL`, lazy
  createRequire load, warn-once in-memory fallback — verified live with no ioredis
  installed: identical 429 behaviour). Zero call-site changes.
- **R5 — real-PSP adapter scaffold**: extended `PspProvider` (optional
  `createCheckoutSession`/`verifyWebhookSignature` + `isConfigured`), new
  `src/lib/psp-adapters/stripe-my.ts` (raw-fetch Checkout Sessions + real Stripe webhook
  signature scheme with 5-min replay window; 16/16 local verifier proofs), lazy registry,
  additive branches in the webhook route + checkout create — mock path byte-identical
  (race suite re-run green). See Support 08 R5 addendum.
- **R6 — CI activation**: `.github/workflows/ci.yml` refreshed (78/26 counts,
  `workflow_dispatch`, per-ref concurrency) + **`docs/ops/ci-activation.md`** runbook
  (GitHub-hosted / self-hosted / non-GitHub paths; validation performed; failure triage).
  Activation still requires a hosting remote — sandbox has none [M].
- Verification: fin-tests **78/78**, fin-reconcile **26/26**, fin-concurrency **10/10**,
  lint clean, tsc 31 = pre-existing baseline (zero new), admin Overrides tab renders the
  now-real Fixed fee/Hold days columns.
