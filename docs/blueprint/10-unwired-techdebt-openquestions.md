# Blueprint Support 10 — Hard-coded/Mocked/Unwired Functionality, Technical Debt & Open Questions (Parts R, T, W)

## PART R — Hard-coded, mocked, unwired and incomplete functionality

### R.1 Intentional sandbox infrastructure (documented, not defects — but prod-relevant)

| Item | Location | Consequence if shipped as-is |
|---|---|---|
| Mock PSP + public `simulate` endpoint + hardcoded webhook HMAC secret | `psp.ts`, `simulate/route.ts`, `process.ts:26` | Forged payments (F-01/F-05); PSP swap is documented config-level (4 plug-in points) |
| Mock courier network (AWB SVG "MOCK LABEL — DEMO USE ONLY", POD, lazy tracking, unauthenticated `shipping/tick`) | `lib/shipping.ts:4-14,277,295-300`, `shipping/tick` | No real logistics integration |
| Deterministic SVG image service (no real uploads/AI imagery) | `api/img/[seed]`, `placeholder.ts` | No user uploads anywhere |
| Notifications = DB rows only (no email/SMS dispatch) | `lib/api.ts:113-124` | Customers never actually notified off-platform |
| Simulated outbound store webhooks + admin replay | `lib/api.ts:127-144`, `admin/webhook-deliveries/[id]/replay` | Delivery logs always "success" |
| Dormant NomoPay finance suite (`NOMO_FINANCE_ENABLED=false`): buyer wallet, coins, payLater scaffold, 403 FEATURE_DORMANT | `feature-flags.ts:19-30`, `me/wallet`, `me/coins/claim` | Licensing gate (FSA/BNM) documented in flag comments |
| Chat auto-reply scaffold (dormant) | `chat-quick-replies.ts:31-84` | — |
| Domain verify + integration test-delivery are server simulations (labelled in UI) | `store/domains/[id]/verify`, `integrations.tsx:132` | No real DNS/HTTP checks |
| Demo credentials (seeded; **rendered in client bundles**) | `seed.ts:440-444`, `admin-shell.tsx:434-438`, `seller-shell.tsx:607-616` | Must not reach production |

### R.2 Zero TODO/FIXME markers
`grep -i 'TODO\|FIXME\|HACK\|XXX'` across `src/` → **0 matches** [V] — incompleteness is expressed as dormant flags and simulated infrastructure rather than markers.

### R.3 Unwired backend (endpoints with no frontend caller) [V]
`GET /api/store/payouts` (sole consumer of `ledger.parseStatement`), `GET|POST /api/admin/announcements(+[id])`, `GET /api/admin/webhook-deliveries` + `POST /[id]/replay`, `POST /api/shipping/tick`, `GET /api/health` (ops-only). **Broken caller**: `admin/stores.tsx:64` → non-existent `/api/admin/domains/[id]/verify` (always 404 toast).

### R.4 Dead code [V]
Modules: `marketplaces/util.ts`, `marketplaces/callback.ts` (logic duplicated inline in the OAuth route — drift risk). Exports: `buildPayoutStatement`, `commissionOfBps`, `requireAdminRole`, `secretbox.safeEqual`, `notifyShopperShipped` (duplicate of wired `pushBuyerNotificationForShipped`), `snapshotToJson`, `isImportTerminal`, plus over-exported internal-only helpers; routes hardcode `"mock"` instead of `MOCK_PROVIDER_ID`.

### R.5 Features that look complete but are UI/presentation-only
Payment-method list (client constant), free-shipping progress copy (server rule duplicated), "coming soon" service tiles, Help Center misroute, campaign accent layer, category icons, quick replies, quick restock (+10 fixed), guest device-local order history. Detail: Support 02 §D.7.

### R.6 DB writes without expected audit/ledger records
Voucher/coupon redemption and checkout create are **not activity-logged** (only webhook `payment.succeeded` is); voucher funding has **no ledger posting** (no funding expense account — platform revenue = commission only, Support 06 §H.6). [V]

## PART T — Technical debt and architectural dependencies

| Observation | Evidence | Why it matters |
|---|---|---|
| **No central order state machine** — `transitionOrder` validates nothing; legality via duplicated status arrays (≥5 sites) | `lib/api.ts:147-167`; `membership.ts:15`, `seller/orders.tsx:283`, `me/orders/[n]/return-request:40`, `store/orders/[id]/refund-request:24`, `admin/orders.tsx:38`, `shopper ui-bits:668` | A new route can invent illegal transitions; drift |
| **4 client fetch conventions** (shopper/seller/admin/storefront + dead server one) with different envelope handling | `shopper/ui-bits.tsx:214-276`, `seller/ui-bits.tsx:102-142`, `admin/use-api.ts:25-93`, `storefront.tsx:1114` | Inconsistent error handling; envelope drift |
| **Duplicated section renderer** (builder preview vs live storefront implement the same 15-type switch) | `builder-render.tsx` vs `storefront.tsx:166-238` | Changes must be made twice |
| **≥5 status-label maps**; ≥10 inline `(minor/100).toFixed(2)` display sites beside `money.ts` helpers; 22 `toLocale*` date formats across 13 files | listed in Support 10 source sweep | Formatting drift vs POLICY P1 display rule |
| **Giant multi-concern client files**: checkout 2,569 ln (auth+cart+checkout+pay+orders), me-hub 2,241 ln, shopper-shell 1,476, generate 1,446, admin/marketing 1,300, storefront 1,285 | wc -l (top 15 in Support 10 sweep) | Hard to test/modify; bundle weight |
| **JSON-in-String columns with mixed parsing** — `json.ts` helpers exist but 21 files raw-`JSON.parse` | grep | Corrupt-data robustness inconsistent |
| **OAuth callback logic duplicated** (dead lib vs inline route) | `marketplaces/callback.ts` vs `auth/callback/[platform]/route.ts` | Security drift (F-07) |
| **Hardcoded operational values**: webhook secret, admin notify email `admin@nomofee.io` in ≥3 routes, RM100 threshold duplicated, MY_STATES list | `process.ts:26`, `store/onboarding:28`, `refund-request:48`, `checkout/create:332` | Config not env-driven |
| **Rebrand residue** (SHOPMESH→NOMOFEE): fixture host, UA string, dev-key seed, "SM-100017" copy, chat-service header comment | `generate.tsx:142`, `util.ts:8`, `secretbox.ts:21`, `checkout.tsx:2522,2537` | Confusion; cosmetic debt |
| **Seed-dependent demos/evidence**: quick-login cards, e2e script IDs, reconcile assumptions | `seller-shell:607-616`, `e2e-fin-issues.sh` | Raw DB wipe breaks demos/evidence |
| **Contract-tolerance fallbacks** masking API drift (`s.productCount ?? s._count?.products`) | `admin/stores.tsx:55-56` | Bugs hidden |
| **tsc baseline**: worklog records 57/58 pre-existing type errors at HEAD; `ignoreBuildErrors: true` at build | worklog; `next.config.ts:6-8` | Type gate effectively manual [U — not re-run] |

## PART W — Open questions and evidence limitations

| # | Unknown | Why not establishable here | Needed to resolve |
|---|---|---|---|
| W1 | Actual test-script results (56/56, 25/25) and lint/tsc baseline today | Read-only mandate — scripts not executed; `ignoreBuildErrors` hides tsc | Run `bun scripts/fin-tests.ts`, `fin-reconcile.ts`, `tsc --noEmit` in a change-approved session |
| W2 | Production values of all env vars (`PUBLIC_APP_ORIGIN`, Shopee/TikTok keys, `IMPORT_TOKEN_ENC_KEY`) | Only DATABASE_URL exists in .env | Deployment-time secrets plan |
| W3 | Real-PSP behaviour parity — does any licensed gateway match the mock's exact webhook shape/signature model? | No adapter exists | PSP contracting + adapter build (4 documented plug-in points) |
| W4 | Who invokes `/api/shipping/tick` and the "nightly" `runLedgerInvariants` in production | No scheduler exists in repo | Cron/worker decision |
| W5 | Concurrency behaviour under multi-vendor load (SQLite single-writer; TOCTOU windows) | No runtime/lock testing possible read-only | Load test; Postgres migration assessment |
| W6 | Performance/bundle cost of 2,200–2,600-line client shells | No measurements | Profiling |
| W7 | Whether unwired endpoints (announcements, webhook-deliveries viewer, seller payouts page) are planned or orphans | Product intent not recorded | Product decision |
| W8 | Whether `notifyShopperShipped`/`marketplaces/callback.ts` should be wired or deleted; central transition map adoption | Product/architecture decision | Review |
| W9 | Fee-holiday realism: no engine-produced holiday order exists in live DB yet (seed holiday is bps 0 only) | Live data lacks an exercised partial-holiday order | First real occurrence + reconcile K |
| W10 | Whether finer rate precision (sub-0.01%) is ever required (BPS_DENOM raise policy documented) | Business requirement unknown | Product decision |
| W11 | e-money/licensing scope for the dormant NomoPay wallet suite (FSA 2013/BNM questions recorded in flag comments) | Legal question | Compliance review |
| W12 | DB-level integrity beyond schema (e.g., `integrity_check`, index DDL audit) | Read-only conservatism; sqlite3 CLI absent (python sqlite3 used for row checks) | Maintenance window |
| W13 | Whether the historic "Refunds RM30" discrepancy has any other occurrences (only PO-100001 was repaired) | Only ledger-reconciliation can prove globally | `bun scripts/fin-reconcile.ts` execution |

### Search-scope limitations (whole blueprint)
Static inspection only — no servers started, no requests sent, no scripts executed, no DB writes (live DB read via Python sqlite3 `mode=ro` only). Evidence derives from full reads of financial/security/auth/config code, structured inventories of all ~120 API routes and all 76 models, and cross-greps of frontend callers; worklog.md was treated as intent, not proof. Dynamic behaviours (locking, race exploitability, runtime performance) are labelled [I]/[U] accordingly.
