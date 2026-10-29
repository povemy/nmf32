# Advertising Integration — Provider-Neutral Adapter Design (Phase 4, design only)

Last updated: 2026-10-30 · Status: **DESIGN — not implemented.** Per the mission spec: no advertising-platform connectors, no SDKs, no conversion-event sending, and no fake connected states ship in this phase. This document is the audited interface design that future connector stages will implement **after the first-party event pipeline (Phases 1–3) is proven reliable in production**.

Related: `docs/seller-insights/implementation-plan.md` (§1.4, §5), `full-audit-report.md` (F-20), `docs/marketplace-integration-research.md` (provider research).

---

## 1. Ground rules (binding for every future connector stage)

1. **No spend, no ROAS.** ROAS/CPC/CPA/ROI are NEVER computed from first-party data — they require actual advertising spend pulled from the provider AND a documented attributed-revenue measure, and must always be labeled provider-reported, not first-party.
2. **Two measurement worlds, never merged silently.** First-party attribution (last-touch association, `docs/seller-insights/metric-definitions.md` §11) and ad-platform-reported conversions are DIFFERENT measurements. A future UI may show them side by side, clearly labeled; never summed, never deduplicated against each other.
3. **No fake states.** A provider that is not connected shows as "not connected". No simulated connections, no fabricated spend or conversions, no mock dashboards outside the existing fixture pattern (clearly labeled `fixture`).
4. **Read-only first.** Stage 1 is read-only insights (spend, campaign metadata, platform-reported conversions). Campaign mutation (create/pause/budget) is a later stage with its own capability review.
5. **Fail closed.** Missing env credentials → `CONNECTOR_NOT_CONFIGURED` (house pattern from `lib/marketplaces/`); OAuth failures → honest error states; never degrade to "pretend connected".

## 2. Why a separate connection model (not MarketplaceConnection)

Audit finding **F-20** documented that `MarketplaceConnection` carries a deferred-binding design: rows are created **global (`storeId: null`)** at OAuth-callback time and only later bound to a store via the claim flow. That design produced cross-store visibility (`OR storeId: null` in listings) and cross-store mutation (disconnect flipping global rows). The minimal fail-closed scoping fix for the three seller-visible leak sites shipped with this mission (see §4), but the model itself remains structurally ambiguous for reuse.

An advertising connection is also semantically different:

| Concern | MarketplaceConnection (catalogue import) | AdConnection (advertising) |
|---|---|---|
| Binding | deferred (global row → claim) | **required at creation** (state carries sellerId; bind at `exchangeCode`) |
| Cardinality | one row per (platform, shopId) | one row per **(store, platform, adAccountId)** — a store can have multiple Meta ad accounts |
| Secrets | access/refresh tokens + shop cipher | access/refresh tokens + (later) offline-event pipeline tokens |
| Consumers | import runner (product sync) | insights read path (spend/reporting) + conversion-event sender |

Overloading `platform` (`tiktok` shop vs `tiktok_ads`) and dragging `ImportJob` coupling along would preserve exactly the ambiguity that produced F-20. Decision: **separate model, required storeId from day one.**

```prisma
// FUTURE SCHEMA (design — do not migrate yet)
model AdConnection {
  id              String   @id @default(cuid())
  storeId         String             // REQUIRED — never null (F-20 lesson)
  platform        String             // "meta" | "tiktok" | "google" | ...
  adAccountId     String             // provider's account id
  adAccountName   String?
  status          String   @default("pending")  // pending | connected | expired | disconnected
  scopesJson      String   @default("[]")
  accessTokenEnc  String?            // sealSecret (lib/secretbox.ts) — same sealed-token pattern
  refreshTokenEnc String?
  expiresAt       DateTime?
  lastRefreshAt   DateTime?
  lastError       String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@unique([storeId, platform, adAccountId])
  @@index([storeId, status])
}
```

## 3. Provider-neutral adapter interface

New module `src/lib/ads/` (NOT `src/lib/marketplaces/` — different domain, no import-runner coupling):

```ts
// src/lib/ads/types.ts (design)
export type AdPlatform = "meta" | "tiktok" | "google";

export type AdAuthStatus = {
  platform: AdPlatform;
  envConfigured: boolean;          // provider app credentials present server-side
  connected: boolean;              // ≥1 active AdConnection for the store
};

export type AdSpendDay = {
  day: string;                     // KL day key — the SAME bucketing as salesTrend
  spendMinor: number | null;       // provider-reported, MYR minor; null = not reported
  currency: string;                // provider currency (may differ from MYR — never silently converted; shown as reported with currency label)
  impressions: number | null;
  clicks: number | null;
};

export type AdPlatformReport = {
  platform: AdPlatform;
  window: { from: string; to: string };
  spend: AdSpendDay[];             // provider-reported only
  providerReportedConversions: number | null;  // provider's own attribution — labeled, never merged with first-party
  notes: string[];                 // honesty notes (attribution model differences, currency, delays)
};

/** Stage-1 connector contract — READ-ONLY. Campaign mutation is explicitly out of scope. */
export interface AdPlatformConnector {
  readonly platform: AdPlatform;
  authStatus(storeId: string): Promise<AdAuthStatus>;
  beginAuthorisation(input: { storeId: string; redirectUri: string; state: string }): Promise<{ authorizeUrl: string } | null>;
  exchangeCode(input: { code: string; redirectUri: string; sellerId: string; storeId: string }): Promise<AdConnection>;
  refreshIfNeeded(connectionId: string): Promise<void>;
  listAdAccounts(connectionId: string): Promise<Array<{ id: string; name: string }>>;
  fetchReport(input: { connectionId: string; from: Date; to: Date }): Promise<AdPlatformReport>;
}
```

Reuse from the marketplace world (patterns, not code coupling): the sealed-token bookkeeping (`lib/secretbox.ts`), the honest `CONNECTOR_NOT_CONFIGURED` behavior, the begin/callback single-use state nonce (see §5), and the fixture pattern for sandbox verification (a deterministic `ads/fixture.ts` clearly labeled as fixture data, never shown as a real connection).

## 4. F-20 status after this mission (the advertising dependency)

**Shipped now (minimal, fail-closed, runtime-verifiable):**
- `GET /api/store/connections` — list scoped to the session seller's own `storeId` only; global handshake rows invisible (was: every seller saw every unclaimed platform row).
- `GET /api/store/imports` — connection list scoped identically (was: same `OR storeId: null` leak).
- `DELETE /api/store/connections/disconnect` — mutation scoped to the seller's own rows; **global rows can no longer be mutated by any seller** (was: one seller's disconnect flipped the shared row state for every store).

**Still deferred (required BEFORE any advertising connector reuses marketplace-style OAuth flows) — root-cause refactor, scheduled with the connector stage:**
1. Stamp `sellerId` on handshake rows at creation (forward the OAuth state's sellerId through `exchangeCode`) so pre-claim rows are attributable instead of anonymous globals.
2. `exchangeCode` upsert update-branch must verify ownership before overwriting a claimed row's tokens.
3. `claim/bind` should match `shopId` (not just platform) when binding global rows — today a seller can capture another seller's freshly-OAuth'd same-platform connection.
4. Scope the import runner's connector pick (`runner.ts` non-fixture `findFirst({ platform, status: "connected" })`) and `authStatus()` lookups to the job's store.
5. Sweep/resolve existing `storeId: null` rows (bind via verified claim evidence or mark orphaned).

The advertising design avoids ALL of this by construction (`AdConnection.storeId` required at creation; no global rows; no claim flow), which is why the connector interface above binds at `exchangeCode` using the state's sellerId/storeId.

## 5. OAuth state nonce — generalize, don't duplicate

The F-22-remediated marketplace callback (`/api/auth/callback/[platform]`) uses single-use `Setting oauth_state_{state}` rows with TTL + platform match + cross-seller guard. The advertising flow needs the same guarantees; design: extract that state helper into `src/lib/oauth-state.ts` with a `kind: "marketplace" | "ads"` discriminator (namespace the Setting key `oauth_state_{kind}_{state}`), and route `/api/auth/callback/ads/[platform]` separately so marketplace and ads callbacks never share a prefix-expemption surface. The CSRF proxy already gates both (POST-free GET redirect flows; callbacks are GETs that redirect, no cookie authority beyond the single-use state).

## 6. Conversion events (later stage — design sketch only)

Sending first-party conversion events to ad platforms (CAPI / Events API) requires: a server-side sender with idempotency keys, event dedup against the payment webhook (one event per `Order.paidAt` transition), event parameters limited to what the platform's terms allow (hashed email/phone ONLY where the shopper has consented — the platform has no consent banner today, so **no conversion events may be sent until a consent regime exists**), and honest failure accounting. This is explicitly out of scope until (a) the first-party pipeline is proven, (b) consent gating exists, (c) a data-processing review per provider is done.

## 7. UI surface (future)

A "Ads" section inside Insights (after Campaigns) showing, per connected provider: spend series (provider-reported, own currency), platform-reported conversions (labeled), and the first-party attributed metrics from the Campaigns tab — side by side with explicit "different measurement" notes. No ROAS until spend + a documented attributed-revenue measure both exist; when added, it is labeled "provider-reported ÷ provider-reported" or "provider spend ÷ first-party attributed revenue" with its formula disclosed — never a silent mix.

## 8. Staged rollout checklist (per provider)

1. Connector module implements `AdPlatformConnector` (read-only) + fixture variant.
2. Env credentials documented in `.env.example`; fail-closed `CONNECTOR_NOT_CONFIGURED` without them.
3. OAuth begin/callback via the generalized nonce helper; `AdConnection` bound at exchange (storeId required).
4. Seller-facing connect/disconnect with capability checks + audit logging (`ads.connection.*`).
5. Read-only report surfaced with honesty notes; rate-limited + cached like all insights routes.
6. Cross-seller negative tests (seller B cannot see/list/disconnect seller A's ad connections) — same pattern as the insights T15 tests.
7. Only after all of the above: consider conversion-event sending (§6) and campaign mutation (§1.4).
