// ============================================================================
// Nomofee — Centralized API Contract Types
// ============================================================================
// Single source of truth for EVERY API request body and response payload
// documented in `docs/API-CONTRACT-BLUEPRINT.md` (290 route files →
// 369 HTTP endpoints across 18 feature domains, §2–§19).
//
// GENERATED from the blueprint (dev sandbox snapshot, 2026-11-08). When a
// route's serialization changes, update BOTH the route AND this file (and
// the blueprint) — they are meant to stay in lockstep.
//
// USAGE
//   • Import from anywhere — UI components ("use client" safe) and local
//     API route files alike. This module is TYPES ONLY: zero runtime code,
//     zero imports, so it adds nothing to any client/server bundle.
//   • Prefer `import type { … } from "@/lib/types/api-contract"` so the
//     import is fully erased at compile time.
//   • Naming: `<Thing>Data` = the payload inside the envelope;
//     `<Thing>Response` = payload + envelope; `<Thing>Body` = request body;
//     `<Thing>Query` = query parameters.
//
// HOUSE CONVENTIONS (see blueprint §1 for the full reference)
//   • Envelope (src/lib/api.ts): single object → { data };
//     paged/composite → { data, meta: { page, size, total } };
//     errors → { error: { code, message, details?, meta? } }.
//   • Money: integer minor units (MYR sen), field suffix `Minor`.
//   • Dates/timestamps: ISO-8601 strings.
//   • Affiliate/commission rates: integer basis points (`rateBps`).
//   • Order numbers: `NM-100001`-style strings.
//   • Auth: httpOnly cookie `sm_session` OR `Authorization: Bearer <token>`.
//   • Non-envelope endpoints (CSV/PDF/SVG/raw webhook acks) appear as
//     comment stubs in their sections — no interface is invented for them.
// ============================================================================

// ----------------------------------------------------------------------------
// Shared response envelopes (src/lib/api.ts: ok() / okPaged() / fail())
// ----------------------------------------------------------------------------

/** Success envelope for single-object payloads: `{ data: T }`. */
export interface ApiOk<T> {
  data: T;
}

/** Pagination metadata returned alongside paged/composite payloads. */
export interface ApiPageMeta {
  page: number;
  size: number;
  total: number;
}

/** Success envelope for paged lists and composite payloads.
 *  `T` is the element array (e.g. `ApiPage<FooRow[]>`) or a composite
 *  object (e.g. `ApiPage<{ bucketCounts: …; orders: … }>`). */
export interface ApiPage<T> {
  data: T;
  meta: ApiPageMeta;
}

/** Error envelope: `{ error: { code, message, details?, meta? } }`.
 *  Production 500s carry `error.meta.refId` (correlation id); raw internals
 *  stay server-side. */
export interface ApiErr {
  error: {
    code: string;
    message: string;
    details?: unknown;
    meta?: { refId?: string };
  };
}

/** Convenience union for generic fetch wrappers: success or error envelope. */
export type ApiEnvelope<T> = ApiOk<T> | ApiErr;

/** Convenience union for paged fetch wrappers: paged success or error envelope. */
export type ApiPagedEnvelope<T> = ApiPage<T> | ApiErr;

// ============================================================
// §2 Authentication & Identity
// §3 Platform & Operations
// ============================================================

// ------------------------------------------------------------
// §2 Authentication & Identity
// Multi-portal: admin / seller / shopper accounts live in separate tables;
// one session store keyed by `userType`.
// ------------------------------------------------------------

/** POST /api/auth/login — legacy portal login request body */
export interface LoginBody { email?: string; password?: string; portal?: "admin" | "seller" }

/** POST /api/auth/login — MFA challenge variant */
export interface LoginMfaData { mfaRequired: true; challenge: string; email: string }

/** POST /api/auth/login — admin success variant */
export interface LoginAdminData { userType: "admin"; admin: { id: string; email: string; name: string; role: string }; token: string }

/** POST /api/auth/login — seller success variant */
export interface LoginSellerData { userType: "seller"; seller: { id: string; email: string; fullName: string; displayName: string; status: string; storeId: string | null; storeSlug: string | null; storeName: string | null }; token: string }

/** POST /api/auth/login — response (MFA challenge | admin | seller) */
export type LoginResponse = ApiOk<LoginMfaData | LoginAdminData | LoginSellerData>;

/** POST /api/auth/unified-login — cross-portal login request body */
export interface UnifiedLoginBody { email?: string; password?: string; portal?: "admin" | "seller" | "shopper" }

/** POST /api/auth/unified-login — MFA challenge variant */
export interface UnifiedMfaData { mfaRequired: true; challenge: string; email: string }

/** POST /api/auth/unified-login — admin success variant */
export interface UnifiedAdminData { userType: "admin"; admin: { id: string; email: string; name: string; role: string }; token: string }

/** POST /api/auth/unified-login — seller success variant */
export interface UnifiedSellerData { userType: "seller"; seller: { id: string; email: string; fullName: string; displayName: string; status: string; storeId: string | null; storeSlug: string | null; storeName: string | null }; token: string }

/** POST /api/auth/unified-login — shopper success variant (with guest-order claim + cart merge) */
export interface UnifiedShopperData { userType: "shopper"; shopper: { id: string; email: string; fullName: string; phone: string | null }; isAffiliate: boolean; token: string; claimed: { addressesClaimed: number; ordersClaimed: number; skipped?: "email-unverified" }; emailVerified: boolean; guestCartMerged: number }

/** POST /api/auth/unified-login — response (MFA challenge | admin | seller | shopper) */
export type UnifiedLoginResponse = ApiOk<UnifiedMfaData | UnifiedAdminData | UnifiedSellerData | UnifiedShopperData>;

/** POST /api/auth/logout — logout payload */
export interface LogoutData { loggedOut: true }

/** POST /api/auth/logout — response */
export type LogoutResponse = ApiOk<LogoutData>;

/** GET /api/auth/me — anonymous (no session) variant */
export interface MeAnonymousData { userType: null }

/** GET /api/auth/me — admin variant (includes MFA-enrollment gate flag) */
export interface MeAdminData { userType: "admin"; admin: { id: string; email: string; name: string; role: string }; mfaEnrollmentRequired: boolean }

/** GET /api/auth/me — seller variant */
export interface MeSellerData { userType: "seller"; seller: { id: string; email: string; fullName: string; displayName: string; status: string; storeId: string | null; storeSlug: string | null; storeName: string | null } }

/** GET /api/auth/me — shopper variant */
export interface MeShopperData { userType: "shopper"; shopper: { id: string; email: string; fullName: string; phone: string | null } }

/** GET /api/auth/me — current identity response (anonymous | admin | seller | shopper) */
export type MeResponse = ApiOk<MeAnonymousData | MeAdminData | MeSellerData | MeShopperData>;

/** POST /api/auth/register — seller signup request body */
export interface RegisterBody { email?: string; password?: string; fullName?: string; displayName?: string; countryCode?: string; storeName?: string; storeSlug?: string; phone?: string }

/** POST /api/auth/register — seller signup payload (status "onboarding", store fields non-null) */
export interface RegisterData { userType: "seller"; seller: { id: string; email: string; fullName: string; displayName: string; status: string; storeId: string; storeSlug: string; storeName: string }; emailVerified: boolean; emailVerificationSent: boolean; token: string }

/** POST /api/auth/register — response */
export type RegisterResponse = ApiOk<RegisterData>;

/** POST /api/auth/reset-password — complete password reset request body */
export interface ResetPasswordBody { token?: string; newPassword?: string }

/** POST /api/auth/reset-password — payload */
export interface ResetPasswordData { reset: true; message: string }

/** POST /api/auth/reset-password — response */
export type ResetPasswordResponse = ApiOk<ResetPasswordData>;

/** POST /api/auth/forgot-password — request recovery code body */
export interface ForgotPasswordBody { email?: string }

/** POST /api/auth/forgot-password — uniform payload (hides account existence) */
export interface ForgotPasswordData { sent: true; message: string }

/** POST /api/auth/forgot-password — response */
export type ForgotPasswordResponse = ApiOk<ForgotPasswordData>;

/** POST /api/auth/verify-recovery — verify recovery code body */
export interface VerifyRecoveryBody { email?: string; code?: string }

/** POST /api/auth/verify-recovery — 15-minute HMAC reset grant payload */
export interface VerifyRecoveryData { token: string; email: string; expiresAt: string }

/** POST /api/auth/verify-recovery — response */
export type VerifyRecoveryResponse = ApiOk<VerifyRecoveryData>;

/** GET /api/auth/dev-accounts — dev credentials panel payload */
export interface DevAccountsData { title: string; accounts: { type: "admin" | "seller" | "buyer" | "affiliate"; label: string; email: string; password: string; role: string | null; status: string | null }[] }

/** GET /api/auth/dev-accounts — response */
export type DevAccountsResponse = ApiOk<DevAccountsData>;

/** POST /api/auth/mfa/verify — admin MFA completion request body */
export interface MfaVerifyBody { challenge?: string; code?: string }

/** POST /api/auth/mfa/verify — session-minting success payload */
export interface MfaVerifyData { userType: "admin"; admin: { id: string; email: string; name: string; role: string }; token: string }

/** POST /api/auth/mfa/verify — response */
export type MfaVerifyResponse = ApiOk<MfaVerifyData>;

/** POST /api/auth/seller/email-verification/request — idempotent already-verified variant */
export interface SellerEvDoneData { alreadyVerified: true; sent: false }

/** POST /api/auth/seller/email-verification/request — code sent variant */
export interface SellerEvSentData { sent: true; message: string }

/** POST /api/auth/seller/email-verification/request — response (done | sent) */
export type SellerEvRequestResponse = ApiOk<SellerEvDoneData | SellerEvSentData>;

/** POST /api/auth/seller/email-verification/verify — seller OTP verify body */
export interface SellerEvVerifyBody { code?: string }

/** POST /api/auth/seller/email-verification/verify — payload (sole writer of Seller.emailVerifiedAt) */
export interface SellerEvVerifyData { verified: true; alreadyVerified: boolean; emailVerifiedAt: string }

/** POST /api/auth/seller/email-verification/verify — response */
export type SellerEvVerifyResponse = ApiOk<SellerEvVerifyData>;

/** POST /api/auth/shopper/login — buyer login request body */
export interface ShopperLoginBody { email?: string; password?: string }

/** POST /api/auth/shopper/login — payload (email-ownership-gated guest-order claim + guest-cart merge) */
export interface ShopperLoginData { userType: "shopper"; shopper: { id: string; email: string; fullName: string; phone: string | null }; token: string; claimed: { addressesClaimed: number; ordersClaimed: number; skipped?: "email-unverified" }; emailVerified: boolean; guestCartMerged: number }

/** POST /api/auth/shopper/login — response */
export type ShopperLoginResponse = ApiOk<ShopperLoginData>;

/** POST /api/auth/shopper/register — buyer signup request body */
export interface ShopperRegisterBody { email?: string; password?: string; fullName?: string; phone?: string }

/** POST /api/auth/shopper/register — payload (folds guest cart; never claims orders) */
export interface ShopperRegisterData { userType: "shopper"; shopper: { id: string; email: string; fullName: string; phone: string | null }; token: string; claimed: { addressesClaimed: number; ordersClaimed: number }; emailVerified: boolean; emailVerificationSent: boolean; guestCartMerged: number }

/** POST /api/auth/shopper/register — response */
export type ShopperRegisterResponse = ApiOk<ShopperRegisterData>;

/** POST /api/auth/shopper/email-verification/request — idempotent already-verified variant */
export interface ShopperEvDoneData { alreadyVerified: true; sent: false }

/** POST /api/auth/shopper/email-verification/request — code sent variant */
export interface ShopperEvSentData { sent: true; message: string }

/** POST /api/auth/shopper/email-verification/request — response (done | sent) */
export type ShopperEvRequestResponse = ApiOk<ShopperEvDoneData | ShopperEvSentData>;

/** POST /api/auth/shopper/email-verification/verify — shopper OTP verify body */
export interface ShopperEvVerifyBody { code?: string }

/** POST /api/auth/shopper/email-verification/verify — payload (winner claims legacy guest orders exactly once) */
export interface ShopperEvVerifyData { verified: true; alreadyVerified: boolean; ordersClaimed: number }

/** POST /api/auth/shopper/email-verification/verify — response */
export type ShopperEvVerifyResponse = ApiOk<ShopperEvVerifyData>;

// GET /api/auth/callback/[platform] — non-envelope: 307 redirect, Location header `<base>/?oauth=<OauthFlag>&...` (no JSON body)
/** GET /api/auth/callback/[platform] — query params (path param platform: "shopee" | "tiktok") */
export interface AuthCallbackQuery { code?: string; error?: string; state?: string; shop_id?: string }

/** GET /api/auth/callback/[platform] — oauth outcome flag surfaced in redirect query */
export type OauthFlag = "invalid_platform" | "denied" | "invalid_state" | "state_platform_mismatch" | "expired_state" | "state_seller_mismatch" | "connected" | "failed";

/** GET /api/auth/callback/[platform] — documented non-envelope redirect descriptor */
export type CallbackResponse = { status: 307; location: `${string}/?oauth=${OauthFlag}${string}` };

// ------------------------------------------------------------
// §3 Platform & Operations
// Health/metrics probes, scheduled cron ticks (x-cron-secret header), and
// inbound provider webhooks (HMAC-signed).
// ------------------------------------------------------------

/** GET /api/metrics — per-route performance entry */
export interface MetricsRouteEntry { label: string; count: number; avgMs: number; minMs: number; maxMs: number; p50: number; p90: number; p95: number; p99: number; errors: number; lastErrorAt: string | null; maxInFlight: number; inFlight: number; dbMsTotal: number; dbCountTotal: number; dbAvgMsPerReq: number; byStatus: Record<string, number> }

/** GET /api/metrics — bounded process/route/DB performance snapshot payload */
export interface MetricsData { ts: string; uptimeSec: number; process: { pid: number; nodeVersion: string; rssMb: number; heapUsedMb: number; heapTotalMb: number; fdCount: number; fdLimit: number }; eventLoopLag: { lastMs: number; p95Ms: number; maxMs: number; samples: number }; memoryTrend: { rssDeltaMb60s: number; samples: number } | null; inFlight: { now: number; max: number }; totals: { requests: number; errors: number; errorRate: number; startedAt: string }; events: { key: string; count: number; lastAt: string }[]; routes: MetricsRouteEntry[]; db: { note: string; aggregates: { key: string; count: number; avgMs: number; maxMs: number; errors: number }[]; slowRing: { model: string; op: string; ms: number; route: string | null; ts: string }[] }; prismaMetrics: { available: true; pool: Record<string, number>; waitP95Ms: number | null; waitMaxMs: number | null } | { available: false; reason: string } }

/** GET /api/metrics — response (manual Response.json({data}), envelope-conformant) */
export type MetricsResponse = ApiOk<MetricsData>;

/** GET /api/health — query params (fresh="1" bypasses 60s invariant cache; default null) */
export interface HealthQuery { fresh?: "1" | null }

/** GET /api/health — system heartbeat payload (DB counts, deployment fingerprint, ledger invariants, checkout gate) */
export interface HealthData { status: "healthy" | "unhealthy"; db: string; deployment: { nodeEnv: string; dbFingerprint: string }; counts: { stores: number; products: number; orders: number }; ledgerInvariants: { ok: boolean; txnCount: number; walletCount: number; hardProblems: string[]; hardDriftCount: number; timeMaturityStaleness: { count: number; magnitudeMinor: number; note: string } }; checkoutGate: { inflight: number; waiting: number; maxInflight: number; maxWaiting: number; waitMs: number }; invariantCachedAt: string | null; time: string }

/** GET /api/health — response (ledger problems flip status field, not HTTP code) */
export type HealthResponse = ApiOk<HealthData>;

/** GET /api/health/live — process-only liveness payload (no DB access) */
export interface HealthLiveData { status: "live"; uptimeSec: number; eventLoopLagP95Ms: number; rssMb: number; heapUsedMb: number; fdCount: number; dbQueried: false; time: string }

/** GET /api/health/live — response */
export type HealthLiveResponse = ApiOk<HealthLiveData>;

/** GET /api/health/ready — readiness payload (one SELECT 1 raced against 1.2s timeout) */
export interface HealthReadyData { status: "ready"; db: "up"; dbProbeMs: number; time: string }

/** GET /api/health/ready — response */
export type HealthReadyResponse = ApiOk<HealthReadyData>;
// NOTE GET /api/health/ready — 503 NOT_READY error body deviates from ApiErr envelope: { code, message, dbProbeMs: number, meta?: { refId: string } } (prod-sanitized)

/** GET /api/health/scheduler — per-cron-rail verdict entry (from durable cron.* Setting rows) */
export interface SchedulerRail { key: string; ageSeconds: number | null; verdict: "fresh" | "stale" | "missing"; note: string; recordedAt: string | null; cadenceSec: number; outcome: Record<string, unknown> | null }

/** GET /api/health/scheduler — scheduler heartbeat payload (expiry-sweep age decides healthy vs stale) */
export interface SchedulerData { status: "healthy" | "stale"; expirySweep: { key: string; ageSeconds: number | null; healthyWithinSec: number; verdict: "fresh" | "stale" | "missing" }; staleRails: string[]; freshestAgeSeconds: number | null; evaluatedAt: string; cadenceBaseSec: number; staleFactor: number; auth: "secret-required" | "fail-closed" | "dev-open"; rails: SchedulerRail[]; schedulingNote: string; monitoringHint: string }

/** GET /api/health/scheduler — response */
export type SchedulerResponse = ApiOk<SchedulerData>;

/** GET /api/platform/terms — public platform terms payload (global business policy, 60s TTL cache) */
export interface PlatformTermsData { commissionPercent: number; commissionSource: "global_default"; fixedFeeMinor: number; hasFixedFee: boolean; minCommissionMinor: number; hasMinCommission: boolean; holdDays: number; holdSource: "global_default"; payoutMinMinor: number; moderationFirstN: number }

/** GET /api/platform/terms — response */
export type PlatformTermsResponse = ApiOk<PlatformTermsData>;

/** GET /api/settings/site — site appearance payload (footer visibility from Setting key ui.footer_visible) */
export interface SiteSettingsData { footerVisible: boolean }

/** GET /api/settings/site — response */
export type SiteSettingsResponse = ApiOk<SiteSettingsData>;

/** POST /api/orders/expiry/tick — expiry-sweep tick payload (group-stat fields present only when throttled:false) */
export interface ExpiryTickData { examined?: number; expired?: number; ordersExpired?: number; itemsRestocked?: number; skippedConcurrent?: number; anomalies?: number; failures?: number; vouchersRestored?: number; couponsRestored?: number; scanned: number; released: number; skipped: number; errors: { orderId: string; error: string }[]; throttled: boolean; auth: "secret-required" | "fail-closed" | "dev-open" }

/** POST /api/orders/expiry/tick — response (manual trigger) */
export type ExpiryTickResponse = ApiOk<ExpiryTickData>;

/** POST /api/cron/session-purge — successful purge run variant */
export interface SessionPurgeRunData { purged: number; otpChallengesPurged: number; durationMs: number; at: string; auth: "secret-required" | "fail-closed" | "dev-open" }

/** POST /api/cron/session-purge — in-process-throttled variant */
export interface SessionPurgeThrottledData { throttled: true; purged: 0; auth: string }

/** POST /api/cron/session-purge — response (run | throttled) */
export type SessionPurgeResponse = ApiOk<SessionPurgeRunData | SessionPurgeThrottledData>;

/** GET /api/cron/session-purge — purge observability payload (note: lastRun.auth is loose string, unlike POST) */
export interface SessionPurgeStatusData { expiredBacklog: number; lastRun: { purged: number; otpChallengesPurged: number; durationMs: number; at: string; auth: string } | null; auth: string }

/** GET /api/cron/session-purge — response */
export type SessionPurgeStatusResponse = ApiOk<SessionPurgeStatusData>;

/** POST /api/cron/expiry-sweep — full sweep outcome (shared runExpirySweep result) */
export interface ExpirySweepOutcome { examined: number; expired: number; ordersExpired: number; itemsRestocked: number; skippedConcurrent: number; anomalies: number; failures: number; vouchersRestored: number; couponsRestored: number; scanned: number; released: number; skipped: number; errors: { orderId: string; error: string }[]; throttled: boolean; remainingBacklog: number; durationMs: number; at: string; auth: string }

/** POST /api/cron/expiry-sweep — in-process-throttled variant (1.5s) */
export interface ExpirySweepThrottledData { throttled: true; expired: 0; auth: string }

/** POST /api/cron/expiry-sweep — response (outcome | throttled) */
export type ExpirySweepResponse = ApiOk<ExpirySweepOutcome | ExpirySweepThrottledData>;

/** GET /api/cron/expiry-sweep — expiry observability payload */
export interface ExpirySweepStatusData { backlog: number; oldestExpiredAt: string | null; lastRun: ExpirySweepOutcome | null; auth: string; schedulingNote: string }

/** GET /api/cron/expiry-sweep — response */
export type ExpirySweepStatusResponse = ApiOk<ExpirySweepStatusData>;

/** POST /api/cron/refund-reconcile — late-payment refund tick payload (batch 25, idempotent provider refunds) */
export interface RefundReconcileData { examined: number; attempted: number; succeeded: number; failed: number; unknown: number; skippedNoAdapter: number; skippedSandboxDisabled: number; skippedBackoff: number; skippedExhausted: number; transientErrors: number; faultsApplied: number; at: string; durationMs: number; backoffMs: number; maxAttempts: number; batchLimit: number; auth: string }

/** POST /api/cron/refund-reconcile — response */
export type RefundReconcileResponse = ApiOk<RefundReconcileData>;

/** GET /api/cron/refund-reconcile — reconcile observability payload */
export interface RefundReconcileStatusData { counts: Record<string, number>; oldestOpenCase: { createdAt: string; provider: string } | null; awaitingOperator: number; lastRun: { examined: number; attempted: number; succeeded: number; failed: number; unknown: number; skippedNoAdapter: number; skippedSandboxDisabled: number; skippedBackoff: number; skippedExhausted: number; transientErrors: number; faultsApplied: number; at: string; durationMs: number; backoffMs: number; maxAttempts: number; batchLimit: number; auth: string } | null; auth: string; statuses: string[] }

/** GET /api/cron/refund-reconcile — response */
export type RefundReconcileStatusResponse = ApiOk<RefundReconcileStatusData>;

/** POST /api/cron/order-maintenance — order lifecycle tick outcome (auto-receipt, auto-complete, mock shipments) */
export interface OrderMaintenanceOutcome { ranAt: string; durationMs: number; autoReceipt: { candidates: number; received: number; cutoff: string }; autoComplete: { candidates: number; completed: number; cutoff: string }; tracking: { scanned: number; advanced: number }; errors: string[]; auth: string }

/** POST /api/cron/order-maintenance — in-process-throttled variant (20s) */
export interface OrderMaintenanceThrottledData { throttled: true; skippedForMs: number; auth: string }

/** POST /api/cron/order-maintenance — response (outcome | throttled) */
export type OrderMaintenanceResponse = ApiOk<OrderMaintenanceOutcome | OrderMaintenanceThrottledData>;

/** GET /api/cron/order-maintenance — maintenance observability payload */
export interface OrderMaintenanceStatusData { lastRun: OrderMaintenanceOutcome | null; autoReceiptBacklog: number; autoCompleteBacklog: number; inflightMockShipments: number }

/** GET /api/cron/order-maintenance — response */
export type OrderMaintenanceStatusResponse = ApiOk<OrderMaintenanceStatusData>;

/** POST /api/cron/affiliate-tick — commission lifecycle tick payload */
export interface AffiliateTickData { approved: number; matured: number; remainingPending: number; durationMs: number; at: string; authMode: string }

/** POST /api/cron/affiliate-tick — response */
export type AffiliateTickResponse = ApiOk<AffiliateTickData>;

/** GET /api/cron/affiliate-tick — affiliate tick observability payload */
export interface AffiliateTickStatusData { last: { approved: number; matured: number; remainingPending: number; durationMs: number; at: string; authMode: string } | null }

/** GET /api/cron/affiliate-tick — response */
export type AffiliateTickStatusResponse = ApiOk<AffiliateTickStatusData>;

/** POST /api/cron/webhook-delivery — webhook retry sweep outcome */
export interface WebhookSweepOutcome { scanned: number; attempted: number; succeeded: number; retried: number; failedFinal: number; skippedNotDue: number; skippedInactive: number; skippedOther: number; unsubscribedFailed: number; staleFailed: number; errors: number; remainingBacklog: number | null; durationMs: number; at: string; schedule: string }

/** POST /api/cron/webhook-delivery — in-process-throttled variant (5s) */
export interface WebhookDeliveryThrottledData { throttled: true; attempted: 0; auth: string }

/** POST /api/cron/webhook-delivery — response (outcome | throttled) */
export type WebhookDeliverySweepResponse = ApiOk<WebhookSweepOutcome | WebhookDeliveryThrottledData>;

/** GET /api/cron/webhook-delivery — webhook observability payload (incl. receiver signing contract) */
export interface WebhookDeliveryStatusData { backlog: number | null; dueNowApprox: number | null; oldestPending: { createdAt: string; event: string; attempts: number } | null; lastRun: WebhookSweepOutcome | null; auth: string; schedulingNote: string; receiverContract: string }

/** GET /api/cron/webhook-delivery — response */
export type WebhookDeliveryStatusResponse = ApiOk<WebhookDeliveryStatusData>;

/** POST /api/cron/analytics-tick — analytics retention tick payload (flush queue + purge old events) */
export interface AnalyticsTickData { ranAt: string; durationMs: number; retentionDays: number; cutoff: string; purged: number; flush: { flushed: number; pending: number }; remaining: number; oldestEventAt: string | null; auth: string }

/** POST /api/cron/analytics-tick — response */
export type AnalyticsTickResponse = ApiOk<AnalyticsTickData>;

/** GET /api/cron/analytics-tick — analytics observability payload */
export interface AnalyticsTickStatusData { total: number; byType: Record<string, number>; oldestEventAt: string | null; retentionDays: number; queue: { pending: number; dropped: number; flushed: number; lastFlushAt: string | null; lastError: string | null; lastErrorAt: string | null }; lastRun: { ranAt: string; durationMs: number; retentionDays: number; cutoff: string; purged: number; flush: { flushed: number; pending: number }; remaining: number; oldestEventAt: string | null; auth: string } | null; auth: string }

/** GET /api/cron/analytics-tick — response */
export type AnalyticsTickStatusResponse = ApiOk<AnalyticsTickStatusData>;

/** POST /api/webhooks/payments/[provider] — payment webhook body (path param provider: string; HMAC over "<providerRef>.<eventType>.<amountMinor>.<ts>") */
export interface PaymentWebhookBody { providerRef: string; eventType: "payment.succeeded" | "payment.failed" | "payout.succeeded" | "payout.failed"; amountMinor: number; ts: number; sig?: string; reason?: string }

/** POST /api/webhooks/payments/[provider] — claim-first idempotent ingestion payload */
export interface PaymentWebhookData { ok: boolean; duplicate: boolean; orderNumber: string; orderStatus: string }

/** POST /api/webhooks/payments/[provider] — response */
export type PaymentWebhookResponse = ApiOk<PaymentWebhookData>;

/** POST /api/webhooks/payments/payout-simulate — payout simulate (sandbox) request body */
export interface PayoutSimulateBody { referenceNo: string; result?: "succeeded" | "failed"; reason?: string }

/** POST /api/webhooks/payments/payout-simulate — pipeline emit payload */
export interface PayoutSimulateData { ok: boolean; duplicate: boolean; eventType: string; orderNumber: string; orderStatus: string; intentStatus: string; orderNumbers?: string[]; isGroup?: boolean; payoutConflict?: boolean; referenceNo: string; payoutStatus: string }

/** POST /api/webhooks/payments/payout-simulate — response */
export type PayoutSimulateResponse = ApiOk<PayoutSimulateData>;

/** POST /api/webhooks/email/resend — Resend email webhook body (Svix-scheme HMAC over RAW body) */
export interface ResendEventBody { type?: string; created_at?: string; data?: { email_id?: string; email?: string; to?: string[]; subject?: string; bounce?: { type?: string } } }

/** POST /api/webhooks/email/resend — exactly-once ingestion payload (by svix-id) */
export interface ResendWebhookData { received: boolean; duplicate: boolean; eventType: string }

/** POST /api/webhooks/email/resend — response */
export type ResendWebhookResponse = ApiOk<ResendWebhookData>;

/** POST /api/shipping/tick — shipping tick (sandbox) payload */
export interface ShippingTickData { advanced: number; throttled: boolean; results: { shipmentId: string; orderId: string; awbNumber: string | null; status: string }[] }

/** POST /api/shipping/tick — response */
export type ShippingTickResponse = ApiOk<ShippingTickData>;

/** POST /api/shipping/webhook/[provider] — courier tracking webhook body (path param provider: string; status values documented as BOOKED|PICKED_UP|IN_TRANSIT|OUT_FOR_DELIVERY|DELIVERED|EXCEPTION|RETURNED; HMAC over "<awb>.<status>.<ts>") */
export interface ShippingWebhookBody { event?: string; awb?: string; trackingNumber?: string; orderNumber?: string; status: string; description?: string; location?: string; occurredAt?: string; ts: number; sig?: string }

/** POST /api/shipping/webhook/[provider] — tracking ingestion payload */
export interface ShippingWebhookData { orderNumber: string; shipmentStatus: string; ignored?: boolean }

/** POST /api/shipping/webhook/[provider] — response */
export type ShippingWebhookResponse = ApiOk<ShippingWebhookData>;
// ============================================================
// §4 Public Marketplace & Storefront
// §5 Cart & Checkout
// §6 Orders, Receipts & Guest Access
// ============================================================

// ------------------------------------------------------------
// §4 Public Marketplace & Storefront
// ------------------------------------------------------------

/** GET /api/sf/app-config — platform chrome config payload */
export interface SfAppConfigData {
  footerVisible: boolean;
}
/** GET /api/sf/app-config — platform chrome config */
export type SfAppConfigResponse = ApiOk<SfAppConfigData>;

/** GET /api/sf/[slug] — storefront section (system-assembled CMS block) */
export interface SfSection {
  id: string;
  type: string;
  props: Record<string, unknown>;
}
/** GET /api/sf/[slug] — storefront theme (primary/accent colors, fonts, radius, button style) */
export interface SfTheme {
  primaryColor: string;
  accentColor: string;
  fontHeading: string;
  fontBody: string;
  radius: string;
  buttonStyle: string;
}
/** GET /api/sf/[slug] — storefront product-card typography/alignment style */
export interface SfCardStyle {
  nameFont: string;
  nameSize: string;
  nameAlign: string;
  priceFont: string;
  priceSize: string;
  priceAlign: string;
}
/** GET /api/sf/[slug] — storefront home payload */
export interface SfHomeData {
  store: {
    id: string;
    name: string;
    slug: string;
    tagline: string | null;
    logoUrl: string | null;
    bannerUrl: string | null;
    description: string | null;
    theme: SfTheme;
    whatsapp: string | null;
    supportEmail: string | null;
    supportPhone: string | null;
    social: Record<string, string>;
    followers: number;
    cardStyle: SfCardStyle | null;
    display: { showStars: boolean; metric: string };
    categories: { id: string; name: string; sortOrder: number }[];
  };
  page: { id: string; title: string; slug: string; sections: SfSection[]; publishedVersion: number };
}
/** GET /api/sf/[slug] — storefront home */
export type SfHomeResponse = ApiOk<SfHomeData>;

/** GET /api/sf/[slug]/cart-settings — upsell/best-seller product card (with stock) */
export interface UpsellCard {
  id: string;
  slug: string;
  title: string;
  priceMinor: number;
  compareAtPriceMinor: number | null;
  variantId: string | null;
  imageUrl: string;
  storeName: string;
  storeSlug: string;
  ratingAvg: number;
  ratingCount: number;
  viewCount: number;
  salesCount: number;
  categoryName: string | null;
  stock: number;
}
/** GET /api/sf/[slug]/cart-settings — cart drawer configuration DTO */
export interface CartSettingsDTO {
  layout: string;
  showFreeShippingBar: boolean;
  freeShipThresholdMinor: number;
  upsellEnabled: boolean;
  upsellMode: string;
  upsellTitle: string;
  upsellLimit: number;
  urgencyStockEnabled: boolean;
  urgencyStockThreshold: number;
  urgencyViewersEnabled: boolean;
  urgencyViewersMin: number;
  urgencyViewersMax: number;
  urgencyCountdownEnabled: boolean;
  urgencyCountdownMinutes: number;
  showOrderNote: boolean;
  showDiscountHint: boolean;
  checkoutLabel: string;
  showContinueShopping: boolean;
  stickyCta: boolean;
  trustBadges: string[];
}
/** GET /api/sf/[slug]/cart-settings — cart drawer config payload */
export interface SfCartSettingsData {
  store: { id: string; name: string; slug: string; theme: SfTheme };
  settings: CartSettingsDTO | null;
  upsell: UpsellCard[];
  bestSellers: UpsellCard[];
}
/** GET /api/sf/[slug]/cart-settings — cart drawer config */
export type SfCartSettingsResponse = ApiOk<SfCartSettingsData>;

/** POST /api/sf/[slug]/newsletter — newsletter subscribe request */
export interface NewsletterBody {
  email: string;
}
/** POST /api/sf/[slug]/newsletter — newsletter subscribe payload */
export interface NewsletterData {
  subscribed: boolean;
}
/** POST /api/sf/[slug]/newsletter — newsletter subscribe */
export type NewsletterResponse = ApiOk<NewsletterData>;

/** GET /api/sf/[slug]/pages/[pageSlug] — published CMS page payload */
export interface SfPageData {
  store: {
    id: string;
    name: string;
    slug: string;
    tagline: string | null;
    logoUrl: string | null;
    whatsapp: string | null;
    supportEmail: string | null;
    theme: SfTheme;
    cardStyle: SfCardStyle | null;
  };
  page: { id: string; title: string; slug: string; pageType: string; publishedVersion: number };
  sections: SfSection[];
}
/** GET /api/sf/[slug]/pages/[pageSlug] — published CMS page */
export type SfPageResponse = ApiOk<SfPageData>;

/** GET /api/sf/[slug]/products & /api/market/* — public product card */
export interface SfProductCard {
  id: string;
  slug: string;
  title: string;
  priceMinor: number;
  compareAtPriceMinor: number | null;
  variantId: string | null;
  imageUrl: string;
  storeName: string;
  storeSlug: string;
  ratingAvg: number;
  ratingCount: number;
  viewCount: number;
  salesCount: number;
  categoryName: string | null;
}
/** GET /api/sf/[slug]/products — storefront listing query params */
export interface SfProductsQuery {
  search?: string;
  collection?: string;
  source?: "latest" | "featured";
  category?: string;
  limit?: number;
}
/** GET /api/sf/[slug]/products — storefront product listing (fixed window, no meta) */
export type SfProductsResponse = ApiOk<SfProductCard[]>;

/** GET /api/sf/[slug]/products/[pSlug] — PDP variant row */
export interface PdpVariant {
  id: string;
  name: string;
  optionName: string | null;
  optionValue: string | null;
  priceMinor: number;
  compareAtPriceMinor: number | null;
  stock: number;
  moq: number;
  sku: string | null;
  isActive: boolean;
  imageUrl: string | null;
  lowStockThreshold: number;
}
/** GET /api/sf/[slug]/products/[pSlug] — full PDP payload */
export interface PdpData {
  product: {
    id: string;
    title: string;
    slug: string;
    description: string | null;
    priceMinor: number;
    compareAtPriceMinor: number | null;
    ratingAvg: number;
    ratingCount: number;
    salesCount: number;
    viewCount: number;
    categoryId: string | null;
    categoryName: string | null;
    images: string[];
    ratingDist: number[];
    variants: PdpVariant[];
  };
  reviews: SfReviewItem[];
  related: SfProductCard[];
  store: {
    id: string;
    name: string;
    slug: string;
    tagline: string | null;
    logoUrl: string | null;
    whatsapp: string | null;
    cardStyle: SfCardStyle | null;
  };
}
/** GET /api/sf/[slug]/products/[pSlug] — product detail (PDP) */
export type PdpResponse = ApiOk<PdpData>;

/** GET+POST /api/sf/[slug]/products/[pSlug]/reviews — published review item */
export interface SfReviewItem {
  id: string;
  orderId: string | null;
  customerName: string;
  rating: number;
  title: string | null;
  body: string | null;
  reply: string | null;
  createdAt: string;
}
/** GET /api/sf/[slug]/products/[pSlug]/reviews — reviews listing query params */
export interface SfReviewsQuery {
  star?: "1" | "2" | "3" | "4" | "5";
  sort?: "recent" | "highest" | "lowest";
  page?: number;
  size?: number;
}
/** GET /api/sf/[slug]/products/[pSlug]/reviews — reviews listing payload */
export interface SfReviewsListData {
  reviews: SfReviewItem[];
}
/** GET /api/sf/[slug]/products/[pSlug]/reviews — reviews listing (paged) */
export type SfReviewsListResponse = ApiPage<SfReviewsListData>;

/** POST /api/sf/[slug]/products/[pSlug]/reviews — review submission request */
export interface ReviewSubmitBody {
  rating: number;
  customerName?: string;
  title?: string | null;
  body?: string | null;
}
/** POST /api/sf/[slug]/products/[pSlug]/reviews — review submission payload */
export interface ReviewSubmitData {
  id: string;
  status: string;
  orderCompleted: boolean;
  reward: { credited: boolean; points: number; minorEquivalent: number };
  message: string;
}
/** POST /api/sf/[slug]/products/[pSlug]/reviews — review submission */
export type ReviewSubmitResponse = ApiOk<ReviewSubmitData>;

/** GET /api/sf/[slug]/products/[pSlug]/reviews/eligibility — review eligibility payload */
export interface SfReviewEligibilityData {
  eligible: boolean;
  reason: "already_reviewed" | "own_product" | "ok" | "no_eligible_order";
  review?: { id: string; status: string; rating: number };
}
/** GET /api/sf/[slug]/products/[pSlug]/reviews/eligibility — review eligibility probe */
export type SfReviewEligibilityResponse = ApiOk<SfReviewEligibilityData>;

/** GET /api/market/home — marketplace hero/promo CTA descriptor */
export interface MarketCta {
  kind: "search" | "category" | "store" | "deals" | "vouchers" | "external";
  q?: string;
  slug?: string;
  url?: string;
}
/** GET /api/market/home & GET /api/campaigns/active — marketplace campaign theme (accent/gradient/copy) */
export interface MarketTheme {
  accent: string;
  accentSoft: string;
  gradientFrom: string;
  gradientTo: string;
  greeting: string;
  greetingBm: string;
  tagline: string;
  taglineBm: string;
  ornament: string;
}
/** GET /api/market/home — marketplace landing aggregate payload */
export interface MarketHomeData {
  banners: { id: string; title: string; imageUrl: string; linkUrl: string | null }[];
  categories: {
    id: string;
    name: string;
    slug: string;
    imageUrl: string | null;
    children: { id: string; name: string; slug: string }[];
  }[];
  featured: SfProductCard[];
  latest: SfProductCard[];
  trending: SfProductCard[];
  featuredStores: {
    id: string;
    name: string;
    slug: string;
    tagline: string | null;
    logoUrl: string | null;
    bannerUrl: string | null;
    productCount: number;
  }[];
  sectionOrder: (
    | "hero"
    | "quick_access"
    | "showcase"
    | "flash_deals"
    | "categories"
    | "trending"
    | "featured"
    | "stores"
    | "new_arrivals"
    | "inline"
  )[];
  hero: {
    id: string;
    kind: "campaign" | "banner";
    name: string;
    description: string | null;
    ctaLabel: string;
    cta: MarketCta | null;
    endsAt: string;
    title: string;
    subtext: string | null;
    imageUrl: string | null;
    mobileImageUrl: string | null;
    theme: MarketTheme | null;
  }[];
  heroSecondary: {
    id: string;
    name: string;
    description: string | null;
    ctaLabel: string;
    cta: MarketCta | null;
    endsAt: string;
    heading: string;
    subtext: string | null;
    imageUrl: string | null;
    mobileImageUrl: string | null;
    theme: MarketTheme;
  }[];
  promoTiles: { id: string; name: string; theme: MarketTheme; cta: MarketCta | null }[];
  showcase: {
    id: string;
    name: string;
    description: string | null;
    ctaLabel: string;
    cta: MarketCta | null;
    endsAt: string;
    thumbnailUrl: string | null;
    theme: MarketTheme;
  }[];
  inline: {
    id: string;
    name: string;
    description: string | null;
    ctaLabel: string;
    cta: MarketCta | null;
    endsAt: string;
    heading: string;
    subtext: string | null;
    bannerDesktopUrl: string | null;
    bannerMobileUrl: string | null;
    productQuery: string | null;
    products: SfProductCard[];
    theme: MarketTheme;
  }[];
  flashDeals: { products: SfProductCard[]; campaign: { id: string; name: string; endAt: string } | null };
}
/** GET /api/market/home — marketplace landing aggregate */
export type MarketHomeResponse = ApiOk<MarketHomeData>;

/** GET /api/market/products — marketplace listing query params */
export interface MarketProductsQuery {
  search?: string;
  category?: string;
  sort?: "relevance" | "newest" | "price_asc" | "price_desc" | "popular";
  page?: number;
  size?: number;
  onSale?: "1" | "true";
}
/** GET /api/market/products — marketplace product listing (paged) */
export type MarketProductsResponse = ApiPage<SfProductCard[]>;

/** GET /api/market/stores — public store directory card */
export interface MarketStoreCard {
  id: string;
  name: string;
  slug: string;
  tagline: string | null;
  logoUrl: string | null;
  bannerUrl: string | null;
  productCount: number;
}
/** GET /api/market/stores — store directory (unpaginated full list, no meta) */
export type MarketStoresResponse = ApiOk<MarketStoreCard[]>;

/** GET /api/market/search/suggest — autocomplete query params */
export interface MarketSuggestQuery {
  q?: string;
}
/** GET /api/market/search/suggest — autocomplete payload */
export interface MarketSuggestData {
  products: SfProductCard[];
  stores: { name: string; slug: string; logoUrl: string }[];
}
/** GET /api/market/search/suggest — search autocomplete */
export type MarketSuggestResponse = ApiOk<MarketSuggestData>;

/** GET /api/market/search/related — related-products query params */
export interface MarketRelatedQuery {
  q?: string;
  exclude?: string;
  limit?: number;
}
/** GET /api/market/search/related — related products payload */
export interface MarketRelatedData {
  products: SfProductCard[];
}
/** GET /api/market/search/related — related products */
export type MarketRelatedResponse = ApiOk<MarketRelatedData>;

// GET /api/img/[seed] — non-envelope: image/svg+xml SVG placeholder document (gradient initials tile, or shopping-bag glyph when icon=product); Cache-Control: public, max-age=31536000, immutable

/** GET /api/campaigns/active — highest-priority live published campaign (or null) */
export interface MarketActiveCampaignData {
  id: string;
  name: string;
  presetId: string | null;
  isPublished: boolean;
  placement: "hero" | "hero_secondary" | "promo_tile" | "showcase" | "inline";
  startAt: string;
  endAt: string;
  theme: MarketTheme;
  daysLeft: number;
}
/** GET /api/campaigns/active — active campaign (nullable) */
export type MarketActiveCampaignResponse = ApiOk<MarketActiveCampaignData | null>;

/** POST /api/analytics/pdp-event — PDP funnel micro-event beacon request */
export interface PdpEventBody {
  eventType: string;
  storeId: string;
  productId?: string | null;
  variantId?: string | null;
  qty?: number | null;
}
/** POST /api/analytics/pdp-event — PDP event beacon payload */
export interface PdpEventData {
  recorded: boolean;
}
/** POST /api/analytics/pdp-event — PDP event beacon */
export type PdpEventResponse = ApiOk<PdpEventData>;

/** POST /api/analytics/landing — landing attribution beacon request */
export interface LandingBody {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  nmcl?: string;
  sf?: string;
}
/** POST /api/analytics/landing — landing attribution payload */
export interface LandingData {
  captured: boolean;
}
/** POST /api/analytics/landing — attribution beacon */
export type LandingResponse = ApiOk<LandingData>;

/** GET+POST /api/stores/[slug]/follow — follow state / toggle payload */
export interface StoreFollowData {
  following: boolean;
  followers: number;
}
/** GET /api/stores/[slug]/follow — follow state */
export type StoreFollowResponse = ApiOk<StoreFollowData>;
/** POST /api/stores/[slug]/follow — follow toggle */
export type StoreFollowToggleResponse = ApiOk<StoreFollowData>;

// ------------------------------------------------------------
// §5 Cart & Checkout
// ------------------------------------------------------------

/** GET /api/cart — per-seller cart store summary */
export interface CartStore {
  storeId: string;
  storeSlug: string;
  storeName: string;
  itemCount: number;
  subtotalMinor: number;
}
/** Cart endpoints — cart line item */
export interface CartItem {
  id: string;
  variantId: string;
  productId: string;
  title: string;
  productSlug: string;
  variantLabel: string;
  unitPriceMinor: number;
  compareAtPriceMinor: number | null;
  qty: number;
  stock: number;
  moq: number;
  lineTotalMinor: number;
  imageUrl: string;
  storeId: string;
  storeSlug: string;
  storeName: string;
  selected: boolean;
}
/** Cart endpoints — caller's cart view (account cart or token-keyed guest cart) */
export interface CartView {
  id: string | null;
  storeId: string | null;
  storeSlug: string | null;
  storeName: string | null;
  token: string | null;
  stores: CartStore[];
  items: CartItem[];
}
/** GET /api/cart — get-caller-cart payload */
export interface GetCartData {
  cart: CartView;
  requiresAuth: boolean;
}
/** GET /api/cart — get-caller-cart */
export type GetCartResponse = ApiOk<GetCartData>;

/** POST /api/cart/items — add-to-cart request */
export interface AddCartItemBody {
  variantId: string;
  qty?: number;
}
/** POST /api/cart/items — add-to-cart payload */
export interface AddCartItemData {
  cart: CartView;
  notice: string | null;
}
/** POST /api/cart/items — add-to-cart */
export type AddCartItemResponse = ApiOk<AddCartItemData>;

/** PATCH /api/cart/items/[id] — update-cart-item request */
export interface UpdateCartItemBody {
  qty?: number;
  selected?: boolean;
}
/** PATCH+DELETE /api/cart/items/[id] — cart mutation payload */
export interface UpdateCartItemData {
  cart: CartView;
}
/** PATCH /api/cart/items/[id] — update-cart-item */
export type UpdateCartItemResponse = ApiOk<UpdateCartItemData>;

/** DELETE /api/cart/items/[id] — remove-cart-item payload */
export interface DeleteCartItemData {
  cart: CartView;
}
/** DELETE /api/cart/items/[id] — remove-cart-item */
export type DeleteCartItemResponse = ApiOk<DeleteCartItemData>;

/** PATCH /api/cart/selection — bulk-selection request */
export interface CartSelectionBody {
  itemIds: string[];
  selected: boolean;
}
/** PATCH /api/cart/selection — bulk-selection payload */
export interface CartSelectionData {
  cart: CartView;
}
/** PATCH /api/cart/selection — bulk-selection */
export type CartSelectionResponse = ApiOk<CartSelectionData>;

/** GET /api/cart/stock — stock-probe query params */
export interface StockProbeQuery {
  ids: string;
}
/** GET /api/cart/stock — stock-probe payload */
export interface StockProbeData {
  stocks: Record<string, { stock: number; moq: number; purchasable: boolean }>;
}
/** GET /api/cart/stock — stock-probe */
export type StockProbeResponse = ApiOk<StockProbeData>;

/** POST /api/checkout/quote — quote request */
export interface QuoteBody {
  storeSlug?: string;
  items?: { variantId: string; qty: number }[];
  couponCode?: string | null;
  shippingRateId?: string | null;
  state?: string | null;
  userVoucherId?: string;
  vouchers?: { storeId: string; userVoucherId: string }[];
}
/** POST /api/checkout/quote — coupon verdict */
export interface QuoteCoupon {
  code: string;
  valid: boolean;
  discountMinor?: number;
  freeShip?: boolean;
  reason?: string;
}
/** POST /api/checkout/quote — wallet voucher verdict */
export interface QuoteVoucher {
  storeId: string;
  userVoucherId: string;
  valid: boolean;
  reason: string | null;
  code: string | null;
  title: string | null;
  kind: string | null;
  discountMinor: number;
  freeShipping: boolean;
  fsPriceAdjustMinor: number | null;
}
/** POST /api/checkout/quote — quoted line item */
export interface QuoteItem {
  title: string;
  variantLabel: string | null;
  qty: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  stock: number;
  moq: number;
  storeId?: string;
  storeSlug?: string;
  storeName?: string;
}
/** POST /api/checkout/quote — per-seller quote group (multi-seller branch) */
export interface QuoteGroup {
  storeId: string;
  storeSlug: string;
  storeName: string;
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  totalMinor: number;
  itemCount: number;
  couponApplied: boolean;
  voucher: QuoteVoucher | null;
}
/** POST /api/checkout/quote — available shipping option */
export interface ShippingOption {
  id: string;
  label: string;
  eta: string;
  amountMinor: number;
  freeShipping: boolean;
  available: boolean;
  reason: string | null;
}
/** POST /api/checkout/quote — server-recomputed totals payload (legacy branch: +voucher/commissionPreviewMinor, no groups; multi branch: +groups) */
export interface QuoteData {
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  totalMinor: number;
  shippingRateId: string;
  coupon: QuoteCoupon;
  voucher?: QuoteVoucher | null;
  items: QuoteItem[];
  groups?: QuoteGroup[];
  shippingOptions: ShippingOption[];
  commissionPreviewMinor?: number;
}
/** POST /api/checkout/quote — quote */
export type QuoteResponse = ApiOk<QuoteData>;

/** POST /api/checkout/create — create-checkout request (header Idempotency-Key required) */
export interface CreateCheckoutBody {
  customer?: { name?: string; email?: string; phone?: string | null };
  provider?: string;
  items?: { variantId: string; qty: number }[];
  shippingAddress?: { line1?: string; city?: string; state?: string; postcode?: string };
  couponCode?: string | null;
  shippingRateId?: string | null;
  vouchers?: { storeId: string; userVoucherId: string }[];
  guestVerification?: string;
  customerNote?: string | null;
}
/** POST /api/checkout/create — applied wallet voucher summary */
export interface VoucherApplied {
  storeId: string;
  code: string | null;
  title: string | null;
  kind: string | null;
  discountMinor: number;
  freeShipping: boolean;
  fsPriceAdjustMinor: number | null;
}
/** POST /api/checkout/create — create-checkout payload (201 fresh vs 200 replay variants) */
export interface CreateCheckoutData {
  orderNumber: string;
  orderNumbers: string[];
  orderPaymentRef: string | null;
  paymentRef: string | null;
  totalMinor: number;
  redirectUrl?: string;
  status: string;
  duplicate?: boolean;
  vouchersApplied?: VoucherApplied[];
}
/** POST /api/checkout/create — create-checkout */
export type CreateCheckoutResponse = ApiOk<CreateCheckoutData>;

/** Checkout address endpoints — saved shopper address */
export interface CheckoutAddress {
  id: string;
  ownerToken: string;
  shopperId: string | null;
  label: string;
  name: string;
  phone: string | null;
  line1: string;
  city: string;
  state: string;
  postcode: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}
/** GET /api/checkout/addresses — list-addresses payload */
export interface ListAddressesData {
  addresses: CheckoutAddress[];
}
/** GET /api/checkout/addresses — list-addresses */
export type ListAddressesResponse = ApiOk<ListAddressesData>;

/** POST /api/checkout/addresses — create-address request */
export interface CreateAddressBody {
  label?: string;
  name: string;
  phone?: string | null;
  line1: string;
  city: string;
  state: string;
  postcode: string;
  isDefault?: boolean;
}
/** POST /api/checkout/addresses — create-address payload */
export interface CreateAddressData {
  address: CheckoutAddress;
  addresses: CheckoutAddress[];
}
/** POST /api/checkout/addresses — create-address */
export type CreateAddressResponse = ApiOk<CreateAddressData>;

/** PATCH /api/checkout/addresses/[id] — update-address request */
export interface UpdateAddressBody {
  label?: string;
  name?: string;
  phone?: string | null;
  line1?: string;
  city?: string;
  state?: string;
  postcode?: string;
  isDefault?: boolean;
}
/** PATCH /api/checkout/addresses/[id] — update-address payload */
export interface UpdateAddressData {
  address: CheckoutAddress;
  addresses: CheckoutAddress[];
}
/** PATCH /api/checkout/addresses/[id] — update-address */
export type UpdateAddressResponse = ApiOk<UpdateAddressData>;

/** DELETE /api/checkout/addresses/[id] — delete-address payload */
export interface DeleteAddressData {
  addresses: CheckoutAddress[];
}
/** DELETE /api/checkout/addresses/[id] — delete-address */
export type DeleteAddressResponse = ApiOk<DeleteAddressData>;

/** GET /api/checkout/payments/[ref] — payment-status payload (group: storeName/storeSlug null, no redirectUrl; intent: sets both) */
export interface PaymentStatusData {
  status: string;
  isGroup: boolean;
  orderNumber: string;
  orderNumbers: string[];
  orderCount: number;
  storeNames: string[];
  storeName: string | null;
  storeSlug: string | null;
  amountMinor: number;
  orderStatus: string;
  provider: string;
  expiresAt: string;
  redirectUrl?: string;
}
/** GET /api/checkout/payments/[ref] — payment-status */
export type PaymentStatusResponse = ApiOk<PaymentStatusData>;

/** POST /api/checkout/payments/[ref]/retry — retry-payment payload */
export interface RetryPaymentData {
  status: string;
}
/** POST /api/checkout/payments/[ref]/retry — retry-payment */
export type RetryPaymentResponse = ApiOk<RetryPaymentData>;

/** POST /api/checkout/payments/[ref]/simulate — simulate-payment request */
export interface SimulatePaymentBody {
  result?: "succeeded" | "failed";
}
/** POST /api/checkout/payments/[ref]/simulate — simulate-payment payload */
export interface SimulatePaymentData {
  status: string;
  orderNumber: string;
  orderNumbers: string[];
  isGroup: boolean;
}
/** POST /api/checkout/payments/[ref]/simulate — simulate-payment */
export type SimulatePaymentResponse = ApiOk<SimulatePaymentData>;

/** POST /api/checkout/guest-verify/request — request-guest-otp request */
export interface GuestVerifyRequestBody {
  email: string;
}
/** POST /api/checkout/guest-verify/request — request-guest-otp payload */
export interface GuestVerifyRequestData {
  sent: boolean;
  message: string;
}
/** POST /api/checkout/guest-verify/request — request-guest-otp */
export type GuestVerifyRequestResponse = ApiOk<GuestVerifyRequestData>;

/** POST /api/checkout/guest-verify/verify — verify-guest-otp request */
export interface GuestVerifyBody {
  email: string;
  code: string;
}
/** POST /api/checkout/guest-verify/verify — verify-guest-otp payload */
export interface GuestVerifyData {
  token: string;
  email: string;
  expiresAt: string;
}
/** POST /api/checkout/guest-verify/verify — verify-guest-otp */
export type GuestVerifyResponse = ApiOk<GuestVerifyData>;

// ------------------------------------------------------------
// §6 Orders, Receipts & Guest Access
// ------------------------------------------------------------

/** GET /api/orders/lookup — guest-order-lookup query params */
export interface GuestOrderLookupQuery {
  orderNumber: string;
}
/** GET /api/orders/lookup — guest-order-lookup payload */
export interface GuestOrderLookupData {
  orderNumber: string;
  status: string;
  totalMinor: number;
  storeName: string;
  storeId: string;
  storeSlug: string;
  createdAt: string;
  items: { title: string; qty: number }[];
  history: { toStatus: string; createdAt: string }[];
}
/** GET /api/orders/lookup — guest-order-lookup */
export type GuestOrderLookupResponse = ApiOk<GuestOrderLookupData>;

// GET /api/orders/receipt — non-envelope: binary PDF receipt stream (application/pdf; Content-Disposition attachment; Cache-Control: no-store)

/** POST /api/orders/otp/request — request-order-otp request */
export interface GuestOrderOtpRequestBody {
  email: string;
  orderNumber: string;
}
/** POST /api/orders/otp/request — request-order-otp payload */
export interface GuestOrderOtpRequestData {
  sent: boolean;
  message: string;
}
/** POST /api/orders/otp/request — request-order-otp */
export type GuestOrderOtpRequestResponse = ApiOk<GuestOrderOtpRequestData>;

/** POST /api/orders/otp/verify — verify-order-otp request */
export interface GuestOrderOtpVerifyBody {
  email: string;
  orderNumber: string;
  code: string;
}
/** POST /api/orders/otp/verify — verify-order-otp payload */
export interface GuestOrderOtpVerifyData {
  accessGrant: string;
  grantExpiresInMs: number;
}
/** POST /api/orders/otp/verify — verify-order-otp */
export type GuestOrderOtpVerifyResponse = ApiOk<GuestOrderOtpVerifyData>;
// ============================================================
// §7 Shopper Account Hub
// §8 Shopper ⇄ Seller Messaging (Chat)
// §9 Affiliate Program — Shopper Side
// ============================================================
// Envelopes (ApiOk<T>, ApiPage<T>, ApiPageMeta, ApiErr) are defined in the
// assembled contract file and are referenced here — intentionally NOT redeclared.

// ------------------------------------------------------------
// §7 Shopper Account Hub
// ------------------------------------------------------------

/** POST /api/me/activity · DELETE /api/me/activity — like/view tracking body */
export interface ActivityBody {
  productId: string;
  activityType: "LIKE" | "VIEWED";
}

/** POST /api/me/activity — track-like-or-view */
export interface TrackActivityData {
  tracked: "LIKE" | "VIEWED";
  productId: string;
}
export type TrackActivityResponse = ApiOk<TrackActivityData>;

/** DELETE /api/me/activity — untrack-activity */
export interface RemoveActivityData {
  removed: "LIKE" | "VIEWED";
  productId: string;
}
export type RemoveActivityResponse = ApiOk<RemoveActivityData>;

/** GET /api/me/activity — likes/recently-viewed list query */
export interface ActivityListQuery {
  type?: "LIKE" | "VIEWED";
  productId?: string;
  page?: number;
  size?: number;
}

/** GET /api/me/activity — product card for My Likes / Recently Viewed */
export interface MeActivityProductCard {
  id: string;
  slug: string;
  title: string;
  priceMinor: number;
  compareAtPriceMinor: number | null;
  variantId: string | null;
  imageUrl: string;
  storeName: string;
  storeSlug: string;
  ratingAvg: number;
  ratingCount: number;
  salesCount: number;
  viewCount: number;
  categoryName: string | null;
}

/** GET /api/me/activity — one tracked activity row with its product card */
export interface MeTrackedActivity {
  activityId: string;
  trackedAt: string;
  product: MeActivityProductCard;
}

/** GET /api/me/activity — paged activity feed payload */
export interface ActivityListData {
  activities: MeTrackedActivity[];
}
export type ActivityListResponse = ApiPage<ActivityListData>;

/** GET /api/me/activity — liked-check mode (when ?productId is present) */
export interface ActivityLikedData {
  liked: boolean;
}
export type ActivityLikedResponse = ApiOk<ActivityLikedData>;

/** GET /api/me/follows — followed-store row */
export interface MeFollowedStore {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  tagline: string | null;
  status: string;
  isLive: boolean;
  productCount: number;
  followers: number;
  followedAt: string;
}

/** GET /api/me/follows — my-followed-stores payload */
export interface FollowsData {
  stores: MeFollowedStore[];
  total: number;
}
export type FollowsResponse = ApiOk<FollowsData>;

/** POST /api/me/follows — follow-store body */
export interface FollowBody {
  storeId: string;
}

/** POST /api/me/follows — follow-store result */
export interface FollowData {
  following: true;
  followers: number;
  already?: true;
}
export type FollowResponse = ApiOk<FollowData>;

/** DELETE /api/me/follows — unfollow-store query (falls back to body) */
export interface UnfollowQuery {
  storeId?: string;
}

/** DELETE /api/me/follows — unfollow-store body */
export interface UnfollowBody {
  storeId?: string;
}

/** DELETE /api/me/follows — unfollow-store result */
export interface UnfollowData {
  following: false;
  followers: number;
}
export type UnfollowResponse = ApiOk<UnfollowData>;

/** GET /api/me/orders · GET /api/me/reviews — minimal store reference */
export interface MeStoreRef {
  id: string;
  name: string;
  slug: string;
}

/** GET /api/me/orders — line item on a purchase-hub order summary */
export interface MeOrderSummaryItem {
  id: string;
  title: string;
  variantLabel: string | null;
  qty: number;
  unitPriceMinor: number;
  productId: string | null;
  imageUrl: string;
}

/** GET /api/me/orders — purchase-hub order summary */
export interface MeOrderSummary {
  id: string;
  orderNumber: string;
  status: string;
  totalMinor: number;
  createdAt: string;
  receivedAt: string | null;
  paymentProvider: string | null;
  trackingNumber: string | null;
  shipmentStatus: string | null;
  shippingCourierName: string | null;
  store: MeStoreRef;
  items: MeOrderSummaryItem[];
}

/** GET /api/me/orders — my-purchases query */
export interface OrdersQuery {
  bucket?: "to_pay" | "to_ship" | "to_receive" | "to_rate" | "completed" | "cancelled";
  page?: number;
  size?: number;
}

/** GET /api/me/orders — my-purchases payload */
export interface OrdersData {
  bucketCounts: Record<"to_pay" | "to_ship" | "to_receive" | "to_rate" | "completed" | "cancelled", number>;
  orders: MeOrderSummary[];
}
export type OrdersResponse = ApiPage<OrdersData>;

/** GET /api/me/orders/[orderNumber] — order-detail line item */
export interface MeOrderDetailItem {
  id: string;
  title: string;
  variantLabel: string | null;
  qty: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  productId: string | null;
  variantId: string | null;
  imageUrl: string;
}

/** GET /api/me/orders/[orderNumber] — order status history entry */
export interface MeOrderHistoryEntry {
  fromStatus: string | null;
  toStatus: string;
  actor: string;
  note: string | null;
  createdAt: string;
}

/** GET /api/me/orders/[orderNumber] — shipment tracking event */
export interface MeShipmentEvent {
  id: string;
  status: string;
  description: string | null;
  location: string | null;
  occurredAt: string;
  proofImageUrl: string | null;
}

/** GET /api/me/orders/[orderNumber] — shipment timeline block */
export interface MeShipmentDetail {
  status: string;
  providerId: string;
  courierName: string | null;
  awbNumber: string | null;
  labelUrl: string | null;
  etaFrom: string | null;
  etaTo: string | null;
  bookedAt: string | null;
  deliveredAt: string | null;
  events: MeShipmentEvent[];
}

/** GET /api/me/orders/[orderNumber] — after-sales dispute block */
export interface MeOrderDispute {
  id: string;
  reason: string;
  status: string;
  resolution: string | null;
  createdAt: string;
}

/** GET /api/me/orders/[orderNumber] — order-detail payload */
export interface OrderDetailData {
  orderNumber: string;
  status: string;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  createdAt: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  customerNote: string | null;
  shippingAddress: { line1?: string; city?: string; state?: string; postcode?: string } | null;
  paymentProvider: string | null;
  paidAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  receivedAt: string | null;
  completedAt: string | null;
  trackingNumber: string | null;
  storeName: string;
  storeId: string;
  storeSlug: string;
  items: MeOrderDetailItem[];
  history: MeOrderHistoryEntry[];
  shipment: MeShipmentDetail | null;
  shipmentStatus: string | null;
  shippingCourierName: string | null;
  dispute: MeOrderDispute | null;
}
export type OrderDetailResponse = ApiOk<OrderDetailData>;

/** POST /api/me/orders/[orderNumber]/receive — confirm-receipt result */
export interface ReceiveOrderData {
  id: string;
  orderNumber: string;
  status: string;
  receivedAt: string | null;
  completedAt: string | null;
  alreadyConfirmed?: true;
}
export type ReceiveOrderResponse = ApiOk<ReceiveOrderData>;

/** POST /api/me/orders/[orderNumber]/reorder — reorder-to-cart result */
export interface ReorderData {
  added: { title: string; qty: number }[];
  skipped: { title: string; reason: "Out of stock" | "Already at the maximum in your cart" | "No longer available" }[];
}
export type ReorderResponse = ApiOk<ReorderData>;

/** POST /api/me/orders/[orderNumber]/return-request — open-after-sales body */
export interface ReturnRequestBody {
  reason: string;
  type?: "refund" | "return";
}

/** POST /api/me/orders/[orderNumber]/return-request — created after-sales request */
export interface ReturnRequestData {
  id: string;
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  type: "refund" | "return";
  reason: string;
  status: string;
  createdAt: string;
}
export type ReturnRequestResponse = ApiOk<ReturnRequestData>;

/** GET /api/me/orders/[orderNumber]/return-request — after-sales dispute row */
export interface MeAfterSalesDispute {
  id: string;
  reason: string;
  status: string;
  resolution: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** GET /api/me/orders/[orderNumber]/return-request — after-sales visibility payload */
export interface ReturnRequestsData {
  orderNumber: string;
  orderStatus: string;
  disputes: MeAfterSalesDispute[];
}
export type ReturnRequestsResponse = ApiOk<ReturnRequestsData>;

/** POST /api/me/coins/claim — daily-coin-checkin result */
export interface CoinClaimData {
  awarded: number;
  coinBalance: number;
  checkInStreak: number;
  nextClaimAt: string;
}
export type CoinClaimResponse = ApiOk<CoinClaimData>;

/** GET /api/me/notifications — notification feed row */
export interface MeNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  data: Record<string, unknown>;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

/** GET /api/me/notifications — notification-feed query */
export interface NotificationsQuery {
  unread?: "1" | "true";
  page?: number;
  size?: number;
}

/** GET /api/me/notifications — paged feed element type */
export type NotificationsData = MeNotification[];
export type NotificationsResponse = ApiPage<NotificationsData>;

/** POST /api/me/notifications — mark-notifications-read body */
export interface MarkReadBody {
  ids?: string[];
  all?: boolean;
}

/** POST /api/me/notifications — mark-notifications-read result */
export interface MarkReadData {
  updated: number;
  unread: number;
}
export type MarkReadResponse = ApiOk<MarkReadData>;

/** GET /api/me/notifications/unread — unread-badge-count */
export interface UnreadCountData {
  unread: number;
}
export type UnreadCountResponse = ApiOk<UnreadCountData>;

/** POST /api/me/password — change-password body */
export interface PasswordChangeBody {
  currentPassword: string;
  newPassword: string;
}

/** POST /api/me/password — session-rotation result (admin variant) */
export interface PasswordChangeAdminData {
  userType: "admin";
  admin: { id: string; email: string; name: string; role: string };
  token: string;
}

/** POST /api/me/password — session-rotation result (seller variant) */
export interface PasswordChangeSellerData {
  userType: "seller";
  seller: { id: string; email: string; fullName: string; displayName: string; status: string };
  token: string;
}

/** POST /api/me/password — session-rotation result (shopper variant) */
export interface PasswordChangeShopperData {
  userType: "shopper";
  shopper: { id: string; email: string; fullName: string; phone: string | null };
  token: string;
}

/** POST /api/me/password — discriminated union of rotated-session results */
export type PasswordChangeData = PasswordChangeAdminData | PasswordChangeSellerData | PasswordChangeShopperData;
export type PasswordChangeResponse = ApiOk<PasswordChangeData>;

/** GET /api/me/profile — profile-card payload */
export interface ProfileData {
  id: string;
  email: string;
  emailVerified: boolean;
  fullName: string;
  username: string | null;
  avatarUrl: string | null;
  phone: string | null;
  membershipLevel: "SILVER" | "GOLD" | "PLATINUM";
  followingCount: number;
  followerCount: number;
  memberSince: string;
  addressCount: number;
  lifetimeSpendMinor: number;
  tierProgress: { nextTier: "GOLD" | "PLATINUM"; nextThresholdMinor: number; remainingMinor: number; percent: number } | null;
}
export type ProfileResponse = ApiOk<ProfileData>;

/** PATCH /api/me/profile — edit-profile body */
export interface ProfilePatchBody {
  fullName?: string;
  phone?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
}

/** PATCH /api/me/profile — edit-profile result */
export interface ProfilePatchData {
  profile: { id: string; fullName: string; username: string | null; avatarUrl: string | null; phone: string | null };
}
export type ProfilePatchResponse = ApiOk<ProfilePatchData>;

/** GET /api/me/recommendations — personalised-feed product card */
export interface MeRecommendationProduct {
  id: string;
  slug: string;
  title: string;
  priceMinor: number;
  compareAtPriceMinor: number | null;
  variantId: string | null;
  imageUrl: string;
  storeName: string;
  storeSlug: string;
  ratingAvg: number;
  ratingCount: number;
  salesCount: number;
  viewCount: number;
  categoryName: string | null;
  inStock: boolean;
  isFeatured: boolean;
  isSellingFast: boolean;
  payLaterEligible: boolean;
}

/** GET /api/me/recommendations — you-may-also-like query */
export interface RecommendationsQuery {
  sort?: "popular" | "sales" | "new";
  page?: number;
  size?: number;
}

/** GET /api/me/recommendations — personalised-feed payload */
export interface RecommendationsData {
  products: MeRecommendationProduct[];
}
export type RecommendationsResponse = ApiPage<RecommendationsData>;

/** GET /api/me/reviews — purchase eligible for review */
export interface MeReviewCandidate {
  orderNumber: string;
  orderStatus: string;
  purchasedAt: string;
  store: MeStoreRef;
  product: { id: string; title: string; slug: string; imageUrl: string };
}

/** GET /api/me/reviews — my submitted review row */
export interface MeSubmittedReview {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  titleRemoved: boolean;
  bodyRemoved: boolean;
  status: "pending" | "published" | "rejected";
  createdAt: string;
  product: { id: string; title: string; slug: string; imageUrl: string; store: { name: string; slug: string } };
  reward: { points: number; reversed: boolean; reversalReason: string | null } | null;
  editable: boolean;
  editCount: number;
}

/** GET /api/me/reviews — review-rewards ledger entry */
export interface MeReviewRewardEntry {
  id: string;
  kind: string;
  points: number;
  note: string | null;
  createdAt: string;
  reversedAt: string | null;
  reversalReason: string | null;
}

/** GET /api/me/reviews — review rewards summary */
export interface MeReviewRewardsSummary {
  activePoints: number;
  activeCount: number;
  reversedCount: number;
  reversedPoints: number;
  minorEquivalent: number;
  recent: MeReviewRewardEntry[];
}

/** GET /api/me/reviews — review reward policy */
export interface MeReviewPolicy {
  pointsPerReview: number;
  minorPerPoint: number;
  maxEdits: number;
}

/** GET /api/me/reviews — review-management payload */
export interface MyReviewsData {
  toReview: MeReviewCandidate[];
  submitted: MeSubmittedReview[];
  rewards: MeReviewRewardsSummary;
  policy: MeReviewPolicy;
}
export type MyReviewsResponse = ApiOk<MyReviewsData>;

/** PATCH /api/me/reviews/[id] — edit-my-review body */
export interface ReviewEditBody {
  rating?: number;
  title?: string | null;
  body?: string | null;
  customerName?: string;
}

/** PATCH /api/me/reviews/[id] — edit-my-review result */
export interface ReviewEditData {
  id: string;
  status: "pending";
  editsRemaining: number;
}
export type ReviewEditResponse = ApiOk<ReviewEditData>;

/** GET /api/me/vouchers — voucher snapshot inside a held voucher */
export interface MeVoucherSnapshot {
  code: string;
  title: string;
  kind: string;
  discountMinor: number;
  percentOff: number | null;
  maxDiscountMinor: number | null;
  minSpendMinor: number;
  expiryAt: string;
}

/** GET /api/me/vouchers — store reference on detailed vouchers */
export interface MeVoucherStoreRef {
  name: string;
  slug: string;
  logoUrl: string | null;
}

/** GET /api/me/vouchers — full voucher definition inside "mine" */
export interface MeVoucherDetail {
  id: string;
  code: string;
  title: string;
  kind: string;
  discountMinor: number;
  percentOff: number | null;
  maxDiscountMinor: number | null;
  minSpendMinor: number;
  expiryAt: string;
  scope: string;
  storeId: string | null;
  regionLimit: string | null;
  store: MeVoucherStoreRef | null;
}

/** GET /api/me/vouchers — held voucher (legacy flat wallet row) */
export interface MeHeldVoucher {
  id: string;
  status: string;
  claimedAt: string;
  usedAt: string | null;
  voucher: MeVoucherSnapshot;
}

/** GET /api/me/vouchers — wallet voucher row ("mine") */
export interface MeWalletVoucher {
  id: string;
  status: string;
  claimedByMe: boolean;
  claimedAt: string;
  usedAt: string | null;
  usedOrderId: string | null;
  voucher: MeVoucherDetail;
}

/** GET /api/me/vouchers — claim-center pool voucher row */
export interface MeClaimableVoucher {
  id: string;
  code: string;
  title: string;
  kind: string;
  discountMinor: number;
  percentOff: number | null;
  maxDiscountMinor: number | null;
  minSpendMinor: number;
  expiryAt: string;
  startsAt: string | null;
  scope: string;
  regionLimit: string | null;
  store: MeVoucherStoreRef | null;
  claimedByMe: boolean;
  quotaRemaining: number | null;
  claimable: boolean;
}

/** GET /api/me/vouchers — voucher-wallet-and-claim-center payload */
export interface VouchersData {
  vouchers: MeHeldVoucher[];
  mine: MeWalletVoucher[];
  center: MeClaimableVoucher[];
}
export type VouchersResponse = ApiOk<VouchersData>;

/** POST /api/me/vouchers — claim-by-code-legacy body */
export interface ClaimByCodeBody {
  code: string;
}

/** POST /api/me/vouchers — claim-by-code-legacy result */
export interface ClaimByCodeData {
  voucher: { code: string; title: string; kind: string; scope: string };
  status: string;
}
export type ClaimByCodeResponse = ApiOk<ClaimByCodeData>;

/** POST /api/me/vouchers/claim — claim-voucher body */
export interface ClaimVoucherBody {
  code?: string;
  voucherId?: string;
}

/** POST /api/me/vouchers/claim — claim-voucher result */
export interface ClaimVoucherData {
  voucher: { id: string; code: string; title: string; kind: string; scope: string; expiryAt: string };
  userVoucherId: string;
  status: string;
}
export type ClaimVoucherResponse = ApiOk<ClaimVoucherData>;

/** GET /api/me/wallet — voucher availability counts */
export interface MeVoucherCounts {
  available: number;
  used: number;
}

/** GET /api/me/wallet — NomoPay/coins/PayLater balances */
export interface MeWalletBalances {
  balanceMinor: number;
  coinBalance: number;
  payLaterLimitMinor: number;
  payLaterUsedMinor: number;
  payLaterAvailableMinor: number;
  checkInStreak: number;
}

/** GET /api/me/wallet — daily check-in state */
export interface MeCheckInState {
  canClaim: boolean;
  lastCheckInAt: string | null;
  nextClaimAt: string | null;
}

/** GET /api/me/wallet — financial-overview payload (finance dormant variant) */
export interface WalletDisabledData {
  disabled: true;
  message: string;
  wallet: null;
  checkIn: null;
  vouchers: MeVoucherCounts;
}

/** GET /api/me/wallet — financial-overview payload (active variant) */
export interface WalletActiveData {
  wallet: MeWalletBalances;
  vouchers: MeVoucherCounts;
  checkIn: MeCheckInState;
}

/** GET /api/me/wallet — financial-overview union */
export type WalletData = WalletDisabledData | WalletActiveData;
export type WalletResponse = ApiOk<WalletData>;

// ------------------------------------------------------------
// §8 Shopper ⇄ Seller Messaging (Chat)
// ------------------------------------------------------------

/** GET /api/chat/unread · GET /api/store/chat/unread — unread badge count (shopper + seller) */
export interface ChatUnreadData {
  total: number;
}
export type ChatUnreadResponse = ApiOk<ChatUnreadData>;

/** POST /api/chat/hub-auth — hub socket authorization body */
export interface HubAuthBody {
  token: string;
  rooms: string[];
}

/** POST /api/chat/hub-auth — hub socket authorization result */
export interface HubAuthData {
  ok: true;
  user: { userType: string; userId: string };
  allowed: string[];
  denied: number;
}
export type HubAuthResponse = ApiOk<HubAuthData>;

/** GET /api/chat/threads · GET /api/store/chat/threads — conversation list query */
export interface ChatThreadsQuery {
  q?: string;
  filter?: "all" | "active";
  page?: number;
  size?: number;
}

/** GET /api/chat/threads · GET /api/store/chat/threads — last message preview */
export interface ChatLastMessage {
  body: string;
  senderType: string;
  createdAt: string;
  readAt: string | null;
}

/** GET /api/chat/threads — shopper conversation summary */
export interface ChatThreadSummary {
  id: string;
  storeId: string;
  displayName: string;
  avatarUrl: string | null;
  storeSlug: string;
  orderNumber: string | null;
  contextType: string | null;
  subject: string | null;
  createdAt: string;
  lastMessageAt: string;
  unreadCount: number;
  lastMessage: ChatLastMessage | null;
}

/** GET /api/chat/threads — paged conversation list element type */
export type ChatThreadsData = ChatThreadSummary[];
export type ChatThreadsResponse = ApiPage<ChatThreadsData>;

/** GET /api/chat/threads/[id] · GET /api/store/chat/threads/[id]/messages — keyset page query */
export interface ThreadDetailQuery {
  limit?: number;
  before?: string;
}

/** POST /api/chat/threads — get-or-create-thread body */
export interface CreateThreadBody {
  storeId?: string;
  storeSlug?: string;
  orderNumber?: string;
  productId?: string;
  message?: string;
  subject?: string;
}

/** POST /api/chat/threads · GET /api/chat/threads/[id] — chat message row */
export interface ChatMessage {
  id: string;
  threadId: string;
  senderType: string;
  senderName: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

/** POST /api/chat/threads — get-or-create-thread result */
export interface CreateThreadData {
  thread: { id: string; storeId: string; storeName: string; storeSlug: string; orderNumber: string | null; contextType: string | null; subject: string | null; lastMessageAt: string };
  message: ChatMessage | null;
}
export type CreateThreadResponse = ApiOk<CreateThreadData>;

/** GET /api/chat/threads/[id] · GET /api/store/chat/threads/[id]/messages — quoted product/order context card */
export type ThreadContextCard =
  | { kind: "product"; productId: string; title: string; slug: string; storeSlug: string; image: string | null; priceMinor: number; compareAtPriceMinor: number | null }
  | { kind: "order"; orderId: string; orderNumber: string; status: string; totalMinor: number; placedAt: string; itemCount: number; firstItemTitle: string | null; firstItemImage: string | null };

/** GET /api/chat/threads/[id] — conversation page payload */
export interface ThreadDetailData {
  thread: { id: string; storeId: string; storeName: string; storeSlug: string; shopperName: string; orderNumber: string | null; contextType: string | null; subject: string | null; createdAt: string; lastMessageAt: string };
  context: ThreadContextCard | null;
  hasMore: boolean;
  messages: ChatMessage[];
}
export type ThreadDetailResponse = ApiOk<ThreadDetailData>;

/** PATCH /api/chat/threads/[id] · PATCH /api/store/chat/threads/[id]/messages — clear context card body */
export interface ClearContextBody {
  action: "clearContext";
}

/** PATCH /api/chat/threads/[id] · PATCH /api/store/chat/threads/[id]/messages — clear context card result */
export interface ClearContextData {
  threadId: string;
  contextType: null;
}
export type ClearContextResponse = ApiOk<ClearContextData>;

/** POST /api/chat/threads/[id]/read — mark thread read result (shopper) */
export interface ChatMarkReadData {
  read: true;
  marked: { count: number };
}
export type ChatMarkReadResponse = ApiOk<ChatMarkReadData>;

/** POST /api/chat/threads/[id]/messages — send shopper message body */
export interface SendMessageBody {
  body: string;
}

/** POST /api/chat/threads/[id]/messages — sent shopper message */
export interface SendMessageData {
  id: string;
  threadId: string;
  senderType: "shopper";
  senderName: string;
  body: string;
  createdAt: string;
  readAt: null;
}
export type SendMessageResponse = ApiOk<SendMessageData>;

/** GET /api/store/chat/threads — seller inbox thread summary */
export interface StoreChatThreadSummary {
  id: string;
  shopperId: string;
  displayName: string;
  avatarUrl: null;
  shopperEmail: string;
  orderNumber: string | null;
  contextType: string | null;
  subject: string | null;
  createdAt: string;
  lastMessageAt: string;
  unreadCount: number;
  lastMessage: ChatLastMessage | null;
}

/** GET /api/store/chat/threads — paged seller inbox element type */
export type StoreChatThreadsData = StoreChatThreadSummary[];
export type StoreChatThreadsResponse = ApiPage<StoreChatThreadsData>;

/** POST /api/store/chat/threads/[id]/read — mark thread read result (seller) */
export interface ThreadReadData {
  read: boolean;
  marked: { count: number };
}
export type ThreadReadResponse = ApiOk<ThreadReadData>;

/** GET /api/store/chat/threads/[id]/messages — seller-side message row */
export interface StoreChatMessage {
  id: string;
  senderType: string;
  senderName: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

/** GET /api/store/chat/threads/[id]/messages — thread messages page payload (seller) */
export interface ThreadMessagesData {
  thread: { id: string; shopperName: string; shopperEmail: string; orderNumber: string | null; contextType: string | null; subject: string | null; lastMessageAt: string };
  context: ThreadContextCard | null;
  hasMore: boolean;
  messages: StoreChatMessage[];
}
export type ThreadMessagesResponse = ApiOk<ThreadMessagesData>;

/** POST /api/store/chat/threads/[id]/messages — seller reply body */
export interface SellerReplyBody {
  body: string;
}

/** POST /api/store/chat/threads/[id]/messages — sent seller reply */
export interface SellerReplyData {
  id: string;
  threadId: string;
  senderType: "seller";
  senderName: string;
  body: string;
  createdAt: string;
  readAt: null;
}
export type SellerReplyResponse = ApiOk<SellerReplyData>;

// ------------------------------------------------------------
// §9 Affiliate Program — Shopper Side
// ------------------------------------------------------------

/** POST /api/affiliate/track — resolve promo link body */
export interface TrackBody {
  code: string;
}

/** POST /api/affiliate/track — resolved promo-link navigation target */
export type AffiliateTrackTarget =
  | { kind: "product"; storeSlug: string; productSlug: string }
  | { kind: "store"; storeSlug: string }
  | { kind: "collection"; collectionSlug: string }
  | { kind: "showcase"; affiliateSlug: string };

/** POST /api/affiliate/track — resolve promo link result */
export interface TrackData {
  target: AffiliateTrackTarget;
  sharedBy: string;
  linkType: string;
  channel: string;
}
export type TrackResponse = ApiOk<TrackData>;

/** POST /api/affiliate/track-referral — record referral visit body */
export interface TrackReferralBody {
  code: string;
  channel?: string;
}

/** POST /api/affiliate/track-referral — record referral visit result */
export interface TrackReferralData {
  invitedBy: string | null;
}
export type TrackReferralResponse = ApiOk<TrackReferralData>;

/** GET /api/affiliate/pub/collection/[slug] · GET /api/affiliate/pub/showcase/[slug] — public product card */
export interface AffiliatePubProduct {
  productId: string;
  title: string;
  slug: string;
  priceMinor: number;
  storeName: string;
  storeSlug: string;
  image: string | null;
}

/** GET /api/affiliate/pub/collection/[slug] · GET /api/affiliate/pub/showcase/[slug] — fail-closed variant */
export interface AffiliatePubNotFoundData {
  found: false;
}

/** GET /api/affiliate/pub/collection/[slug] — published collection payload */
export interface PubCollectionFoundData {
  found: true;
  collection: {
    title: string;
    description: string | null;
    curatedBy: string;
    curatorSlug: string;
    curatorAvatar: string | null;
    pageType: "affiliate_collection";
    products: AffiliatePubProduct[];
  };
}

/** GET /api/affiliate/pub/collection/[slug] — public collection page union */
export type PubCollectionData = AffiliatePubNotFoundData | PubCollectionFoundData;
export type PubCollectionResponse = ApiOk<PubCollectionData>;

/** GET /api/affiliate/pub/showcase/[slug] — published showcase payload */
export interface PubShowcaseFoundData {
  found: true;
  showcase: {
    displayName: string;
    bio: string | null;
    avatarUrl: string | null;
    slug: string;
    pageType: "affiliate_recommendations";
    collections: { id: string; title: string; description: string | null; slug: string; products: AffiliatePubProduct[] }[];
  };
}

/** GET /api/affiliate/pub/showcase/[slug] — public showcase union */
export type PubShowcaseData = AffiliatePubNotFoundData | PubShowcaseFoundData;
export type PubShowcaseResponse = ApiOk<PubShowcaseData>;

/** GET /api/affiliate/links — promo-link resolved target */
export type AffiliateLinkTarget =
  | { kind: "product"; title: string; slug: string | null; storeSlug: string | null; storeName: string | null; image: string | null }
  | { kind: "store"; title: string; slug: string | null }
  | { kind: "collection"; title: string; slug: string | null; status: string | null }
  | { kind: "showcase"; title: string; slug: string };

/** GET /api/affiliate/links — my promo link row */
export interface AffiliateLinkSummary {
  id: string;
  code: string;
  type: string;
  channel: string;
  label: string | null;
  status: string;
  clicks: number;
  lastClickAt: string | null;
  createdAt: string;
  target: AffiliateLinkTarget;
}

/** GET /api/affiliate/links — list-my-promo-links payload */
export interface LinksData {
  links: AffiliateLinkSummary[];
}
export type LinksResponse = ApiOk<LinksData>;

/** POST /api/affiliate/links — create promo link body */
export interface CreateLinkBody {
  type: "product" | "store" | "collection" | "showcase";
  channel?: string;
  label?: string;
  productId?: string;
  storeId?: string;
  collectionId?: string;
}

/** POST /api/affiliate/links — created promo link */
export interface CreateLinkData {
  link: { id: string; code: string; type: string; channel: string; label: string | null };
}
export type CreateLinkResponse = ApiOk<CreateLinkData>;

/** PATCH /api/affiliate/links/[id] — update promo link body */
export interface UpdateLinkBody {
  status?: "active" | "archived";
  channel?: string;
  label?: string;
}

/** PATCH /api/affiliate/links/[id] — updated promo link */
export interface UpdateLinkData {
  link: { id: string; status: string; channel: string; label: string | null };
}
export type UpdateLinkResponse = ApiOk<UpdateLinkData>;

/** GET /api/affiliate/collections — collection item with eligibility + rate */
export interface AffiliateCollectionItem {
  productId: string;
  position: number;
  title: string;
  slug: string;
  priceMinor: number;
  image: string | null;
  storeName: string;
  storeSlug: string;
  eligible: boolean;
  rateBps: number;
}

/** GET /api/affiliate/collections — my curated collection row */
export interface AffiliateCollectionSummary {
  id: string;
  title: string;
  description: string | null;
  slug: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  items: AffiliateCollectionItem[];
}

/** GET /api/affiliate/collections — list-my-collections payload */
export interface CollectionsData {
  collections: AffiliateCollectionSummary[];
}
export type CollectionsResponse = ApiOk<CollectionsData>;

/** POST /api/affiliate/collections — create draft collection body */
export interface CreateCollectionBody {
  title: string;
  description?: string;
}

/** POST /api/affiliate/collections — created draft collection */
export interface CreateCollectionData {
  collection: { id: string; slug: string; title: string; status: string };
}
export type CreateCollectionResponse = ApiOk<CreateCollectionData>;

/** PATCH /api/affiliate/collections/[id] — edit/publish collection body */
export interface UpdateCollectionBody {
  title?: string;
  description?: string;
  status?: "draft" | "published" | "archived";
  addProductIds?: string[];
  removeProductIds?: string[];
  order?: string[];
}

/** PATCH /api/affiliate/collections/[id] — edited collection */
export interface UpdateCollectionData {
  collection: { id: string; title: string; slug: string; status: string; version: number };
}
export type UpdateCollectionResponse = ApiOk<UpdateCollectionData>;

/** DELETE /api/affiliate/collections/[id] — archive collection result */
export interface ArchiveCollectionData {
  archived: true;
}
export type ArchiveCollectionResponse = ApiOk<ArchiveCollectionData>;

/** GET /api/affiliate/me · GET /api/affiliate/overview context — programme settings */
export interface AffiliateSettings {
  enabled: boolean;
  sponsorEnabled: boolean;
  maxRateBps: number;
  attrWindowDays: number;
  sponsorWindowDays: number;
  reviewDays: number;
  minPayoutMinor: number;
  collectionsEnabled: boolean;
  showcaseEnabled: boolean;
}

/** GET /api/affiliate/me · GET /api/affiliate/earnings · GET /api/affiliate/payouts — live balances */
export interface AffiliateBalances {
  pendingMinor: number;
  approvedMinor: number;
  availableMinor: number;
  payoutInFlightMinor: number;
  paidMinor: number;
  reversedMinor: number;
  heldMinor: number;
  recoveryMinor: number;
  requestableMinor: number;
}

/** GET /api/affiliate/me — shopper's affiliate profile (absent before activation) */
export interface AffiliateProfile {
  id: string;
  code: string;
  slug: string;
  status: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  payoutRef: string | null;
  payoutVerified: boolean;
  sponsorId: string | null;
  sponsorName: string | null;
  sponsorSlug: string | null;
  termsVersion: number;
  termsAcceptedAt: string;
  activatedAt: string;
}

/** GET /api/affiliate/me — my affiliate context payload */
export interface MeProfileData {
  activated: boolean;
  settings: AffiliateSettings;
  invitedBy?: string | null;
  profile?: AffiliateProfile;
  balances?: AffiliateBalances;
}
export type MeProfileResponse = ApiOk<MeProfileData>;

/** GET /api/affiliate/discover — discover-enrolled-products query */
export interface DiscoverQuery {
  category?: string;
  q?: string;
  store?: string;
  minRate?: number;
  maxPrice?: number;
  sort?: "rate" | "price_asc" | "price_desc" | "sales" | "newest" | "featured";
  page?: number;
  size?: number;
}

/** GET /api/affiliate/discover — participating product with commission estimate */
export interface DiscoverProduct {
  productId: string;
  title: string;
  slug: string;
  storeSlug: string;
  storeName: string;
  image: string | null;
  priceMinor: number;
  rateBps: number;
  estimatedCommissionMinor: number;
  salesCount: number;
  viewCount: number;
  ratingAvg: number;
  isFeatured: boolean;
  addedAt: string | null;
}

/** GET /api/affiliate/discover — active programme variant */
export interface DiscoverActiveData {
  rows: DiscoverProduct[];
  total: number;
  maxRateBps: number;
}

/** GET /api/affiliate/discover — paused programme variant */
export interface DiscoverPausedData {
  rows: never[];
  total: 0;
  paused: true;
}

/** GET /api/affiliate/discover — discover union (deviation: single envelope, no meta) */
export type DiscoverData = DiscoverActiveData | DiscoverPausedData;
export type DiscoverResponse = ApiOk<DiscoverData>;

/** GET /api/affiliate/earnings — commission entries query */
export interface EarningsQuery {
  role?: "direct" | "sponsor";
  status?: string;
  page?: number;
  size?: number;
}

/** GET /api/affiliate/earnings — commission entry row */
export interface AffiliateEarningRow {
  id: string;
  role: string;
  status: string;
  amountMinor: number;
  reversedMinor: number;
  holdReason: string | null;
  availableAt: string | null;
  paidAt: string | null;
  payoutId: string | null;
  createdAt: string;
  orderNumber: string;
  rateBps: number;
  baseMinor: number;
  poolMinor: number;
  channel: string;
  linkType: string;
}

/** GET /api/affiliate/earnings — commission entries payload (deviation: inline page/total, no meta) */
export interface EarningsData {
  total: number;
  page: number;
  balances: AffiliateBalances;
  rows: AffiliateEarningRow[];
}
export type EarningsResponse = ApiOk<EarningsData>;

/** GET /api/affiliate/activate — pre-activation context */
export interface ActivateContextData {
  enabled: boolean;
  sponsorEnabled: boolean;
  maxRateBps: number;
  invitedBy: string | null;
  invitedByCode: string | null;
}
export type ActivateContextResponse = ApiOk<ActivateContextData>;

/** POST /api/affiliate/activate — join programme body */
export interface ActivateBody {
  termsAccepted: boolean;
  displayName?: string;
  bio?: string;
  slug?: string;
  sponsorCode?: string;
  sponsorConfirmed?: boolean;
}

/** POST /api/affiliate/activate — join programme result */
export interface ActivateData {
  profile: { id: string; code: string; slug: string; displayName: string; status: string; sponsorId: string | null };
  sponsor: { id: string; displayName: string } | null;
  sponsorSource: "referral_touch" | "code_entry" | null;
}
export type ActivateResponse = ApiOk<ActivateData>;

/** GET /api/affiliate/overview — hub overview query */
export interface OverviewQuery {
  days?: number;
}

/** GET /api/affiliate/overview — hub overview payload (estimated analytics vs authoritative finance kept separate) */
export interface OverviewData {
  estimated: { clicks: number; uniqueVisitors: number; productViews: number; addToCart: number };
  commerce: { attributedOrders: number; paidOrders: number; eligibleSalesMinor: number; reversedMinor: number };
  earnings: { personalDirectMinor: number; sponsorMinor: number; pendingMinor: number; approvedMinor: number; availableMinor: number; paidMinor: number; reversedMinor: number; heldMinor: number; recoveryMinor: number; requestableMinor: number; payoutInFlightMinor: number };
  network: { directReferrals: number; activatedAffiliates: number; affiliatesWithSales: number };
  series: { date: string; clicks: number; orders: number; commissionMinor: number }[];
  days: number;
}
export type OverviewResponse = ApiOk<OverviewData>;

/** GET /api/affiliate/payouts — payout history row */
export interface AffiliatePayoutRow {
  id: string;
  amountMinor: number;
  status: string;
  method: string;
  reference: string | null;
  note: string | null;
  failReason: string | null;
  requestedAt: string;
  processedAt: string | null;
}

/** GET /api/affiliate/payouts — payout history payload */
export interface PayoutsData {
  balances: AffiliateBalances;
  minPayoutMinor: number;
  payouts: AffiliatePayoutRow[];
}
export type PayoutsResponse = ApiOk<PayoutsData>;

/** POST /api/affiliate/payouts — request withdrawal result (body ignored) */
export interface PayoutRequestData {
  payoutId: string;
  amountMinor: number;
}
export type PayoutRequestResponse = ApiOk<PayoutRequestData>;

/** GET /api/affiliate/network — direct referrals query */
export interface NetworkQuery {
  page?: number;
  size?: number;
}

/** GET /api/affiliate/network — direct referral row */
export interface AffiliateReferral {
  displayName: string;
  slug: string;
  status: string;
  activatedAt: string;
  generatedSales: boolean;
}

/** GET /api/affiliate/network — direct referrals payload (deviation: inline page/total, no meta) */
export interface NetworkData {
  total: number;
  page: number;
  referrals: AffiliateReferral[];
  sponsorEarningsMinor: number;
}
export type NetworkResponse = ApiOk<NetworkData>;
// ============================================================
// §10 Seller Backend — Catalog, Content & Imports
// §11 Seller Backend — Orders & Fulfillment
// §12 Seller Backend — Insights & Analytics
// ============================================================
// Envelope types referenced below are defined once in the assembled file:
//   ApiOk<T>    = { data: T }
//   ApiPageMeta = { page: number; size: number; total: number }
//   ApiPage<T>  = { data: T; meta: ApiPageMeta }
//   ApiErr      = { error: { code: string; message: string; details?: unknown; meta?: { refId?: string } } }

// ============================================================
// §10 Seller Backend — Catalog, Content & Imports
// ============================================================

/** GET /api/store/products — list query (search, status group, pagination) */
export interface SellerProductsQuery {
  search?: string;
  status?: string;
  page?: number;
  size?: number;
}

/** GET /api/store/products — product image row */
export interface SellerProductImage {
  id: string;
  productId: string;
  url: string;
  sortOrder: number;
  alt: string | null;
}

/** GET /api/store/products — product variant row */
export interface SellerProductVariant {
  id: string;
  productId: string;
  name: string;
  optionName: string | null;
  optionValue: string | null;
  priceMinor: number;
  compareAtPriceMinor: number | null;
  stock: number;
  moq: number;
  lowStockThreshold: number;
  sku: string | null;
  isActive: boolean;
  imageUrl: string | null;
  sourceModelId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/store/products — full product payload with images, variants, category */
export interface SellerProductFull {
  id: string;
  storeId: string;
  categoryId: string | null;
  title: string;
  slug: string;
  description: string | null;
  status: string;
  rejectReason: string | null;
  priceMinor: number;
  commissionPercentOverride: number | null;
  flagsJson: string;
  reportsCount: number;
  salesCount: number;
  viewCount: number;
  ratingAvg: number;
  ratingCount: number;
  isFeatured: boolean;
  publishedAt: string | null;
  storeCategoryId: string | null;
  isFixture: boolean;
  sourcePlatform: string | null;
  sourceShopId: string | null;
  sourceProductId: string | null;
  sourceUrl: string | null;
  sourceBrand: string | null;
  sourceStatus: string | null;
  lastSyncedAt: string | null;
  overridesJson: string;
  affiliateEnabled: boolean;
  affiliateRateBps: number | null;
  seoTitle: string | null;
  seoDescription: string | null;
  createdAt: string;
  updatedAt: string;
  images: SellerProductImage[];
  variants: SellerProductVariant[];
  category: { id: string; name: string; slug: string } | null;
}

/** GET /api/store/products — paged seller catalog */
export type SellerProductsListResponse = ApiPage<SellerProductFull>;

/** POST /api/store/products — variant input shared by create/patch product */
export interface SellerVariantInput {
  name?: string;
  optionName?: string | null;
  optionValue?: string | null;
  priceMinor: number;
  compareAtPriceMinor?: number | null;
  stock?: number;
  moq?: number;
  lowStockThreshold?: number;
  sku?: string | null;
}

/** POST /api/store/products — create product body */
export interface SellerProductCreateBody {
  title: string;
  description?: string | null;
  images?: string[];
  variants: SellerVariantInput[];
  categoryId?: string | null;
  storeCategoryId?: string | null;
  isFeatured?: boolean;
}

/** POST /api/store/products — created product (HTTP 201) */
export type SellerProductCreateResponse = ApiOk<SellerProductFull>;

/** GET /api/store/products/[id] — own product without category (unlike list/create/PATCH) */
export type SellerProductGetResponse = ApiOk<Omit<SellerProductFull, "category">>;

/** PATCH /api/store/products/[id] — update product body */
export interface SellerProductPatchBody {
  title?: string;
  description?: string | null;
  categoryId?: string | null;
  storeCategoryId?: string | null;
  isFeatured?: boolean;
  images?: string[];
  variants?: SellerVariantInput[];
  regenerateSlug?: boolean;
  resubmit?: boolean;
}

/** PATCH /api/store/products/[id] — updated product */
export type SellerProductPatchResponse = ApiOk<SellerProductFull>;

/** DELETE /api/store/products/[id] — soft-archived product ack */
export interface SellerProductDeleteData {
  id: string;
  status: string;
}

/** DELETE /api/store/products/[id] — soft-archived product ack */
export type SellerProductDeleteResponse = ApiOk<SellerProductDeleteData>;

/** POST /api/store/products/[id]/variants — add variant body */
export interface SellerVariantCreateBody {
  name?: string;
  optionName?: string | null;
  optionValue?: string | null;
  priceMinor: number;
  compareAtPriceMinor?: number | null;
  stock?: number;
  lowStockThreshold?: number;
  sku?: string | null;
}

/** POST /api/store/products/[id]/variants — created variant (HTTP 201) */
export type SellerVariantCreateResponse = ApiOk<SellerProductVariant>;

/** PATCH /api/store/variants/[id] — update variant body */
export interface SellerVariantPatchBody {
  name?: string;
  optionName?: string | null;
  optionValue?: string | null;
  priceMinor?: number;
  compareAtPriceMinor?: number | null;
  stock?: number;
  lowStockThreshold?: number;
  sku?: string | null;
  isActive?: boolean;
}

/** PATCH /api/store/variants/[id] — updated variant */
export type SellerVariantPatchResponse = ApiOk<SellerProductVariant>;

/** DELETE /api/store/variants/[id] — soft-deactivated variant ack */
export interface SellerVariantDeleteData {
  id: string;
  isActive: boolean;
}

/** DELETE /api/store/variants/[id] — soft-deactivated variant ack */
export type SellerVariantDeleteResponse = ApiOk<SellerVariantDeleteData>;

/** GET /api/store/categories — storefront category row with product count */
export interface StoreCategoryRow {
  id: string;
  name: string;
  sortOrder: number;
  productCount: number;
}

/** GET /api/store/categories — unpaginated storefront categories (plain ok envelope, no meta) */
export type StoreCategoriesResponse = ApiOk<StoreCategoryRow[]>;

/** POST /api/store/categories — create storefront category body */
export interface StoreCategoryCreateBody {
  name: string;
}

/** POST /api/store/categories — created storefront category (HTTP 201) */
export type StoreCategoryCreateResponse = ApiOk<StoreCategoryRow>;

/** PATCH /api/store/categories/[id] — rename/reorder body */
export interface StoreCategoryPatchBody {
  name?: string;
  direction?: "up" | "down";
}

/** PATCH /api/store/categories/[id] — renamed/reordered category */
export interface StoreCategoryPatchData {
  id: string;
  name: string;
  sortOrder: number;
}

/** PATCH /api/store/categories/[id] — renamed/reordered category */
export type StoreCategoryPatchResponse = ApiOk<StoreCategoryPatchData>;

/** DELETE /api/store/categories/[id] — deleted category ack */
export interface StoreCategoryDeleteData {
  id: string;
  deleted: boolean;
}

/** DELETE /api/store/categories/[id] — deleted category ack */
export type StoreCategoryDeleteResponse = ApiOk<StoreCategoryDeleteData>;

/** GET /api/store/collections — collection row with embedded product summaries */
export interface SellerCollectionRow {
  id: string;
  storeId: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  productCount: number;
  products: { id: string; title: string; slug: string; priceMinor: number; status: string }[];
}

/** GET /api/store/collections — unpaginated collections list (plain ok envelope, no meta) */
export type SellerCollectionsListResponse = ApiOk<SellerCollectionRow[]>;

/** POST /api/store/collections — create collection body */
export interface SellerCollectionCreateBody {
  name: string;
  description?: string | null;
}

/** POST /api/store/collections — created collection (HTTP 201) */
export type SellerCollectionCreateResponse = ApiOk<SellerCollectionRow>;

/** PATCH /api/store/collections/[id] — update collection body */
export interface SellerCollectionPatchBody {
  name?: string;
  description?: string | null;
}

/** PATCH /api/store/collections/[id] — updated collection (without product summaries) */
export interface SellerCollectionPatchData {
  id: string;
  storeId: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/** PATCH /api/store/collections/[id] — updated collection (without product summaries) */
export type SellerCollectionPatchResponse = ApiOk<SellerCollectionPatchData>;

/** DELETE /api/store/collections/[id] — hard-deleted collection ack */
export interface SellerCollectionDeleteData {
  id: string;
  deleted: boolean;
}

/** DELETE /api/store/collections/[id] — hard-deleted collection ack */
export type SellerCollectionDeleteResponse = ApiOk<SellerCollectionDeleteData>;

/** POST /api/store/collections/[id]/products — replace membership body */
export interface SellerCollectionProductsBody {
  productIds: string[];
}

/** POST /api/store/collections/[id]/products — replaced membership ack */
export interface SellerCollectionProductsData {
  id: string;
  slug: string;
  productIds: string[];
}

/** POST /api/store/collections/[id]/products — replaced membership ack */
export type SellerCollectionProductsResponse = ApiOk<SellerCollectionProductsData>;

/** GET /api/store/coupons — coupon row */
export interface SellerCouponRow {
  id: string;
  scope: string;
  storeId: string | null;
  code: string;
  description: string | null;
  type: string;
  percent: number | null;
  amountMinor: number | null;
  minSpendMinor: number;
  maxRedemptions: number | null;
  perCustomerLimit: number;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  timesUsed: number;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/store/coupons — unpaginated coupons list, newest first (plain ok envelope, no meta) */
export type SellerCouponsListResponse = ApiOk<SellerCouponRow[]>;

/** POST /api/store/coupons — create coupon body */
export interface SellerCouponCreateBody {
  code: string;
  type: "percent" | "fixed" | "freeship";
  description?: string | null;
  percent?: number;
  amountMinor?: number;
  minSpendMinor?: number;
  maxRedemptions?: number | null;
  perCustomerLimit?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  isActive?: boolean;
}

/** POST /api/store/coupons — created coupon (HTTP 201) */
export type SellerCouponCreateResponse = ApiOk<SellerCouponRow>;

/** PATCH /api/store/coupons/[id] — update coupon body (code and type immutable) */
export interface SellerCouponPatchBody {
  description?: string | null;
  percent?: number;
  amountMinor?: number;
  minSpendMinor?: number;
  maxRedemptions?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  isActive?: boolean;
}

/** PATCH /api/store/coupons/[id] — updated coupon */
export type SellerCouponPatchResponse = ApiOk<SellerCouponRow>;

/** DELETE /api/store/coupons/[id] — hard-deleted coupon ack */
export interface SellerCouponDeleteData {
  id: string;
  deleted: boolean;
}

/** DELETE /api/store/coupons/[id] — hard-deleted coupon ack */
export type SellerCouponDeleteResponse = ApiOk<SellerCouponDeleteData>;

/** GET /api/store/campaigns — tracking campaign row (with linkPath) */
export interface SellerCampaignRow {
  id: string;
  name: string;
  slug: string;
  code: string;
  status: string;
  defaultSource: string | null;
  defaultMedium: string | null;
  createdAt: string;
  linkPath: string;
}

/** GET /api/store/campaigns — unpaginated campaigns list (plain ok envelope, no meta) */
export type SellerCampaignsListResponse = ApiOk<SellerCampaignRow[]>;

/** POST /api/store/campaigns — create tracking campaign body */
export interface SellerCampaignCreateBody {
  name: string;
  source?: string;
  medium?: string;
}

/** POST /api/store/campaigns — created campaign (HTTP 201) */
export type SellerCampaignCreateResponse = ApiOk<SellerCampaignRow>;

/** PATCH /api/store/campaigns/[id] — rename/archive body (slug and code immutable) */
export interface SellerCampaignPatchBody {
  name?: string;
  status?: "active" | "archived";
}

/** PATCH /api/store/campaigns/[id] — updated campaign (linkPath omitted) */
export interface SellerCampaignPatchData {
  id: string;
  name: string;
  slug: string;
  code: string;
  status: string;
  defaultSource: string | null;
  defaultMedium: string | null;
  createdAt: string;
}

/** PATCH /api/store/campaigns/[id] — updated campaign (linkPath omitted) */
export type SellerCampaignPatchResponse = ApiOk<SellerCampaignPatchData>;

/** GET /api/store/vouchers — store-scope voucher row */
export interface SellerVoucherRow {
  id: string;
  code: string;
  title: string;
  kind: string;
  discountMinor: number;
  percentOff: number | null;
  maxDiscountMinor: number | null;
  minSpendMinor: number;
  expiryAt: string;
  isActive: boolean;
  createdAt: string;
  scope: string;
  storeId: string | null;
  regionLimit: string | null;
  quota: number | null;
  claimedCount: number;
  startsAt: string | null;
}

/** GET /api/store/vouchers — panel voucher row with claim/usage stats */
export interface SellerVoucherPanelRow {
  id: string;
  code: string;
  title: string;
  kind: string;
  discountMinor: number;
  percentOff: number | null;
  maxDiscountMinor: number | null;
  minSpendMinor: number;
  expiryAt: string;
  startsAt: string | null;
  isActive: boolean;
  scope: string;
  regionLimit: string | null;
  quota: number | null;
  claimedCount: number;
  holders: number;
  usedCount: number;
  createdAt: string;
}

/** GET /api/store/vouchers — voucher panel composite payload */
export interface SellerVouchersPanelData {
  vouchers: SellerVoucherPanelRow[];
  fsPriceAdjustMinor: number;
}

/** GET /api/store/vouchers — voucher panel (composite ok envelope, no meta) */
export type SellerVouchersPanelResponse = ApiOk<SellerVouchersPanelData>;

/** POST /api/store/vouchers — create store voucher body */
export interface SellerVoucherCreateBody {
  title: string;
  kind: "discount" | "freeshipping";
  code?: string;
  discountMinor?: number;
  percentOff?: number;
  maxDiscountMinor?: number;
  minSpendMinor?: number;
  quota?: number | null;
  startsAt?: string | null;
  expiryAt: string;
  isActive?: boolean;
}

/** POST /api/store/vouchers — created voucher payload (HTTP 201) */
export interface SellerVoucherCreateData {
  voucher: {
    id: string;
    code: string;
    title: string;
    kind: string;
    discountMinor: number;
    percentOff: number | null;
    maxDiscountMinor: number | null;
    minSpendMinor: number;
    expiryAt: string;
    startsAt: string | null;
    isActive: boolean;
    scope: string;
    regionLimit: string | null;
    quota: number | null;
  };
}

/** POST /api/store/vouchers — created voucher (HTTP 201) */
export type SellerVoucherCreateResponse = ApiOk<SellerVoucherCreateData>;

/** PATCH /api/store/vouchers/[id] — toggle/edit voucher body */
export interface SellerVoucherPatchBody {
  isActive?: boolean;
  title?: string;
  kind?: "discount" | "freeshipping";
  discountMinor?: number;
  percentOff?: number | null;
  maxDiscountMinor?: number | null;
  minSpendMinor?: number;
  expiryAt?: string;
  quota?: number | null;
}

/** PATCH /api/store/vouchers/[id] — updated voucher with holder/redeem counts */
export type SellerVoucherPatchResponse = ApiOk<SellerVoucherRow & { heldCount: number; redeemedCount: number }>;

/** DELETE /api/store/vouchers/[id] — paused (soft-deleted) voucher ack */
export type SellerVoucherDeleteResponse = ApiOk<SellerVoucherRow & { deleted: boolean }>;

/** POST /api/store/vouchers/price-adjust — free-shipping markup apply/revert body */
export interface PriceAdjustBody {
  action: "apply" | "revert";
  amountMinor?: number;
}

/** POST /api/store/vouchers/price-adjust — markup apply/revert result */
export interface PriceAdjustData {
  action: string;
  amountMinor: number;
  updatedCount: number;
  fsPriceAdjustMinor: number;
}

/** POST /api/store/vouchers/price-adjust — markup apply/revert result */
export type PriceAdjustResponse = ApiOk<PriceAdjustData>;

/** GET /api/store/pages — CMS page list row */
export interface SellerPageRow {
  id: string;
  slug: string;
  title: string;
  pageType: string;
  draftVersion: number;
  publishedVersion: number;
  hasUnpublished: boolean;
  published: boolean;
  sectionCount: number;
  updatedAt: string;
}

/** GET /api/store/pages — unpaginated CMS pages list (plain ok envelope, no meta) */
export type SellerPagesListResponse = ApiOk<SellerPageRow[]>;

/** GET /api/store/pages/[id] — parsed CMS document (sections + version) */
export interface SellerPageDoc {
  sections: { id: string; type: string; props: Record<string, unknown> }[];
  version: number;
}

/** GET /api/store/pages/[id] — page with parsed draft and published documents */
export interface SellerPageGetData {
  page: {
    id: string;
    slug: string;
    title: string;
    pageType: string;
    draftVersion: number;
    publishedVersion: number;
    hasUnpublished: boolean;
    published: boolean;
  };
  draft: SellerPageDoc;
  published: SellerPageDoc | null;
}

/** GET /api/store/pages/[id] — page with parsed draft and published documents */
export type SellerPageGetResponse = ApiOk<SellerPageGetData>;

/** PUT /api/store/pages/[id]/draft — save draft body */
export interface SellerPageDraftBody {
  sections: { id?: string; type?: string; props?: Record<string, unknown> }[];
}

/** PUT /api/store/pages/[id]/draft — saved draft ack */
export interface SellerPageDraftData {
  id: string;
  slug: string;
  draftVersion: number;
  hasUnpublished: boolean;
  doc: SellerPageDoc;
}

/** PUT /api/store/pages/[id]/draft — saved draft ack */
export type SellerPageDraftResponse = ApiOk<SellerPageDraftData>;

/** POST /api/store/pages/[id]/publish — publish draft ack */
export interface SellerPagePublishData {
  id: string;
  slug: string;
  publishedVersion: number;
  hasUnpublished: boolean;
}

/** POST /api/store/pages/[id]/publish — publish draft ack */
export type SellerPagePublishResponse = ApiOk<SellerPagePublishData>;

/** POST /api/store/pages/[id]/revert — reverted draft ack */
export interface SellerPageRevertData {
  id: string;
  slug: string;
  draftVersion: number;
  hasUnpublished: boolean;
  doc: SellerPageDoc;
}

/** POST /api/store/pages/[id]/revert — reverted draft ack */
export type SellerPageRevertResponse = ApiOk<SellerPageRevertData>;

/** GET /api/store/imports — import job row (latest 30) */
export interface StoreImportJobRow {
  id: string;
  trackingToken: string;
  platform: string;
  urlType: string;
  inputUrl: string;
  status: string;
  phaseDetail: string | null;
  isFixture: boolean;
  storeId: string | null;
  createdAt: string;
  finishedAt: string | null;
  itemCount: number;
  productsOk: number | null;
  productsFailed: number | null;
  progress: Record<string, number>;
  errorMessage: string | null;
}

/** GET /api/store/imports — marketplace connection status row */
export interface StoreImportConnectionRow {
  platform: string;
  status: string;
  shopName: string | null;
  expiresAt: string | null;
  envConfigured: boolean;
}

/** GET /api/store/imports — import centre composite payload */
export interface StoreImportsData {
  jobs: StoreImportJobRow[];
  connections: StoreImportConnectionRow[];
  env: { shopee: boolean; tiktok: boolean };
}

/** GET /api/store/imports — import centre (jobs, connections, env flags) */
export type StoreImportsResponse = ApiOk<StoreImportsData>;

/** POST /api/import/jobs — create import job body */
export interface SellerImportJobCreateBody {
  url: string;
  allowFixture?: boolean;
}

/** POST /api/import/jobs — created job handle */
export interface SellerImportJobCreateData {
  jobId: string;
  trackingToken: string;
  status: string;
  pollUrl: string;
}

/** POST /api/import/jobs — created job handle */
export type SellerImportJobCreateResponse = ApiOk<SellerImportJobCreateData>;

/** GET /api/import/jobs/[id] — poll query (tracking token required) */
export interface SellerImportJobGetQuery {
  token: string;
}

/** GET /api/import/jobs/[id] — imported item row */
export interface SellerImportJobItemRow {
  id: string;
  sourceProductId: string;
  title: string | null;
  status: string;
  error: string | null;
  warnings: string[];
}

/** GET /api/import/jobs/[id] — job summary (shop, claim token, tallies) */
export interface SellerImportJobSummary {
  shop: { name: string; sourceShopId: string; region?: string | null } | null;
  authorisationRequired: boolean;
  beginUrl: string | null;
  missingEnv: string[];
  claimToken: string | null;
  claimExpiresAt: string | null;
  claimMethod: string | null;
  warnings: string[];
  productsOk: number | null;
  productsFailed: number | null;
}

/** GET /api/import/jobs/[id] — full job poll payload */
export interface SellerImportJobGetData {
  id: string;
  platform: string;
  platformLabel: string;
  urlType: string;
  inputUrl: string;
  status: string;
  phaseDetail: string | null;
  isFixture: boolean;
  progress: Record<string, number>;
  error: { code?: string; message?: string } | null;
  summary: SellerImportJobSummary;
  store: { id: string; name: string; slug: string; status: string } | null;
  items: SellerImportJobItemRow[];
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** GET /api/import/jobs/[id] — full job poll payload */
export type SellerImportJobGetResponse = ApiOk<SellerImportJobGetData>;

/** POST /api/import/jobs/[id]/resume — resume query (tracking token required) */
export interface SellerImportJobResumeQuery {
  token: string;
}

/** POST /api/import/jobs/[id]/resume — resumed job status */
export interface SellerImportJobResumeData {
  status: string;
}

/** POST /api/import/jobs/[id]/resume — resumed job status */
export type SellerImportJobResumeResponse = ApiOk<SellerImportJobResumeData>;

/** POST /api/import/jobs/[id]/claim/validate — validate claim token body */
export interface ClaimValidateBody {
  claimToken: string;
}

/** POST /api/import/jobs/[id]/claim/validate — claim validation result */
export interface ClaimValidateData {
  storeId: string;
  storeSlug: string;
  storeName: string;
  method: string;
  store: { id: string; name: string; slug: string; tagline: string | null; logoUrl: string | null; productCount: number } | null;
}

/** POST /api/import/jobs/[id]/claim/validate — claim validation result */
export type ClaimValidateResponse = ApiOk<ClaimValidateData>;

/** POST /api/import/resolve — resolve marketplace URL body */
export interface SellerImportResolveBody {
  url: string;
}

/** POST /api/import/resolve — URL resolution result */
export interface SellerImportResolveData {
  platform: string;
  platformLabel: string;
  urlType: string;
  shopId: string | null;
  productId: string | null;
  normalizedUrl: string;
  isFixture: boolean;
  setCap: boolean;
  connector: {
    envConfigured: boolean;
    connected: boolean;
    needsAuthorisation: boolean;
    missingEnv: string[];
  };
}

/** POST /api/import/resolve — URL resolution result */
export type SellerImportResolveResponse = ApiOk<SellerImportResolveData>;

/** POST /api/claim/bind — bind claimed store body */
export interface ClaimBindBody {
  jobId: string;
  claimToken: string;
  method?: "oauth_shopee" | "oauth_tiktok" | "claim_code";
  evidence?: { connectionShopId?: string };
}

/** POST /api/claim/bind — bind result with next step */
export interface ClaimBindData {
  store: { id: string; name: string; slug: string } | null;
  nextStep: string;
}

/** POST /api/claim/bind — bind result with next step */
export type ClaimBindResponse = ApiOk<ClaimBindData>;

/** POST /api/store/inventory/adjust — atomic stock delta body */
export interface InventoryAdjustBody {
  variantId: string;
  delta: number;
  reason?: string;
}

/** POST /api/store/inventory/adjust — adjusted variant state */
export interface InventoryAdjustData {
  id: string;
  stock: number;
  lowStock: boolean;
}

/** POST /api/store/inventory/adjust — adjusted variant state */
export type InventoryAdjustResponse = ApiOk<InventoryAdjustData>;

/** GET /api/store/pending-releases — pagination query (size default 25, max 100) */
export interface PendingReleasesQuery {
  page?: number;
  size?: number;
}

/** GET /api/store/pending-releases — pending credits summary */
export interface PendingReleasesSummary {
  totalMinor: number;
  count: number;
  nextReleaseAt: string | null;
}

/** GET /api/store/pending-releases — per-order release schedule row */
export interface PendingReleaseRow {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  amountMinor: number;
  paidAt: string;
  availableAt: string;
  holdDays: number;
}

/** GET /api/store/pending-releases — composite paged payload (okPaged composite data) */
export interface PendingReleasesData {
  summary: PendingReleasesSummary;
  releases: PendingReleaseRow[];
}

/** GET /api/store/pending-releases — grace-period pending seller credits */
export type PendingReleasesResponse = ApiPage<PendingReleasesData>;

// ============================================================
// §11 Seller Backend — Orders & Fulfillment
// ============================================================

/** GET /api/store/orders — seller order list query (status group, search, pagination) */
export interface SellerOrdersQuery {
  status?: string;
  search?: string;
  page?: number;
  size?: number;
}

/** GET /api/store/orders — seller order list row */
export interface SellerOrderRow {
  id: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  status: string;
  channel: string;
  totalMinor: number;
  currency: string;
  itemCount: number;
  trackingNumber: string | null;
  createdAt: string;
  paidAt: string | null;
  shippedAt: string | null;
}

/** GET /api/store/orders — paged seller orders */
export type SellerOrdersListResponse = ApiPage<SellerOrderRow>;

/** GET /api/store/orders/[id] — order line item row */
export interface SellerOrderItemRow {
  id: string;
  orderId: string;
  productId: string | null;
  variantId: string | null;
  title: string;
  variantLabel: string | null;
  unitPriceMinor: number;
  qty: number;
  lineSubtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  commissionPercent: number;
  commissionMinor: number;
  fixedFeeMinor: number;
  sellerNetMinor: number;
  breakdownJson: string;
  refundedMinor: number;
  affiliateDirectId: string | null;
  affiliateSponsorId: string | null;
  affiliateLinkId: string | null;
  affiliateRateBps: number | null;
  affiliatePoolMinor: number;
  affiliateSponsorEnabled: boolean | null;
}

/** GET /api/store/orders/[id] — order status history row */
export interface SellerOrderHistoryRow {
  id: string;
  orderId: string;
  fromStatus: string | null;
  toStatus: string;
  actor: string;
  note: string | null;
  createdAt: string;
}

/** GET /api/store/orders/[id] — payment intent row */
export interface SellerOrderPaymentIntentRow {
  id: string;
  orderId: string;
  provider: string;
  providerRef: string;
  amountMinor: number;
  status: string;
  redirectUrl: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/store/orders/[id] — refund row */
export interface SellerOrderRefundRow {
  id: string;
  orderId: string;
  amountMinor: number;
  reason: string | null;
  status: string;
  requestedBy: string;
  restock: boolean;
  commissionReversalMinor: number;
  affiliateReversalMinor: number;
  processedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/store/orders/[id] — full order detail payload */
export interface SellerOrderDetailData {
  id: string;
  storeId: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  cartToken: string | null;
  shopperId: string | null;
  status: string;
  disputedFlag: boolean;
  channel: string;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  couponCode: string | null;
  customerNote: string | null;
  paymentProvider: string | null;
  idemKey: string | null;
  voucherId: string | null;
  paidAt: string | null;
  fulfilledAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  receivedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  trackingNumber: string | null;
  trackingProvider: string | null;
  riskFlagsJson: string;
  shippingAddressJson: string;
  shippingAddress: Record<string, unknown>;
  latestPaymentRef: string | null;
  shippingCountryCode: string;
  shippingCountrySource: string;
  attrCampaignId: string | null;
  attrSource: string | null;
  attrMedium: string | null;
  attrCampaign: string | null;
  attrTerm: string | null;
  attrContent: string | null;
  createdAt: string;
  updatedAt: string;
  paymentGroupId: string | null;
  items: SellerOrderItemRow[];
  history: SellerOrderHistoryRow[];
  paymentIntents: SellerOrderPaymentIntentRow[];
  refunds: SellerOrderRefundRow[];
}

/** GET /api/store/orders/[id] — full order detail (items, history, payment intents, refunds) */
export type SellerOrderDetailResponse = ApiOk<SellerOrderDetailData>;

// GET /api/store/orders/[id]/label — non-envelope: raw image/svg+xml body (decoded AWB label, inline or attachment disposition)

/** POST /api/store/orders/[id]/fulfill — fulfilled order ack (no request body) */
export interface FulfillData {
  id: string;
  status: string;
  fulfilledAt: string;
}

/** POST /api/store/orders/[id]/fulfill — fulfilled order ack (no request body) */
export type FulfillResponse = ApiOk<FulfillData>;

/** POST /api/store/orders/[id]/refund-request — request refund body */
export interface RefundRequestBody {
  amountMinor: number;
  reason?: string;
  restock?: boolean;
}

/** POST /api/store/orders/[id]/refund-request — created refund request row (HTTP 201) */
export interface RefundRequestData {
  id: string;
  orderId: string;
  amountMinor: number;
  reason: string | null;
  status: string;
  requestedBy: string;
  restock: boolean;
  commissionReversalMinor: number;
  affiliateReversalMinor: number;
  processedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/store/orders/[id]/refund-request — created refund request row (HTTP 201) */
export type RefundRequestResponse = ApiOk<RefundRequestData>;

/** POST /api/store/orders/[id]/ship — ship order body (platform booking or manual tracking) */
export interface ShipBody {
  mode?: "platform" | "manual";
  rateId?: string;
  providerId?: string;
  provider?: string;
  trackingNumber?: string;
}

/** POST /api/store/orders/[id]/ship — shipped order with shipment info */
export interface ShipData {
  id: string;
  status: string;
  shippedAt: string;
  trackingNumber: string;
  trackingProvider: string;
  shipmentStatus: string | null;
  shipment: {
    awbNumber: string | null;
    courierName: string | null;
    etaFrom: string | null;
    etaTo: string | null;
    labelUrl: string | null;
  } | null;
}

/** POST /api/store/orders/[id]/ship — shipped order with shipment info */
export type ShipResponse = ApiOk<ShipData>;

/** POST /api/store/orders/[id]/deliver — mark delivered body */
export interface DeliverBody {
  proof?: string;
  note?: string;
}

/** POST /api/store/orders/[id]/deliver — delivered order ack */
export interface DeliverData {
  id: string;
  orderNumber: string;
  status: string;
  deliveredAt: string;
  shipmentStatus: string | null;
}

/** POST /api/store/orders/[id]/deliver — delivered order ack */
export type DeliverResponse = ApiOk<DeliverData>;

// ============================================================
// §12 Seller Backend — Insights & Analytics
// ============================================================

/** GET /api/store/insights/* — shared reporting window descriptor (current + previous range) */
export interface InsightsWindow {
  key: string;
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  days: number;
}

/** GET /api/store/insights/sales — sales report query */
export interface InsightsSalesQuery {
  window?: "today" | "7d" | "30d" | "custom";
  from?: string;
  to?: string;
  granularity?: "day" | "week" | "month";
  fresh?: "1";
}

/** GET /api/store/insights/sales — summary cards with previous-period comparisons */
export interface InsightsSalesCards {
  paidOrders: number;
  paidOrdersPrev: number;
  unitsSold: number;
  unitsSoldPrev: number;
  grossSalesMinor: number;
  grossSalesMinorPrev: number;
  grossProductSalesMinor: number;
  grossProductSalesMinorPrev: number;
  discountsMinor: number;
  discountsMinorPrev: number;
  shippingChargedMinor: number;
  shippingChargedMinorPrev: number;
  sellerProceedsMinor: number;
  sellerProceedsMinorPrev: number;
  refundedItemsMinor: number;
  refundsMinor: number;
  refundsMinorPrev: number;
  refundCount: number;
  refundCountPrev: number;
  cancelledOrders: number;
  cancelledOrdersPrev: number;
  aovMinor: number | null;
  aovMinorPrev: number | null;
  netProductSalesMinor: number;
  visitToPurchaseRate: number | null;
}

/** GET /api/store/insights/sales — trend bucket row */
export interface InsightsSalesDayRow {
  bucket: string;
  grossSalesMinor: number;
  netProductSalesMinor: number;
  orders: number;
  units: number;
  refundsMinor: number;
}

/** GET /api/store/insights/sales — top product row */
export interface InsightsTopProductRow {
  productId: string;
  title: string;
  units: number;
  netSalesMinor: number;
}

/** GET /api/store/insights/sales — fulfillment stats */
export interface InsightsFulfillmentStats {
  unfulfilledPaidOrders: number;
  avgPaidToShippedHours: number | null;
  shippedSample: number;
  note: string;
}

/** GET /api/store/insights/sales — authoritative sales report payload */
export interface SalesInsightsData {
  window: InsightsWindow;
  generatedAt: string;
  cards: InsightsSalesCards;
  byDay: InsightsSalesDayRow[];
  granularity: string;
  topProducts: InsightsTopProductRow[];
  fulfillment: InsightsFulfillmentStats;
  notes: string[];
}

/** GET /api/store/insights/sales — authoritative sales report */
export type SalesInsightsResponse = ApiOk<SalesInsightsData>;

/** GET /api/store/insights/product-traffic — traffic report query (productId drill-down) */
export interface InsightsProductTrafficQuery {
  window?: "today" | "7d" | "30d" | "1y" | "custom";
  from?: string;
  to?: string;
  productId?: string;
  fresh?: "1";
}

/** GET /api/store/insights/product-traffic — top viewed product row */
export interface InsightsTrafficProductRow {
  productId: string;
  title: string;
  slug: string;
  imageUrl: string | null;
  views: number;
  uniqueViewers: number;
  cartAddTimes: number;
  cartAddUnits: number;
  cartRemoveTimes: number;
  cartRemoveUnits: number;
  purchaseOrders: number;
  purchaseUnits: number;
}

/** GET /api/store/insights/product-traffic — traffic totals */
export interface InsightsTrafficTotals {
  views: number;
  uniqueViewers: number;
  cartAddTimes: number;
  cartAddUnits: number;
  cartRemoveTimes: number;
  cartRemoveUnits: number;
  purchaseOrders: number;
  purchaseUnits: number;
}

/** GET /api/store/insights/product-traffic|overview — channel row */
export interface InsightsChannelRow {
  channel: string;
  views: number;
  sessions: number;
}

/** GET /api/store/insights/product-traffic — referrer row */
export interface InsightsReferrerRow {
  host: string;
  views: number;
}

/** GET /api/store/insights/product-traffic — daily views row */
export interface InsightsTrafficDayRow {
  day: string;
  views: number;
}

/** GET /api/store/insights/product-traffic — per-product traffic payload (top-8 or drill-down) */
export interface InsightsProductTrafficData {
  window: InsightsWindow;
  generatedAt: string;
  topViewedProducts?: InsightsTrafficProductRow[];
  truncated: boolean;
  product?: { id: string; title: string; slug: string; imageUrl: string | null };
  totals?: InsightsTrafficTotals;
  channels?: InsightsChannelRow[];
  referrers?: InsightsReferrerRow[];
  byDay?: InsightsTrafficDayRow[];
  notes?: string[];
}

/** GET /api/store/insights/product-traffic — per-product traffic */
export type InsightsProductTrafficResponse = ApiOk<InsightsProductTrafficData>;

/** GET /api/store/insights/products — product performance table query */
export interface InsightsProductPerformanceQuery {
  window?: "today" | "7d" | "30d" | "custom";
  from?: string;
  to?: string;
  sort?: "views" | "adds" | "cartQty" | "purchases" | "revenue" | "conversion";
  page?: number;
  size?: number;
  fresh?: "1";
}

/** GET /api/store/insights/products — product performance row */
export interface InsightsProductPerformanceRow {
  productId: string;
  title: string;
  slug: string;
  imageUrl: string | null;
  status: string;
  views: number;
  viewSessions: number;
  addUnits: number;
  addEvents: number;
  currentCartUnits: number;
  currentCarts: number;
  orderedUnits: number;
  purchasedUnits: number;
  grossSalesMinor: number;
  netSalesMinor: number;
  refundedMinor: number;
  viewToCartRate: number | null;
  checkoutToPurchaseRate: number | null;
}

/** GET /api/store/insights/products — paged product performance payload */
export interface InsightsProductPerformanceData {
  rows: InsightsProductPerformanceRow[];
  meta: ApiPageMeta;
  notes: string[];
}

/** GET /api/store/insights/products — paged sortable product performance table */
export type InsightsProductPerformanceResponse = ApiPage<InsightsProductPerformanceData>;

/** GET /api/store/insights/markets — markets report query */
export interface InsightsMarketsQuery {
  window?: "today" | "7d" | "30d" | "custom";
  from?: string;
  to?: string;
  dimension?: "country" | "state";
  fresh?: "1";
}

/** GET /api/store/insights/markets — geography row */
export interface InsightsMarketRow {
  code: string;
  label: string;
  paidOrders: number;
  paidOrdersPrev: number;
  unitsSold: number;
  grossProductSalesMinor: number;
  discountsMinor: number;
  refundsMinor: number;
  netProductSalesMinor: number;
  shippingChargedMinor: number;
  aovMinor: number | null;
  shareNetPct: number | null;
  shareOrdersPct: number | null;
  growthPct: number | null;
  isNew: boolean;
  source: string;
}

/** GET /api/store/insights/markets — mover row (riser/faller) */
export interface InsightsMarketMoverRow {
  code: string;
  label: string;
  growthPct: number;
}

/** GET /api/store/insights/markets — sales by geography payload */
export interface InsightsMarketsData {
  window: InsightsWindow;
  generatedAt: string;
  dimension: "country" | "state";
  rows: InsightsMarketRow[];
  totals: { paidOrders: number; netProductSalesMinor: number };
  notes: string[];
  movers: {
    risers: InsightsMarketMoverRow[];
    fallers: InsightsMarketMoverRow[];
  };
}

/** GET /api/store/insights/markets — sales by geography */
export type InsightsMarketsResponse = ApiOk<InsightsMarketsData>;

/** GET /api/store/insights/markets/products — market products query (code required) */
export interface InsightsMarketProductsQuery {
  window?: "today" | "7d" | "30d" | "custom";
  from?: string;
  to?: string;
  dimension?: "country" | "state";
  code: string;
  fresh?: "1";
}

/** GET /api/store/insights/markets/products — product performance in market row */
export interface InsightsMarketProductRow {
  productId: string;
  title: string;
  slug: string;
  imageUrl: string | null;
  unitsSold: number;
  grossProductSalesMinor: number;
  discountsMinor: number;
  refundedMinor: number;
  netProductSalesMinor: number;
  paidOrders: number;
  avgSellingPriceMinor: number | null;
  views: number;
  addUnits: number;
}

/** GET /api/store/insights/markets/products — product performance in one market payload */
export interface InsightsMarketProductsData {
  window: InsightsWindow;
  generatedAt: string;
  dimension: "country" | "state";
  code: string;
  label: string;
  rows: InsightsMarketProductRow[];
  notes: string[];
}

/** GET /api/store/insights/markets/products — product performance in one market */
export type InsightsMarketProductsResponse = ApiOk<InsightsMarketProductsData>;

/** GET /api/store/insights/funnel — funnel report query (productId drill-down) */
export interface InsightsFunnelQuery {
  window?: "today" | "7d" | "30d" | "1y" | "custom";
  from?: string;
  to?: string;
  productId?: string;
  fresh?: "1";
}

/** GET /api/store/insights/funnel|overview — event freshness note */
export interface InsightsFreshness {
  eventsUpTo: string | null;
  trackingSince: string | null;
  note: string | null;
}

/** GET /api/store/insights/funnel|overview — funnel stage row */
export interface InsightsFunnelStageRow {
  key: string;
  label: string;
  count: number;
  prev: number;
  stepRate: number | null;
  dropOff: number | null;
  dropOffPct: number | null;
}

/** GET /api/store/insights/funnel — product selector row */
export interface InsightsFunnelProductRow {
  productId: string;
  title: string;
  slug: string;
  imageUrl: string | null;
  views: number;
  cartAdds: number;
}

/** GET /api/store/insights/funnel — daily funnel series row */
export interface InsightsFunnelDayRow {
  day: string;
  visits?: number;
  productViews: number;
  cartAdds: number;
  checkouts: number;
  paidOrders: number;
}

/** GET /api/store/insights/funnel — conversion funnel payload */
export interface InsightsFunnelData {
  scope: "store" | "product";
  product: { id: string; title: string; slug: string; imageUrl: string | null; unitsSold: number; revenueMinor: number; ordersPaid: number } | null;
  products: InsightsFunnelProductRow[];
  productsTruncated: boolean;
  window: InsightsWindow;
  generatedAt: string;
  freshness: InsightsFreshness;
  stages: InsightsFunnelStageRow[];
  byDay: InsightsFunnelDayRow[];
  truncated: boolean;
  paymentAttempts: number;
  paymentAttemptsPrev: number;
  basis: string[];
}

/** GET /api/store/insights/funnel — conversion funnel */
export type InsightsFunnelResponse = ApiOk<InsightsFunnelData>;

/** GET /api/store/insights/cart — cart insights query */
export interface InsightsCartQuery {
  window?: "today" | "7d" | "30d" | "custom";
  from?: string;
  to?: string;
  fresh?: "1";
}

/** GET /api/store/insights/cart — daily cart units row */
export interface InsightsCartDayRow {
  day: string;
  addUnits: number;
  removeUnits: number;
}

/** GET /api/store/insights/cart — top added product row */
export interface InsightsCartTopAddedRow {
  productId: string;
  title: string;
  imageUrl: string | null;
  addUnits: number;
  addEvents: number;
}

/** GET /api/store/insights/cart — historical cart activity for the window */
export interface InsightsCartPeriod {
  addEvents: number;
  addEventsPrev: number;
  addUnits: number;
  addUnitsPrev: number;
  removeEvents: number;
  removeEventsPrev: number;
  removeUnits: number;
  removeUnitsPrev: number;
  byDay: InsightsCartDayRow[];
  topAdded: InsightsCartTopAddedRow[];
}

/** GET /api/store/insights/cart — live cart snapshot by-product row */
export interface InsightsCartProductRow {
  productId: string;
  title: string;
  slug: string;
  imageUrl: string | null;
  units: number;
  carts: number;
}

/** GET /api/store/insights/cart — current live cart snapshot */
export interface InsightsCartCurrent {
  sampledAt: string;
  activeCarts: number;
  totalUnits: number;
  totalLines: number;
  ineligibleUnits: number;
  byProduct: InsightsCartProductRow[];
  eligibilityNote: string;
}

/** GET /api/store/insights/cart — cart activity + snapshot payload */
export interface CartInsightsData {
  window: InsightsWindow;
  generatedAt: string;
  freshness: { eventsUpTo: string | null; trackingSince: string | null };
  period: InsightsCartPeriod;
  current: InsightsCartCurrent;
}

/** GET /api/store/insights/cart — cart activity + snapshot */
export type CartInsightsResponse = ApiOk<CartInsightsData>;

/** GET /api/store/insights/campaigns — attribution report query */
export interface InsightsCampaignsQuery {
  window?: "today" | "7d" | "30d" | "custom";
  from?: string;
  to?: string;
  fresh?: "1";
}

/** GET /api/store/insights/campaigns — campaign attribution row */
export interface InsightsCampaignRow {
  campaignId: string;
  name: string;
  slug: string;
  code: string;
  status: string;
  defaultSource: string | null;
  defaultMedium: string | null;
  createdAt: string;
  visits: number;
  visitSessions: number;
  productViews: number;
  addUnits: number;
  attributedOrders: number;
  paidOrders: number;
  paidOrdersPrev: number;
  grossSalesMinor: number;
  grossProductSalesMinor: number;
  aovMinor: number | null;
  conversionPct: number | null;
  firstEventAt: string | null;
}

/** GET /api/store/insights/campaigns — raw UTM attribution row */
export interface InsightsUtmRow {
  source: string;
  medium: string | null;
  campaign: string | null;
  visits: number;
  visitSessions: number;
  productViews: number;
  addUnits: number;
  attributedOrders: number;
  paidOrders: number;
  grossSalesMinor: number;
}

/** GET /api/store/insights/campaigns — campaign attribution payload */
export interface InsightsCampaignsData {
  window: InsightsWindow;
  generatedAt: string;
  rows: InsightsCampaignRow[];
  utmRows: InsightsUtmRow[];
  totals: {
    campaigns: number;
    attributedVisits: number;
    attributedPaidOrders: number;
    attributedGrossSalesMinor: number;
    unclaimedPaidOrders: number;
    unclaimedGrossSalesMinor: number;
  };
  notes: string[];
}

/** GET /api/store/insights/campaigns — campaign attribution */
export type InsightsCampaignsResponse = ApiOk<InsightsCampaignsData>;

/** GET /api/store/insights/overview — overview report query */
export interface InsightsOverviewQuery {
  window?: "today" | "7d" | "30d" | "custom";
  from?: string;
  to?: string;
  fresh?: "1";
}

/** GET /api/store/insights/overview — traffic block */
export interface InsightsOverviewTraffic {
  storeViews: number;
  storeViewsPrev: number;
  sessions: number;
  sessionsPrev: number;
  uniqueVisitors: number;
  uniqueVisitorsPrev: number;
  productViews: number;
  productViewsPrev: number;
  byDay: { day: string; storeViews: number; productViews: number }[];
  channels: InsightsChannelRow[];
  topViewedProducts: { productId: string; title: string; slug: string; imageUrl: string | null; views: number }[];
  truncated: boolean;
}

/** GET /api/store/insights/overview — funnel block */
export interface InsightsOverviewFunnel {
  stages: InsightsFunnelStageRow[];
  paymentAttempts: number;
  paymentAttemptsPrev: number;
  basis: string[];
}

/** GET /api/store/insights/overview — summary cards block */
export interface InsightsOverviewSummary {
  orders: number;
  ordersPrev: number;
  unitsSold: number;
  unitsSoldPrev: number;
  grossSalesMinor: number;
  grossSalesMinorPrev: number;
  grossProductSalesMinor: number;
  netProductSalesMinor: number;
  refundsMinor: number;
  refundsMinorPrev: number;
  refundCount: number;
  aovMinor: number | null;
  aovMinorPrev: number | null;
  cartAddUnits: number;
  cartAddUnitsPrev: number;
  activeCartsNow: number;
  unitsInCartsNow: number;
  visitToPurchaseRate: number | null;
}

/** GET /api/store/insights/overview — store overview payload */
export interface InsightsOverviewData {
  window: InsightsWindow;
  generatedAt: string;
  freshness: InsightsFreshness;
  traffic: InsightsOverviewTraffic;
  funnel: InsightsOverviewFunnel;
  summary: InsightsOverviewSummary;
  observations: { kind: string; text: string }[];
}

/** GET /api/store/insights/overview — store overview */
export type InsightsOverviewResponse = ApiOk<InsightsOverviewData>;

// GET /api/store/insights/export — non-envelope: text/csv; charset=utf-8 attachment body (header block + type-specific report rows, money in RM)
// ============================================================
// §13 Seller Backend — Monetization
// §14 Seller Backend — Store Configuration & Operations
// ============================================================

// ------------------------------------------------------------
// §13 Seller Backend — Monetization
// ------------------------------------------------------------

/** GET /api/store/affiliate — affiliate programme state (platform settings, store opt-in, rates, enrollment counts) */
export interface AffiliateProgrammeData {
  programmeEnabled: boolean;
  maxRateBps: number;
  optIn: boolean;
  defaultRateBps: number;
  enrolledProducts: number;
  totalProducts: number;
}
/** GET /api/store/affiliate — affiliate programme state */
export type AffiliateProgrammeResponse = ApiOk<AffiliateProgrammeData>;

/** PATCH /api/store/affiliate — update store affiliate opt-in and default commission rate */
export interface AffiliateSettingsBody {
  optIn?: boolean;
  defaultRateBps?: number;
}
/** PATCH /api/store/affiliate — affiliate settings saved */
export interface AffiliateSettingsData {
  optIn: boolean;
  defaultRateBps: number;
  maxRateBps: number;
}
/** PATCH /api/store/affiliate — affiliate settings response */
export type AffiliateSettingsResponse = ApiOk<AffiliateSettingsData>;

/** GET /api/store/affiliate/products — query params (enrolled filter, title search, page/size clamped 6–60) */
export interface AffiliateProductsQuery {
  enrolled?: "true" | "false";
  q?: string;
  page?: number;
  size?: number;
}
/** GET /api/store/affiliate/products — one product with affiliate enrollment state and effective rate */
export interface AffiliateProductRow {
  id: string;
  title: string;
  slug: string;
  status: string;
  priceMinor: number;
  affiliateEnabled: boolean;
  effectiveRateBps: number;
  rateSource: "product" | "store_default";
  salesCount: number;
  image: string | null;
}
/** GET /api/store/affiliate/products — inline pagination (total/page inside data, no meta — blueprint deviation) */
export interface AffiliateProductsData {
  total: number;
  page: number;
  maxRateBps: number;
  storeOptIn: boolean;
  storeDefaultRateBps: number;
  products: AffiliateProductRow[];
}
/** GET /api/store/affiliate/products — affiliate product list (inline pagination, no meta) */
export type AffiliateProductsResponse = ApiOk<AffiliateProductsData>;

/** PATCH /api/store/affiliate/products/[id] — enroll/pause one product and set per-product rate override */
export interface AffiliateProductBody {
  enabled?: boolean;
  rateBps?: number | null;
}
/** PATCH /api/store/affiliate/products/[id] — product affiliate enrollment saved */
export interface AffiliateProductData {
  id: string;
  affiliateEnabled: boolean;
  affiliateRateBps: number | null;
  effectiveRateBps: number;
}
/** PATCH /api/store/affiliate/products/[id] — affiliate product response */
export type AffiliateProductResponse = ApiOk<AffiliateProductData>;

/** GET /api/store/affiliate/report — query params (window days, default 30, clamped 1–180) */
export interface AffiliateReportQuery {
  days?: number;
}
/** GET /api/store/affiliate/report — one recent commission allocation row */
export interface AffiliateRecentCommissionRow {
  orderNumber: string;
  createdAt: string;
  status: string;
  baseMinor: number;
  rateBps: number;
  poolMinor: number;
  directMinor: number;
  sponsorMinor: number;
  reversedMinor: number;
}
/** GET /api/store/affiliate/report — seller-scoped affiliate performance report payload */
export interface AffiliateReportData {
  enrolledCount: number;
  totalProducts: number;
  clicks: number;
  productViews: number;
  attributedOrders: number;
  eligibleSalesMinor: number;
  totalPoolMinor: number;
  directAllocationMinor: number;
  sponsorAllocationMinor: number;
  reversalMinor: number;
  currentLiabilityMinor: number;
  days: number;
  recentCommissions: AffiliateRecentCommissionRow[];
}
/** GET /api/store/affiliate/report — affiliate performance report */
export type AffiliateReportResponse = ApiOk<AffiliateReportData>;

/** GET /api/store/payouts · POST /api/store/payouts · GET /api/store/wallet — raw seller payout row (shape shared 3×, deduped) */
export interface SellerPayoutRow {
  id: string;
  batchId: string | null;
  sellerId: string;
  walletId: string;
  referenceNo: string;
  amountMinor: number;
  status: string;
  method: string;
  bankAccountId: string | null;
  providerRef: string | null;
  statementJson: string;
  failReason: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}
/** GET /api/store/payouts — payout row plus parsed batch info and statement */
export interface SellerPayoutWithStatement extends SellerPayoutRow {
  batch: { id: string; runType: string; status: string } | null;
  statement: {
    sellerName: string;
    periodFrom: string;
    periodTo: string;
    orderCount?: number;
    reconciled?: true;
    generatedAt?: string;
    lines: { label: string; amountMinor: number }[];
  };
}
/** GET /api/store/payouts — latest 50 payouts (list via ok() without meta — blueprint deviation) */
export type SellerPayoutsListResponse = ApiOk<SellerPayoutWithStatement[]>;

/** POST /api/store/payouts — create seller-initiated payout request (amount = major MYR units × 100) */
export interface SellerPayoutRequestBody {
  amountMinor?: number;
  amount?: number | string;
}
/** POST /api/store/payouts — payout request created payload */
export interface SellerPayoutRequestData {
  payout: SellerPayoutRow;
  message: string;
  storeName: string;
}
/** POST /api/store/payouts — payout request response */
export type SellerPayoutRequestResponse = ApiOk<SellerPayoutRequestData>;

/** GET /api/store/wallet · GET /api/store/me — ledger-truth wallet row (shape shared 2×, deduped) */
export interface SellerWallet {
  id: string;
  sellerId: string;
  currency: string;
  pendingMinor: number;
  availableMinor: number;
  reservedMinor: number;
  lifetimeEarnedMinor: number;
  lifetimeCommissionMinor: number;
  createdAt: string;
  updatedAt: string;
}
/** GET /api/store/wallet — one recent wallet ledger line with embedded txn summary */
export interface SellerWalletLine {
  id: string;
  txnId: string;
  accountCode: string;
  direction: string;
  amountMinor: number;
  currency: string;
  walletId: string | null;
  availableAt: string | null;
  memo: string | null;
  refType: string | null;
  refId: string | null;
  createdAt: string;
  txn: { id: string; txnType: string; description: string | null; occurredAt: string };
}
/** GET /api/store/wallet — wallet overview payload (balances, recent lines, payouts, open request) */
export interface SellerWalletData {
  wallet: SellerWallet;
  recentLines: SellerWalletLine[];
  payouts: SellerPayoutRow[];
  minPayoutMinor: number;
  openRequest: { id: string; referenceNo: string; amountMinor: number; createdAt: string } | null;
}
/** GET /api/store/wallet — wallet overview */
export type SellerWalletResponse = ApiOk<SellerWalletData>;

/** GET /api/store/wallet/activity/[id] — ledger line detail: line, txn, related object, double-entry journal */
export interface SellerWalletActivityData {
  line: { id: string; accountCode: string; direction: string; amountMinor: number; availableAt: string | null; memo: string | null; createdAt: string };
  txn: { id: string; txnType: string; refType: string | null; refId: string | null; description: string | null; occurredAt: string };
  walletAmountMinor: number;
  related:
    | { kind: "order"; orderId: string; orderNumber: string; status: string; totalMinor: number; placedAt: string; paidAt: string | null; itemCount: number }
    | { kind: "payout"; payoutId: string; referenceNo: string; status: string; method: string; amountMinor: number; paidAt: string | null }
    | { kind: "settlement"; reference: string | null }
    | { kind: "wallet_adjustment"; reference: string | null }
    | null;
  journal: { id: string; accountCode: string; direction: string; amountMinor: number; availableAt: string | null; memo: string | null; isMine: boolean }[];
}
/** GET /api/store/wallet/activity/[id] — wallet activity detail */
export type SellerWalletActivityResponse = ApiOk<SellerWalletActivityData>;

/** GET /api/store/bank-accounts · POST /api/store/bank-accounts — masked bank account projection (never ciphertext) */
export interface BankAccountPublic {
  id: string;
  holderName: string;
  bankName: string;
  accountNumberMasked: string;
  verified: boolean;
  createdAt: string;
}
/** GET /api/store/bank-accounts — unbounded list via ok() without meta (blueprint deviation) */
export type BankAccountsListResponse = ApiOk<BankAccountPublic[]>;

/** POST /api/store/bank-accounts — add payout bank account (full number AES-256-GCM sealed) */
export interface BankAccountBody {
  holderName: string;
  bankName: string;
  accountNumber: string;
}
/** POST /api/store/bank-accounts — bank account created (success status 201) */
export type BankAccountCreatedResponse = ApiOk<BankAccountPublic>;

// ------------------------------------------------------------
// §14 Seller Backend — Store Configuration & Operations
// ------------------------------------------------------------

/** PATCH /api/store/settings — whitelist-patch store profile, storefront toggles, socials, URLs */
export interface SellerSettingsBody {
  name?: string;
  tagline?: string | null;
  description?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  whatsapp?: string | null;
  logoUrl?: string | null;
  bannerUrl?: string | null;
  social?: Record<string, string> | string;
  cardShowStars?: boolean;
  cardMetric?: "views" | "sold";
  homeShowFeatured?: boolean;
  homeShowFresh?: boolean;
  homeFeaturedFirst?: boolean;
  marketplaceOptIn?: boolean;
}
/** PATCH /api/store/settings — store settings saved payload */
export interface SellerSettingsData {
  id: string;
  name: string;
  tagline: string | null;
  updated: string[];
  marketplaceOptIn?: boolean;
}
/** PATCH /api/store/settings — store settings response */
export type SellerSettingsResponse = ApiOk<SellerSettingsData>;

/** GET /api/store/terms — effective commission %, fees, clearing hold, payout minimum, moderation window */
export interface TermsData {
  commissionPercent: number;
  commissionSource: "seller_override" | "global_default";
  fixedFeeMinor: number;
  hasFixedFee: boolean;
  minCommissionMinor: number;
  hasMinCommission: boolean;
  holdDays: number;
  holdSource: "seller_override" | "global_default";
  payoutMinMinor: number;
  moderationFirstN: number;
}
/** GET /api/store/terms — seller effective platform terms */
export type TermsResponse = ApiOk<TermsData>;

/** GET /api/store/theme · PUT /api/store/theme — store theme tokens payload (shared by both methods) */
export interface ThemeData {
  theme: {
    primaryColor: string;
    accentColor: string;
    fontHeading: string;
    fontBody: string;
    radius: "none" | "sm" | "md" | "lg" | "full";
    buttonStyle: "solid" | "outline" | "pill";
  };
}
/** GET /api/store/theme · PUT /api/store/theme — store theme tokens (identical shape on both, deduped) */
export type ThemeResponse = ApiOk<ThemeData>;

/** PUT /api/store/theme — merge submitted tokens over existing theme */
export interface ThemeBody {
  theme: Record<string, unknown>;
}

/** GET /api/store/seo — store-level SEO defaults plus up to 100 products with effective SEO fields */
export interface SeoData {
  store: { seoTitle: string; seoDescription: string; ogImage: string | null; canonicalUrl: string | null; noindex: boolean; lockedFields: string[]; warnings: string[] };
  products: { id: string; title: string; slug: string; status: string; image: string | null; seoTitle: string; seoDescription: string; ogImage: string | null; noindex: boolean; lockedFields: string[]; warnings: string[] }[];
}
/** GET /api/store/seo — store and product SEO */
export type SeoResponse = ApiOk<SeoData>;

/** PATCH /api/store/seo — upsert store or product SEO meta with lock management */
export interface SeoBody {
  target?: "store" | "product";
  productId?: string;
  seoTitle?: string;
  seoDescription?: string;
  ogImage?: string | null;
  canonicalUrl?: string | null;
  noindex?: boolean;
  lock?: string[];
  unlock?: string[];
}
/** PATCH /api/store/seo — SEO meta saved payload */
export interface SeoSaveData {
  id: string;
  seoTitle: string | null;
  seoDescription: string | null;
  ogImage: string | null;
  noindex: boolean;
  lockedFields: string[];
  warnings: string[];
}
/** PATCH /api/store/seo — SEO save response */
export type SeoSaveResponse = ApiOk<SeoSaveData>;

/** GET /api/store/card-style — product-card typography tokens plus curated font catalogue */
export interface CardStyleData {
  style: { nameFont: string; nameSize: string; nameAlign: string; priceFont: string; priceSize: string; priceAlign: string } | null;
  fonts: { id: string; label: string; kind: string }[];
}
/** GET /api/store/card-style — card typography response */
export type CardStyleResponse = ApiOk<CardStyleData>;

/** PUT /api/store/card-style — upsert product-card typography (all six enum-validated fields) */
export interface CardStyleBody {
  nameFont: string;
  nameSize: "sm" | "md" | "lg";
  nameAlign: "left" | "center" | "right";
  priceFont: string;
  priceSize: "sm" | "md" | "lg";
  priceAlign: "left" | "center" | "right";
}
/** PUT /api/store/card-style — card typography saved payload */
export interface CardStyleSaveData {
  style: { nameFont: string; nameSize: string; nameAlign: string; priceFont: string; priceSize: string; priceAlign: string };
  fontLabels: { name: string; price: string };
}
/** PUT /api/store/card-style — card typography save response */
export type CardStyleSaveResponse = ApiOk<CardStyleSaveData>;

/** GET /api/store/me — seller console bootstrap: seller + store + wallet + onboarding + stats */
export interface SellerMeData {
  seller: { id: string; email: string; fullName: string; displayName: string; phone: string | null; status: string; kycStatus: string | null; riskTier: string | null; planCode: string | null; marketplaceOptIn: boolean; submittedAt: string | null; rejectReason: string | null; emailVerified: boolean; emailVerifiedAt: string | null };
  store: { id: string; name: string; slug: string; tagline: string | null; logoUrl: string | null; bannerUrl: string | null; description: string | null; status: string; supportEmail: string | null; supportPhone: string | null; whatsapp: string | null; marketplaceOptIn: boolean; theme: string; cardShowStars: boolean; cardMetric: string; homeShowFeatured: boolean; homeShowFresh: boolean; homeFeaturedFirst: boolean };
  wallet: SellerWallet | null;
  onboarding: { step: string; checklist: { profile: boolean; storeIdentity: boolean; kyc: boolean; bank: boolean; products: boolean } };
  stats: { ordersCount: number; productCount: number; revenue30dMinor: number };
}
/** GET /api/store/me — seller console bootstrap response */
export type SellerMeResponse = ApiOk<SellerMeData>;

/** POST /api/store/publish — take store live after approval and completeness gates */
export interface PublishData {
  status: string;
  publishedAt: string;
}
/** POST /api/store/publish — publish store response */
export type PublishResponse = ApiOk<PublishData>;

/** POST /api/store/onboarding — submit seller for KYC review */
export interface OnboardingBody {
  action: "submit";
}
/** POST /api/store/onboarding — KYC submission accepted payload */
export interface OnboardingData {
  status: string;
  submittedAt: string;
}
/** POST /api/store/onboarding — KYC submission response */
export type OnboardingResponse = ApiOk<OnboardingData>;

/** GET /api/store/dashboard — revenue card bucket (renamed from blueprint `Card` to avoid card-style collision) */
export interface SellerDashboardCard {
  orders: number;
  revenueMinor: number;
  commissionMinor: number;
  netMinor: number;
}
/** GET /api/store/dashboard — seller dashboard payload (cards, wallet snapshot, low stock, orders, actions) */
export interface SellerDashboardData {
  cards: { today: SellerDashboardCard; "7d": SellerDashboardCard; "30d": SellerDashboardCard };
  wallet: { availableMinor: number; pendingMinor: number };
  lowStock: { id: string; name: string; optionValue: string | null; sku: string | null; stock: number; lowStockThreshold: number; productId: string; productTitle: string }[];
  latestOrders: { id: string; orderNumber: string; customerName: string; status: string; totalMinor: number; itemCount: number; createdAt: string }[];
  pendingActions: { unfulfilledPaidOrders: number; openRefundRequests: number; productsPendingReview: number };
}
/** GET /api/store/dashboard — seller dashboard response */
export type SellerDashboardResponse = ApiOk<SellerDashboardData>;

/** GET /api/store/notifications — latest 30 in-app notifications plus 24h recent count */
export interface SellerNotificationsData {
  notifications: { id: string; subject: string; createdAt: string; event: string }[];
  recentCount: number;
}
/** GET /api/store/notifications — seller bell feed response */
export type SellerNotificationsResponse = ApiOk<SellerNotificationsData>;

/** GET /api/store/shipping/quote — query params (orderId required: order id or orderNumber) */
export interface SellerShippingQuoteQuery {
  orderId: string;
}
/** GET /api/store/shipping/quote — deterministic mock courier rates for a store order's ship dialog */
export interface SellerShippingQuoteData {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  shippedAt: string | null;
  shipment: { status: string; awbNumber: string | null; courierName: string | null; etaFrom: string | null; etaTo: string | null } | null;
  destination: { state: string; city: string; zone: "peninsular" | "east" };
  parcel: { weightGrams: number; itemCount: number };
  rates: { rateId: string; providerId: string; courierName: string; serviceLevel: string; priceMinor: number; etaFromDays: number; etaToDays: number }[];
}
/** GET /api/store/shipping/quote — courier rate quote response */
export type SellerShippingQuoteResponse = ApiOk<SellerShippingQuoteData>;

/** GET /api/store/cart-settings — cart drawer config, resolved manual upsell picks, free-shipping default */
export interface CartSettingsData {
  settings: { layout: string; showFreeShippingBar: boolean; freeShipThresholdMinor: number; upsellEnabled: boolean; upsellMode: string; upsellTitle: string; upsellLimit: number; urgencyStockEnabled: boolean; urgencyStockThreshold: number; urgencyViewersEnabled: boolean; urgencyViewersMin: number; urgencyViewersMax: number; urgencyCountdownEnabled: boolean; urgencyCountdownMinutes: number; showOrderNote: boolean; showDiscountHint: boolean; checkoutLabel: string; showContinueShopping: boolean; stickyCta: boolean; trustBadges: string[] } | null;
  upsellPicked: { id: string; title: string; priceMinor: number; status: string }[];
  freeShippingDefaultMinor: number;
}
/** GET /api/store/cart-settings — cart drawer config response */
export type CartSettingsResponse = ApiOk<CartSettingsData>;

/** PUT /api/store/cart-settings — upsert drawer config with coercion, clamps, upsell validation */
export interface CartSettingsBody {
  layout?: string;
  showFreeShippingBar?: boolean;
  freeShipThresholdMinor?: number;
  upsellEnabled?: boolean;
  upsellMode?: string;
  upsellProductIds?: string[];
  upsellTitle?: string;
  upsellLimit?: number;
  urgencyStockEnabled?: boolean;
  urgencyStockThreshold?: number;
  urgencyViewersEnabled?: boolean;
  urgencyViewersMin?: number;
  urgencyViewersMax?: number;
  urgencyCountdownEnabled?: boolean;
  urgencyCountdownMinutes?: number;
  trustBadges?: string[];
  showOrderNote?: boolean;
  showDiscountHint?: boolean;
  checkoutLabel?: string;
  showContinueShopping?: boolean;
  stickyCta?: boolean;
}
/** PUT /api/store/cart-settings — cart settings saved payload */
export interface CartSettingsSaveData {
  settings: { layout: string };
  savedAt: string;
}
/** PUT /api/store/cart-settings — cart settings save response */
export type CartSettingsSaveResponse = ApiOk<CartSettingsSaveData>;

/** GET /api/store/integrations — one tracking-integration row (list via ok() without meta — blueprint deviation) */
export interface SellerIntegrationRow {
  provider: string;
  config: Record<string, unknown>;
  isEnabled: boolean;
  updatedAt: string | null;
}
/** GET /api/store/integrations — all four supported providers (list via ok() without meta) */
export type IntegrationsResponse = ApiOk<SellerIntegrationRow[]>;

/** PUT /api/store/integrations — upsert one provider's config JSON and enabled flag */
export interface IntegrationBody {
  provider: "meta_pixel" | "ga4" | "tiktok_pixel" | "gtm";
  config?: Record<string, unknown> | string;
  isEnabled?: boolean;
}
/** PUT /api/store/integrations — integration saved payload */
export interface IntegrationSaveData {
  provider: string;
  config: Record<string, unknown>;
  isEnabled: boolean;
}
/** PUT /api/store/integrations — integration save response */
export type IntegrationSaveResponse = ApiOk<IntegrationSaveData>;

/** GET /api/store/domains · POST /api/store/domains — custom domain row (shape shared 2×, deduped) */
export interface SellerDomainRow {
  id: string;
  storeId: string;
  domain: string;
  mode: string;
  status: string;
  sslStatus: string;
  isPrimary: boolean;
  lastCheckedAt: string | null;
  errorReason: string | null;
  createdAt: string;
  updatedAt: string;
}
/** GET /api/store/domains — store's custom domains, newest first (list via ok() without meta — blueprint deviation) */
export type SellerDomainsResponse = ApiOk<SellerDomainRow[]>;

/** POST /api/store/domains — connect a hostname via cname or ns mode (success status 201) */
export interface SellerDomainBody {
  domain: string;
  mode: "cname" | "ns";
}
/** POST /api/store/domains — custom domain created */
export type SellerDomainResponse = ApiOk<SellerDomainRow>;

/** DELETE /api/store/domains/[id] — delete one of the store's custom domains */
export interface SellerDomainDeleteData {
  id: string;
  deleted: boolean;
}
/** DELETE /api/store/domains/[id] — custom domain delete response */
export type SellerDomainDeleteResponse = ApiOk<SellerDomainDeleteData>;

/** POST /api/store/domains/[id]/verify — sandbox DNS verify payload (note: lastCheckedAt non-null here) */
export interface SellerDomainVerifiedData {
  id: string;
  storeId: string;
  domain: string;
  mode: string;
  status: string;
  sslStatus: string;
  isPrimary: boolean;
  lastCheckedAt: string;
  errorReason: string | null;
  createdAt: string;
  updatedAt: string;
}
/** POST /api/store/domains/[id]/verify — custom domain verify response */
export type SellerDomainVerifyResponse = ApiOk<SellerDomainVerifiedData>;

/** GET /api/store/webhooks — one webhook delivery record (renamed from blueprint `Delivery`) */
export interface SellerWebhookDelivery {
  id: string;
  endpointId: string;
  event: string;
  payloadJson: string;
  status: string;
  attempts: number;
  responseCode: number | null;
  lastAttemptAt: string | null;
  createdAt: string;
}
/** GET /api/store/webhooks — webhook endpoint with masked secret and last 10 deliveries */
export interface SellerWebhookEndpoint {
  id: string;
  url: string;
  secretMasked: string;
  events: string[];
  isActive: boolean;
  createdAt: string;
  deliveries: SellerWebhookDelivery[];
}
/** GET /api/store/webhooks — endpoints with masked secrets (list via ok() without meta — blueprint deviation) */
export type SellerWebhooksResponse = ApiOk<SellerWebhookEndpoint[]>;

/** POST /api/store/webhooks — create endpoint with generated signing secret (success status 201) */
export interface SellerWebhookBody {
  url: string;
  events?: string[];
}
/** POST /api/store/webhooks — endpoint created; plaintext secret revealed exactly once */
export interface SellerWebhookCreateData {
  id: string;
  url: string;
  secret: string;
  events: string[];
  isActive: boolean;
  deliveries: never[];
}
/** POST /api/store/webhooks — webhook create response */
export type SellerWebhookCreateResponse = ApiOk<SellerWebhookCreateData>;

/** PATCH /api/store/webhooks/[id] — partially update url/events/isActive (secret stays masked) */
export interface SellerWebhookPatchBody {
  url?: string;
  events?: string[];
  isActive?: boolean;
}
/** PATCH /api/store/webhooks/[id] — webhook endpoint updated payload */
export interface SellerWebhookPatchData {
  id: string;
  url: string;
  secretMasked: string;
  events: string[];
  isActive: boolean;
}
/** PATCH /api/store/webhooks/[id] — webhook patch response */
export type SellerWebhookPatchResponse = ApiOk<SellerWebhookPatchData>;

/** DELETE /api/store/webhooks/[id] — delete one of the store's webhook endpoints */
export interface SellerWebhookDeleteData {
  id: string;
  deleted: boolean;
}
/** DELETE /api/store/webhooks/[id] — webhook delete response */
export type SellerWebhookDeleteResponse = ApiOk<SellerWebhookDeleteData>;

/** POST /api/store/webhooks/[id]/rotate — replace signing secret (new plaintext returned exactly once) */
export interface SellerWebhookRotateData {
  id: string;
  secret: string;
}
/** POST /api/store/webhooks/[id]/rotate — webhook secret rotate response */
export type SellerWebhookRotateResponse = ApiOk<SellerWebhookRotateData>;

/** GET /api/store/connections — store-scoped marketplace connections (never tokens) plus per-platform env status */
export interface ConnectionsData {
  connections: { id: string; platform: string; status: string; envConfigured: boolean; shopId: string | null; shopName: string | null; region: string | null; expiresAt: string | null; lastRefreshAt: string | null; lastError: string | null; createdAt: string }[];
  env: { shopee: boolean; tiktok: boolean };
}
/** GET /api/store/connections — marketplace connections response */
export type ConnectionsResponse = ApiOk<ConnectionsData>;

/** GET /api/store/connections/[platform]/begin — start marketplace OAuth flow */
export interface SellerConnectionBeginData {
  authorizeUrl: string | null;
  state: string;
  envConfigured: boolean;
}
/** GET /api/store/connections/[platform]/begin — OAuth begin response */
export type SellerConnectionBeginResponse = ApiOk<SellerConnectionBeginData>;

/** DELETE /api/store/connections/disconnect — query params (platform required) */
export interface SellerDisconnectQuery {
  platform: "shopee" | "tiktok" | "fixture";
}
/** DELETE /api/store/connections/disconnect — soft-disconnect marketplace connections payload */
export interface DisconnectData {
  disconnected: number;
}
/** DELETE /api/store/connections/disconnect — disconnect response */
export type DisconnectResponse = ApiOk<DisconnectData>;
// ============================================================
// §15 Admin — Sellers, KYC & Marketplace Moderation
// §16 Admin — Finance
// ============================================================
// Source: docs/API-CONTRACT-BLUEPRINT.md, §15 + §16 (lines 3249–4046).
// Envelope helpers ApiOk / ApiPage / ApiPageMeta / ApiErr are defined in the
// assembled contract file and are only referenced here.
//
// Domain prefix "Admin" applied to shared row/composite types whose base
// names collide with other domains (Seller / Store / Wallet / Order /
// Product / Review / Refund / Dispute / Payout / Ledger / Bank).

// ------------------------------------------------------------
// §15 — shared row shapes (preamble)
// ------------------------------------------------------------

/** §15 shared row — sellers table row */
export interface AdminSellerRow {
  id: string;
  email: string;
  fullName: string;
  displayName: string;
  countryCode: string;
  phone: string | null;
  status: string;
  riskTier: string;
  commissionOverridePercent: number | null;
  holdDaysOverride: number | null;
  kycStatus: string;
  planCode: string;
  marketplaceOptIn: boolean;
  rejectReason: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** §15 shared row — stores table row */
export interface AdminStoreRow {
  id: string;
  sellerId: string | null;
  name: string;
  slug: string;
  tagline: string | null;
  logoUrl: string | null;
  bannerUrl: string | null;
  description: string | null;
  status: string;
  lifecycleSource: string;
  currency: string;
  timezone: string;
  themeJson: string;
  supportEmail: string | null;
  supportPhone: string | null;
  whatsapp: string | null;
  socialJson: string;
  templateKey: string;
  cardShowStars: boolean;
  cardMetric: string;
  homeShowFeatured: boolean;
  homeShowFresh: boolean;
  homeFeaturedFirst: boolean;
  fsPriceAdjustMinor: number;
  affiliateOptIn: boolean;
  affiliateDefaultRateBps: number;
  createdAt: string;
  updatedAt: string;
}

/** §15 shared row — seller wallet row */
export interface AdminWalletRow {
  id: string;
  sellerId: string;
  currency: string;
  pendingMinor: number;
  availableMinor: number;
  reservedMinor: number;
  lifetimeEarnedMinor: number;
  lifetimeCommissionMinor: number;
  createdAt: string;
  updatedAt: string;
}

/** §15 shared row — KYC document row */
export interface AdminKycDocRow {
  id: string;
  sellerId: string;
  docType: string;
  fileName: string;
  status: string;
  rejectReason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

/** §15 shared row — internal admin note on a seller */
export interface AdminSellerNoteRow {
  id: string;
  sellerId: string;
  author: string;
  body: string;
  createdAt: string;
}

// ------------------------------------------------------------
// §15 — GET /api/admin/sellers — seller directory
// ------------------------------------------------------------

/** GET /api/admin/sellers — query params (status "all"/absent = no filter) */
export interface AdminSellersQuery {
  status?: string;
  riskTier?: string;
  search?: string;
  page?: number;
  size?: number;
}

/** GET /api/admin/sellers — 200 payload element (seller + store GMV stats + wallet) */
export interface AdminSellersData extends AdminSellerRow {
  store: (AdminStoreRow & { gmv30dMinor: number; orders30d: number }) | null;
  wallet: AdminWalletRow | null;
}

/** GET /api/admin/sellers — 200 paged response */
export type AdminSellersResponse = ApiPage<AdminSellersData>;

// ------------------------------------------------------------
// §15 — GET /api/admin/sellers/[id] — seller dossier
// ------------------------------------------------------------

/** GET /api/admin/sellers/[id] — 200 payload (full seller dossier) */
export interface AdminSellerDetailData {
  seller: AdminSellerDetail;
  store: AdminStoreRow | null;
  kycDocuments: AdminKycDocRow[];
  bankAccounts: AdminBankAcctRow[];
  wallet: AdminWalletRow | null;
  products: (AdminProductRow & { images: AdminProductImageRow[]; category: AdminCategoryRow | null })[];
  orders: AdminOrderRow[];
  notes: AdminSellerNoteRow[];
  gmv30dMinor: number;
  orders30d: number;
  productCount: number;
}

/** GET /api/admin/sellers/[id] — 200 response envelope */
export type AdminSellerDetailResponse = ApiOk<AdminSellerDetailData>;

/** GET /api/admin/sellers/[id] — referenced row: enriched seller detail */
export interface AdminSellerDetail extends AdminSellerRow {
  emailVerifiedAt: string | null;
  store: AdminStoreRow | null;
  wallet: AdminWalletRow | null;
  kycDocuments: AdminKycDocRow[];
  bankAccounts: AdminBankAcctRow[];
  sellerNotes: AdminSellerNoteRow[];
}

/** GET /api/admin/sellers/[id] — referenced row: masked bank account */
export interface AdminBankAcctRow {
  id: string;
  holderName: string;
  bankName: string;
  accountNumberMasked: string;
  verified: boolean;
  verifiedAt: string | null;
  createdAt: string;
}

/** GET /api/admin/sellers/[id] — referenced row: products table row */
export interface AdminProductRow {
  id: string;
  storeId: string;
  categoryId: string | null;
  storeCategoryId: string | null;
  title: string;
  slug: string;
  description: string | null;
  status: string;
  rejectReason: string | null;
  priceMinor: number;
  commissionPercentOverride: number | null;
  flagsJson: string;
  reportsCount: number;
  salesCount: number;
  viewCount: number;
  ratingAvg: number;
  ratingCount: number;
  isFeatured: boolean;
  publishedAt: string | null;
  sourcePlatform: string | null;
  sourceShopId: string | null;
  sourceProductId: string | null;
  sourceUrl: string | null;
  sourceBrand: string | null;
  sourceStatus: string | null;
  isFixture: boolean;
  lastSyncedAt: string | null;
  overridesJson: string;
  affiliateEnabled: boolean;
  affiliateRateBps: number | null;
  seoTitle: string | null;
  seoDescription: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/admin/sellers/[id] — referenced row: product image */
export interface AdminProductImageRow {
  id: string;
  productId: string;
  url: string;
  sortOrder: number;
  alt: string | null;
}

/** GET /api/admin/sellers/[id] — referenced row: category */
export interface AdminCategoryRow {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  commissionPercent: number | null;
  imageUrl: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/admin/sellers/[id] — referenced row: orders table row */
export interface AdminOrderRow {
  id: string;
  storeId: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  cartToken: string | null;
  shopperId: string | null;
  status: string;
  disputedFlag: boolean;
  channel: string;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  couponCode: string | null;
  shippingAddressJson: string;
  customerNote: string | null;
  paymentProvider: string | null;
  idemKey: string | null;
  paidAt: string | null;
  fulfilledAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  receivedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  trackingNumber: string | null;
  trackingProvider: string | null;
  riskFlagsJson: string;
  voucherId: string | null;
  shippingCountryCode: string;
  shippingCountrySource: string;
  attrCampaignId: string | null;
  attrSource: string | null;
  attrMedium: string | null;
  attrCampaign: string | null;
  attrTerm: string | null;
  attrContent: string | null;
  createdAt: string;
  updatedAt: string;
  paymentGroupId: string | null;
}

// ------------------------------------------------------------
// §15 — PATCH /api/admin/sellers/[id] — update seller policy
// ------------------------------------------------------------

/** PATCH /api/admin/sellers/[id] — request body (risk tier / commission / hold / opt-in) */
export interface AdminSellerPatchBody {
  riskTier?: "low" | "medium" | "high";
  commissionOverridePercent?: number | null;
  holdDaysOverride?: number | null;
  marketplaceOptIn?: boolean;
}

/** PATCH /api/admin/sellers/[id] — 200 response envelope */
export type AdminSellerPatchResponse = ApiOk<AdminSellerRow>;

// ------------------------------------------------------------
// §15 — GET /api/admin/sellers/[id]/notes — seller notes list
// ------------------------------------------------------------

/** GET /api/admin/sellers/[id]/notes — 200 response envelope (unpaged list, no meta) */
export type AdminSellerNotesResponse = ApiOk<AdminSellerNoteRow[]>;

// ------------------------------------------------------------
// §15 — POST /api/admin/sellers/[id]/notes — add seller note
// ------------------------------------------------------------

/** POST /api/admin/sellers/[id]/notes — request body */
export interface AdminSellerNoteBody {
  body: string;
}

/** POST /api/admin/sellers/[id]/notes — 200 response envelope */
export type AdminSellerNoteResponse = ApiOk<AdminSellerNoteRow>;

// ------------------------------------------------------------
// §15 — POST /api/admin/sellers/[id]/suspend — suspend seller
// ------------------------------------------------------------

/** POST /api/admin/sellers/[id]/suspend — request body (reason optional) */
export interface AdminSellerSuspendBody {
  reason?: string;
}

/** POST /api/admin/sellers/[id]/suspend — referenced row: seller with email verification */
export interface AdminSellerFullRow extends AdminSellerRow {
  emailVerifiedAt: string | null;
}

/** POST /api/admin/sellers/[id]/suspend — 200 payload (seller + revoked session count) */
export interface AdminSellerSuspendData extends AdminSellerFullRow {
  sessionsRevoked: number;
}

/** POST /api/admin/sellers/[id]/suspend — 200 response envelope */
export type AdminSellerSuspendResponse = ApiOk<AdminSellerSuspendData>;

// ------------------------------------------------------------
// §15 — POST /api/admin/sellers/[id]/approve — approve seller
// ------------------------------------------------------------

/** POST /api/admin/sellers/[id]/approve — 200 response envelope */
export type AdminSellerApproveResponse = ApiOk<AdminSellerFullRow>;

// ------------------------------------------------------------
// §15 — POST /api/admin/sellers/[id]/activate — reactivate seller
// ------------------------------------------------------------

/** POST /api/admin/sellers/[id]/activate — 200 response envelope */
export type AdminSellerActivateResponse = ApiOk<AdminSellerFullRow>;

// ------------------------------------------------------------
// §15 — POST /api/admin/sellers/[id]/reject — reject seller
// ------------------------------------------------------------

/** POST /api/admin/sellers/[id]/reject — request body (reason required) */
export interface AdminSellerRejectBody {
  reason: string;
}

/** POST /api/admin/sellers/[id]/reject — 200 payload (seller + revoked session count) */
export interface AdminSellerRejectData extends AdminSellerFullRow {
  sessionsRevoked: number;
}

/** POST /api/admin/sellers/[id]/reject — 200 response envelope */
export type AdminSellerRejectResponse = ApiOk<AdminSellerRejectData>;

// ------------------------------------------------------------
// §15 — POST /api/admin/sellers/[id]/terminate — terminate seller
// ------------------------------------------------------------

/** POST /api/admin/sellers/[id]/terminate — request body (reason optional) */
export interface AdminSellerTerminateBody {
  reason?: string;
}

/** POST /api/admin/sellers/[id]/terminate — 200 payload (seller + revoked session count) */
export interface AdminSellerTerminateData extends AdminSellerFullRow {
  sessionsRevoked: number;
}

/** POST /api/admin/sellers/[id]/terminate — 200 response envelope */
export type AdminSellerTerminateResponse = ApiOk<AdminSellerTerminateData>;

// ------------------------------------------------------------
// §15 — POST /api/admin/sellers/[id]/kyc/[docId] — review KYC document
// ------------------------------------------------------------

/** POST /api/admin/sellers/[id]/kyc/[docId] — request body (approve/reject decision) */
export interface KycDecisionBody {
  decision: "approved" | "rejected";
  reason?: string;
}

/** POST /api/admin/sellers/[id]/kyc/[docId] — 200 payload (doc + seller KYC status) */
export interface KycDecisionData {
  doc: AdminKycDocRow;
  sellerKycStatus: string | null;
}

/** POST /api/admin/sellers/[id]/kyc/[docId] — 200 response envelope */
export type KycDecisionResponse = ApiOk<KycDecisionData>;

// ------------------------------------------------------------
// §15 — GET /api/admin/stores — store overview
// ------------------------------------------------------------

/** GET /api/admin/stores — query params (search matches name/slug/seller email) */
export interface AdminStoresQuery {
  search?: string;
}

/** GET /api/admin/stores — 200 payload element (store + seller summary + counts) */
export interface AdminStoresData {
  id: string;
  name: string;
  slug: string;
  status: string;
  tagline: string | null;
  createdAt: string;
  seller: {
    id: string;
    email: string;
    fullName: string;
    displayName: string;
    status: string;
    riskTier: string;
  } | null;
  productCount: number;
  orderCount: number;
  pageCount: number;
  gmv30dMinor: number;
}

/** GET /api/admin/stores — 200 response envelope (unpaged list, no meta) */
export type AdminStoresResponse = ApiOk<AdminStoresData[]>;

// ------------------------------------------------------------
// §15 — GET /api/admin/kyc-queue — KYC review queue
// ------------------------------------------------------------

/** GET /api/admin/kyc-queue — 200 payload element (pending-review seller with docs/banks/wallet) */
export interface KycQueueData {
  id: string;
  email: string;
  fullName: string;
  displayName: string;
  phone: string | null;
  status: string;
  kycStatus: string;
  riskTier: string;
  submittedAt: string | null;
  createdAt: string;
  store: {
    id: string;
    name: string;
    slug: string;
    productCount: number;
  } | null;
  docs: AdminKycDocRow[];
  docsApproved: number;
  docsTotal: number;
  banks: {
    id: string;
    bankName: string;
    holderName: string;
    accountNumberMasked: string;
    verified: boolean;
  }[];
  wallet: AdminWalletRow | null;
}

/** GET /api/admin/kyc-queue — 200 response envelope (unpaged list, no meta) */
export type KycQueueResponse = ApiOk<KycQueueData[]>;

// ------------------------------------------------------------
// §15 — GET /api/admin/orders — order list
// ------------------------------------------------------------

/** GET /api/admin/orders — query params (status "all" = no filter) */
export interface AdminOrdersQuery {
  status?: string;
  storeId?: string;
  search?: string;
  page?: number;
  size?: number;
}

/** GET /api/admin/orders — 200 payload element (order + store + item count + commission) */
export interface AdminOrdersData extends AdminOrderRow {
  store: {
    id: string;
    name: string;
    slug: string;
  };
  itemsCount: number;
  commissionMinor: number;
}

/** GET /api/admin/orders — 200 paged response */
export type AdminOrdersResponse = ApiPage<AdminOrdersData>;

// ------------------------------------------------------------
// §15 — GET /api/admin/orders/[id] — order dossier
// ------------------------------------------------------------

/** GET /api/admin/orders/[id] — 200 payload (full order dossier) */
export interface AdminOrderDetailData {
  order: AdminOrderRow & {
    store: AdminStoreRow & {
      seller: {
        id: string;
        email: string;
        fullName: string;
        displayName: string;
      } | null;
    };
  };
  items: AdminOrderItemRow[];
  history: AdminOrderHistoryRow[];
  paymentIntents: AdminPaymentIntentRow[];
  refunds: AdminRefundRow[];
  dispute: AdminDisputeRow | null;
  disputes: AdminDisputeRow[];
  seller: {
    id: string;
    email: string;
    fullName: string;
    displayName: string;
  } | null;
  store: {
    id: string;
    name: string;
    slug: string;
  };
  wallet: AdminWalletRow | null;
}

/** GET /api/admin/orders/[id] — 200 response envelope */
export type AdminOrderDetailResponse = ApiOk<AdminOrderDetailData>;

/** GET /api/admin/orders/[id] — referenced row: order line item with commission breakdown */
export interface AdminOrderItemRow {
  id: string;
  orderId: string;
  productId: string | null;
  variantId: string | null;
  title: string;
  variantLabel: string | null;
  unitPriceMinor: number;
  qty: number;
  lineSubtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  commissionPercent: number;
  commissionMinor: number;
  fixedFeeMinor: number;
  sellerNetMinor: number;
  breakdownJson: string;
  refundedMinor: number;
  affiliateDirectId: string | null;
  affiliateSponsorId: string | null;
  affiliateLinkId: string | null;
  affiliateRateBps: number | null;
  affiliatePoolMinor: number;
  affiliateSponsorEnabled: boolean | null;
}

/** GET /api/admin/orders/[id] — referenced row: order status history entry */
export interface AdminOrderHistoryRow {
  id: string;
  orderId: string;
  fromStatus: string | null;
  toStatus: string;
  actor: string;
  note: string | null;
  createdAt: string;
}

/** GET /api/admin/orders/[id] — referenced row: payment intent */
export interface AdminPaymentIntentRow {
  id: string;
  orderId: string;
  provider: string;
  providerRef: string;
  amountMinor: number;
  status: string;
  redirectUrl: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/admin/orders/[id] — referenced row: refund */
export interface AdminRefundRow {
  id: string;
  orderId: string;
  amountMinor: number;
  reason: string | null;
  status: string;
  requestedBy: string;
  restock: boolean;
  commissionReversalMinor: number;
  affiliateReversalMinor: number;
  processedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/admin/orders/[id] — referenced row: dispute */
export interface AdminDisputeRow {
  id: string;
  orderId: string;
  reason: string;
  status: string;
  openedBy: string;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ------------------------------------------------------------
// §15 — GET /api/admin/disputes — dispute list
// ------------------------------------------------------------

/** GET /api/admin/disputes — query params (status "all" = no filter) */
export interface AdminDisputesQuery {
  status?: string;
  page?: number;
  size?: number;
}

/** GET /api/admin/disputes — 200 payload element (dispute + slim order context) */
export interface AdminDisputesData extends AdminDisputeRow {
  order: {
    id: string;
    orderNumber: string;
    status: string;
    totalMinor: number;
    customerName: string;
    customerEmail: string;
    store: {
      id: string;
      name: string;
      slug: string;
    };
  };
}

/** GET /api/admin/disputes — 200 paged response */
export type AdminDisputesResponse = ApiPage<AdminDisputesData>;

// ------------------------------------------------------------
// §15 — PATCH /api/admin/disputes/[id] — update dispute
// ------------------------------------------------------------

/** PATCH /api/admin/disputes/[id] — request body (status/resolution update) */
export interface AdminDisputePatchBody {
  status: "open" | "under_review" | "resolved" | "rejected";
  resolution?: string;
}

/** PATCH /api/admin/disputes/[id] — 200 response envelope */
export type AdminDisputePatchResponse = ApiOk<AdminDisputeRow>;

// ------------------------------------------------------------
// §15 — GET /api/admin/refunds — refund queue list
// ------------------------------------------------------------

/** GET /api/admin/refunds — query params (status "all" = no filter) */
export interface AdminRefundsQuery {
  status?: string;
  page?: number;
  size?: number;
}

/** GET /api/admin/refunds — 200 payload element (refund + order/store context) */
export interface AdminRefundsData extends AdminRefundRow {
  order: {
    id: string;
    orderNumber: string;
    status: string;
    totalMinor: number;
    currency: string;
    customerName: string;
    customerEmail: string;
    store: {
      id: string;
      name: string;
      slug: string;
    };
  };
}

/** GET /api/admin/refunds — 200 paged response */
export type AdminRefundsResponse = ApiPage<AdminRefundsData>;

// ------------------------------------------------------------
// §15 — POST /api/admin/refunds/[id]/process — process refund
// ------------------------------------------------------------

/** POST /api/admin/refunds/[id]/process — 200 payload (refund + T5 txn result) */
export interface AdminRefundProcessData {
  refund: AdminRefundRow;
  txnId: string;
  orderStatus: "refunded" | "partially_refunded";
  totalRefundedMinor: number;
}

/** POST /api/admin/refunds/[id]/process — 200 response envelope */
export type AdminRefundProcessResponse = ApiOk<AdminRefundProcessData>;

// ------------------------------------------------------------
// §15 — POST /api/admin/refunds/[id]/approve — approve refund
// ------------------------------------------------------------

/** POST /api/admin/refunds/[id]/approve — 200 response envelope */
export type AdminRefundApproveResponse = ApiOk<AdminRefundRow>;

// ------------------------------------------------------------
// §15 — POST /api/admin/refunds/[id]/reject — reject refund
// ------------------------------------------------------------

/** POST /api/admin/refunds/[id]/reject — request body (reason optional) */
export interface AdminRefundRejectBody {
  reason?: string;
}

/** POST /api/admin/refunds/[id]/reject — 200 response envelope */
export type AdminRefundRejectResponse = ApiOk<AdminRefundRow>;

// ------------------------------------------------------------
// §15 — GET /api/admin/products — product list
// ------------------------------------------------------------

/** GET /api/admin/products — query params (status "all" = no filter) */
export interface AdminProductsQuery {
  status?: string;
  search?: string;
  storeId?: string;
  page?: number;
  size?: number;
}

/** GET /api/admin/products — 200 payload element (product with parsed flags, images, store, category) */
export type AdminProductsData = Omit<AdminProductRow, "flagsJson"> & {
  flags: string[];
  images: AdminProductImageRow[];
  store: {
    id: string;
    name: string;
    slug: string;
    status: string;
  };
  category: {
    id: string;
    name: string;
  } | null;
};

/** GET /api/admin/products — 200 paged response */
export type AdminProductsResponse = ApiPage<AdminProductsData>;

// ------------------------------------------------------------
// §15 — POST /api/admin/products/[id]/approve — approve product
// ------------------------------------------------------------

/** POST /api/admin/products/[id]/approve — 200 response envelope */
export type AdminProductApproveResponse = ApiOk<AdminProductRow>;

// ------------------------------------------------------------
// §15 — POST /api/admin/products/[id]/reject — reject product
// ------------------------------------------------------------

/** POST /api/admin/products/[id]/reject — request body (reason optional) */
export interface AdminProductRejectBody {
  reason?: string;
}

/** POST /api/admin/products/[id]/reject — 200 response envelope */
export type AdminProductRejectResponse = ApiOk<AdminProductRow>;

// ------------------------------------------------------------
// §15 — POST /api/admin/products/[id]/ban — ban product
// ------------------------------------------------------------

/** POST /api/admin/products/[id]/ban — request body (reason optional) */
export interface AdminProductBanBody {
  reason?: string;
}

/** POST /api/admin/products/[id]/ban — 200 response envelope */
export type AdminProductBanResponse = ApiOk<AdminProductRow>;

// ------------------------------------------------------------
// §15 — GET /api/admin/reviews — review moderation queue
// ------------------------------------------------------------

/** GET /api/admin/reviews — query params (status validated: pending | published | rejected) */
export interface AdminReviewsQuery {
  status?: string;
  productId?: string;
  page?: number;
  size?: number;
}

/** GET /api/admin/reviews — 200 payload element (review + product/shopper/order/reward context) */
export interface AdminReviewsData {
  id: string;
  productId: string;
  orderId: string | null;
  customerName: string;
  rating: number;
  unsafeContent: boolean;
  title: string | null;
  body: string | null;
  reply: string | null;
  status: string;
  createdAt: string;
  product: {
    id: string;
    title: string;
    slug: string;
    store: {
      id: string;
      name: string;
      slug: string;
    };
  };
  shopper: {
    id: string;
    email: string;
    fullName: string;
  } | null;
  order: {
    id: string;
    orderNumber: string;
    status: string;
  } | null;
  reward: {
    id: string;
    points: number;
    reversed: boolean;
    reversalReason: string | null;
  } | null;
}

/** GET /api/admin/reviews — 200 paged response */
export type AdminReviewsResponse = ApiPage<AdminReviewsData>;

// ------------------------------------------------------------
// §15 — POST /api/admin/reviews/[id] — moderate review
// ------------------------------------------------------------

/** POST /api/admin/reviews/[id] — request body (approve/reject + optional reward reversal) */
export interface AdminReviewModerateBody {
  action: "approve" | "reject";
  reason?: string;
  reverseReward?: boolean;
}

/** POST /api/admin/reviews/[id] — 200 payload (moderation result + recomputed ratings) */
export interface AdminReviewModerateData {
  id: string;
  status: "published" | "rejected";
  ratingAvg: number;
  ratingCount: number;
  rewardReversed: boolean;
}

/** POST /api/admin/reviews/[id] — 200 response envelope */
export type AdminReviewModerateResponse = ApiOk<AdminReviewModerateData>;

// ============================================================
// §16 Admin — Finance (Payouts, Commission, Ledger, Wallets,
// Banks, Reconciliation)
// ============================================================

// ------------------------------------------------------------
// §16 — shared payout row shape (preamble)
// ------------------------------------------------------------

/** §16 shared row — payouts table row */
export interface AdminPayoutRow {
  id: string;
  batchId: string | null;
  sellerId: string;
  walletId: string;
  referenceNo: string;
  amountMinor: number;
  status: string;
  method: string;
  bankAccountId: string | null;
  providerRef: string | null;
  statementJson: string;
  failReason: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ------------------------------------------------------------
// §16 — GET /api/admin/payouts — list payouts
// ------------------------------------------------------------

/** GET /api/admin/payouts — query params (status "all" = no filter) */
export interface AdminPayoutsQuery {
  status?: string;
  batchId?: string;
  page?: number;
  size?: number;
}

/** GET /api/admin/payouts — 200 payload element (payout + bank/batch/seller/store) */
export interface AdminPayoutsData extends AdminPayoutRow {
  bankAccount: {
    id: string;
    bankName: string;
    holderName: string;
    accountNumberMasked: string;
  } | null;
  batch: {
    id: string;
    status: string;
    runType: string;
    startedAt: string;
  } | null;
  seller: {
    id: string;
    email: string;
    displayName: string;
    fullName: string;
    store: {
      id: string;
      name: string;
      slug: string;
    } | null;
  } | null;
  storeName: string | null;
}

/** GET /api/admin/payouts — 200 paged response */
export type AdminPayoutsResponse = ApiPage<AdminPayoutsData>;

// ------------------------------------------------------------
// §16 — GET /api/admin/payouts/requests — seller payout request queues
// ------------------------------------------------------------

/** GET /api/admin/payouts/requests — referenced row: seller-initiated payout request */
export interface AdminPayoutRequest extends AdminPayoutRow {
  bankAccount: {
    id: string;
    bankName: string;
    holderName: string;
    accountNumberMasked: string;
    verified: boolean;
  } | null;
  seller: {
    id: string;
    email: string;
    displayName: string;
  } | null;
  storeName: string | null;
}

/** GET /api/admin/payouts/requests — 200 payload (open + recent queues) */
export interface AdminPayoutRequestsData {
  open: AdminPayoutRequest[];
  recent: AdminPayoutRequest[];
}

/** GET /api/admin/payouts/requests — 200 response envelope */
export type AdminPayoutRequestsResponse = ApiOk<AdminPayoutRequestsData>;

// ------------------------------------------------------------
// §16 — GET /api/admin/payouts/due — payouts due now
// ------------------------------------------------------------

/** GET /api/admin/payouts/due — 200 payload (wallets owed money now, ledger truth) */
export interface AdminPayoutsDueData {
  minMinor: number;
  mode: string;
  asOf: string;
  dueTotalMinor: number;
  dueCount: number;
  requestedTotalMinor: number;
  pendingTotalMinor: number;
  belowMinCount: number;
  belowMinTotalMinor: number;
  due: {
    walletId: string;
    sellerId: string;
    sellerName: string;
    storeName: string | null;
    availableMinor: number;
    requestedMinor: number;
    requestedRef: string | null;
    bank: {
      id: string;
      bankName: string;
      holderName: string;
      accountNumberMasked: string;
      verified: boolean;
    } | null;
    lastPayout: {
      amountMinor: number;
      paidAt: string;
    } | null;
  }[];
}

/** GET /api/admin/payouts/due — 200 response envelope */
export type AdminPayoutsDueResponse = ApiOk<AdminPayoutsDueData>;

// ------------------------------------------------------------
// §16 — POST /api/admin/payouts/sweep — operations sweep
// ------------------------------------------------------------

/** POST /api/admin/payouts/sweep — referenced row: wallet cache vs ledger-truth drift */
export interface AdminWalletCacheDrift {
  walletId: string;
  cachedAvailable: number;
  cachedPending: number;
  truthAvailable: number;
  truthPending: number;
  availableDelta: number;
  pendingDelta: number;
  maturedSinceLastWrite: number;
  lastCacheWriteAt: string;
}

/** POST /api/admin/payouts/sweep — 200 payload (stuck payouts, webhook replay, invariants) */
export interface AdminSweepData {
  stuck: {
    payoutId: string;
    referenceNo: string;
    hoursStuck: number;
    updatedAt: string;
    alerted: boolean;
  }[];
  stuckHours: number;
  webhooks: {
    scanned: number;
    reprocessed: number;
    stillFailing: number;
    skipped: number;
  };
  invariants: {
    ok: boolean;
    problems: string[];
    hardDrift: AdminWalletCacheDrift[];
    timeMaturityStale: AdminWalletCacheDrift[];
    txnCount: number;
    walletCount: number;
  };
  ranAt: string;
}

/** POST /api/admin/payouts/sweep — 200 response envelope */
export type AdminPayoutSweepResponse = ApiOk<AdminSweepData>;

// ------------------------------------------------------------
// §16 — POST /api/admin/payouts/[id]/sync — payout reconciliation report
// ------------------------------------------------------------

/** POST /api/admin/payouts/[id]/sync — 200 payload (read-only reconciliation report) */
export interface AdminPayoutSyncData {
  payoutId: string;
  status: string;
  walletTruth: AdminWalletTruth;
  cacheMatches: boolean;
  expectedTxns: {
    T3: boolean;
    T4: boolean;
    T4f: boolean;
  };
  statementRebuilt: boolean;
  findings: string[];
}

/** POST /api/admin/payouts/[id]/sync — 200 response envelope */
export type AdminPayoutSyncResponse = ApiOk<AdminPayoutSyncData>;

// ------------------------------------------------------------
// §16 — POST /api/admin/payouts/[id]/mark-paid — mark payout paid (T4)
// ------------------------------------------------------------

/** POST /api/admin/payouts/[id]/mark-paid — request body (provider reference) */
export interface AdminPayoutMarkPaidBody {
  referenceNo: string;
}

/** POST /api/admin/payouts/[id]/mark-paid — 200 response envelope */
export type AdminPayoutMarkPaidResponse = ApiOk<AdminPayoutRow>;

// ------------------------------------------------------------
// §16 — POST /api/admin/payouts/[id]/approve — approve seller payout request
// ------------------------------------------------------------

/** POST /api/admin/payouts/[id]/approve — 200 response envelope */
export type AdminPayoutApproveResponse = ApiOk<AdminPayoutRow>;

// ------------------------------------------------------------
// §16 — POST /api/admin/payouts/[id]/reject — reject seller payout request
// ------------------------------------------------------------

/** POST /api/admin/payouts/[id]/reject — request body (reason required) */
export interface AdminPayoutRejectBody {
  reason: string;
}

/** POST /api/admin/payouts/[id]/reject — 200 response envelope */
export type AdminPayoutRejectResponse = ApiOk<AdminPayoutRow>;

// ------------------------------------------------------------
// §16 — POST /api/admin/payouts/[id]/fail — fail payout (T4f reversal)
// ------------------------------------------------------------

/** POST /api/admin/payouts/[id]/fail — request body (reason required) */
export interface AdminPayoutFailBody {
  reason: string;
}

/** POST /api/admin/payouts/[id]/fail — 200 response envelope */
export type AdminPayoutFailResponse = ApiOk<AdminPayoutRow>;

// ------------------------------------------------------------
// §16 — GET /api/admin/payout-batches — list payout batches
// ------------------------------------------------------------

/** GET /api/admin/payout-batches — referenced row: batch payout with seller identity */
export interface AdminBatchPayout extends AdminPayoutRow {
  sellerName: string | null;
  sellerEmail: string | null;
}

/** GET /api/admin/payout-batches — 200 payload element (batch + nested payouts) */
export interface AdminPayoutBatchData {
  id: string;
  runType: string;
  status: string;
  currency: string;
  totalMinor: number;
  payoutCount: number;
  startedAt: string;
  finishedAt: string | null;
  payouts: AdminBatchPayout[];
}

/** GET /api/admin/payout-batches — 200 response envelope (deviation: list without meta) */
export type AdminPayoutBatchesResponse = ApiOk<AdminPayoutBatchData[]>;

// ------------------------------------------------------------
// §16 — POST /api/admin/payout-batches — run payout batch
// ------------------------------------------------------------

/** POST /api/admin/payout-batches — request body (dry-run flag) */
export interface AdminPayoutBatchRunBody {
  dryRun?: boolean;
}

/** POST /api/admin/payout-batches — referenced row: bank account summary */
export interface AdminBatchBank {
  id: string;
  bankName: string;
  holderName: string;
  accountNumberMasked: string;
  verified: boolean;
}

/** POST /api/admin/payout-batches — 200 variant: dry-run preview */
export interface AdminPayoutBatchRunDryRunData {
  dryRun: true;
  minMinor: number;
  mode: string;
  eligibleCount: number;
  eligibleTotalMinor: number;
  eligible: {
    walletId: string;
    sellerId: string;
    sellerName: string;
    storeName: string | null;
    availableMinor: number;
    bank: AdminBatchBank | null;
  }[];
  skipped: {
    walletId: string;
    sellerName: string;
    storeName: string | null;
    availableMinor: number;
    reason: string;
    bank: AdminBatchBank | null;
  }[];
}

/** POST /api/admin/payout-batches — 200 variant: executed batch */
export interface AdminPayoutBatchRunExecutedData {
  batch: {
    id: string;
    runType: string;
    status: string;
    currency: string;
    totalMinor: number;
    payoutCount: number;
    startedAt: string;
    finishedAt: string | null;
    payouts: AdminPayoutRow[];
  };
  payouts: AdminPayoutRow[];
}

/** POST /api/admin/payout-batches — 200 response envelope (dry-run preview or executed batch) */
export type AdminPayoutBatchRunResponse = ApiOk<AdminPayoutBatchRunDryRunData | AdminPayoutBatchRunExecutedData>;

// ------------------------------------------------------------
// §16 — GET /api/admin/payment-reconciliation — late-payment refund cases
// ------------------------------------------------------------

/** GET /api/admin/payment-reconciliation — query params (invalid status values ignored) */
export interface AdminPaymentReconciliationQuery {
  status?: string;
  page?: number;
  size?: number;
}

/** GET /api/admin/payment-reconciliation — referenced row: provider refund case */
export interface ReconCase {
  id: string;
  provider: string;
  providerRef: string;
  providerPaymentId: string | null;
  amountMinor: number;
  currency: string;
  reason: string;
  status: string;
  providerRefundId: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/admin/payment-reconciliation — 200 payload (deviation: meta nested inside data) */
export interface PaymentReconciliationData {
  cases: ReconCase[];
  stats: {
    counts: Record<string, number>;
    total: number;
    exhaustedAttempts: number;
    awaitingOperator: number;
  };
  runbook: string;
  meta: ApiPageMeta;
}

/** GET /api/admin/payment-reconciliation — 200 response envelope */
export type PaymentReconciliationResponse = ApiOk<PaymentReconciliationData>;

// ------------------------------------------------------------
// §16 — GET /api/admin/banks — bank verification queue
// ------------------------------------------------------------

/** GET /api/admin/banks — query params (verification state filter) */
export interface AdminBanksQuery {
  verified?: "true" | "false" | "all";
}

/** GET /api/admin/banks — 200 payload element (bank account + seller identity) */
export interface AdminBanksData {
  id: string;
  holderName: string;
  bankName: string;
  accountNumberMasked: string;
  verified: boolean;
  verifiedAt: string | null;
  createdAt: string;
  sellerId: string;
  sellerLegalName: string;
  sellerEmail: string;
  sellerStatus: string;
  storeName: string | null;
}

/** GET /api/admin/banks — 200 response envelope (unpaged list, no meta) */
export type AdminBanksResponse = ApiOk<AdminBanksData[]>;

// ------------------------------------------------------------
// §16 — POST /api/admin/banks/[id]/verify — verify bank account
// ------------------------------------------------------------

/** POST /api/admin/banks/[id]/verify — 200 payload (verified bank account row) */
export interface AdminBankVerifyData {
  id: string;
  sellerId: string;
  holderName: string;
  bankName: string;
  accountNumberMasked: string;
  accountNumberEnc: string;
  verified: boolean;
  verifiedAt: string | null;
  createdAt: string;
}

/** POST /api/admin/banks/[id]/verify — 200 response envelope */
export type AdminBankVerifyResponse = ApiOk<AdminBankVerifyData>;

// ------------------------------------------------------------
// §16 — POST /api/admin/banks/[id]/reject — reject bank account
// ------------------------------------------------------------

/** POST /api/admin/banks/[id]/reject — 200 payload (unverified bank account row) */
export interface AdminBankRejectData {
  id: string;
  sellerId: string;
  holderName: string;
  bankName: string;
  accountNumberMasked: string;
  accountNumberEnc: string;
  verified: boolean;
  verifiedAt: string | null;
  createdAt: string;
}

/** POST /api/admin/banks/[id]/reject — 200 response envelope */
export type AdminBankRejectResponse = ApiOk<AdminBankRejectData>;

// ------------------------------------------------------------
// §16 — GET /api/admin/wallets — wallets with truth-refreshed balances
// ------------------------------------------------------------

/** GET /api/admin/wallets — 200 payload element (wallet + seller/store + cache flag) */
export interface AdminWalletsData extends AdminWalletRow {
  seller: {
    id: string;
    email: string;
    displayName: string;
    fullName: string;
    status: string;
    riskTier: string;
    store: {
      id: string;
      name: string;
      slug: string;
      status: string;
    } | null;
  };
  cacheRefreshed: boolean;
  storeName: string | null;
  storeSlug: string | null;
}

/** GET /api/admin/wallets — 200 response envelope (unpaged list, no meta) */
export type AdminWalletsResponse = ApiOk<AdminWalletsData[]>;

// ------------------------------------------------------------
// §16 — POST /api/admin/wallets/[id]/adjust — manual wallet adjustment (T6)
// ------------------------------------------------------------

/** POST /api/admin/wallets/[id]/adjust — request body (credit/debit with reason) */
export interface AdminWalletAdjustBody {
  amountMinor: number;
  direction: "credit" | "debit";
  reason: string;
}

/** POST /api/admin/wallets/[id]/adjust — referenced row: ledger-truth wallet balances */
export interface AdminWalletTruth {
  pendingMinor: number;
  availableMinor: number;
  lifetimeEarnedMinor: number;
  lifetimeCommissionMinor: number;
}

/** POST /api/admin/wallets/[id]/adjust — 200 payload (wallet + T6 txn + before/after truth) */
export interface AdminWalletAdjustData {
  wallet: AdminWalletRow;
  txnId: string;
  before: AdminWalletTruth;
  after: AdminWalletTruth;
}

/** POST /api/admin/wallets/[id]/adjust — 200 response envelope */
export type AdminWalletAdjustResponse = ApiOk<AdminWalletAdjustData>;

// ------------------------------------------------------------
// §16 — GET /api/admin/ledger/accounts — chart of accounts with balances
// ------------------------------------------------------------

/** GET /api/admin/ledger/accounts — 200 payload element (account with summed balances) */
export interface AdminLedgerAccountsData {
  code: string;
  name: string;
  type: string;
  walletId: string | null;
  debitMinor: number;
  creditMinor: number;
  balanceMinor: number;
  lineCount: number;
}

/** GET /api/admin/ledger/accounts — 200 response envelope (unpaged list, no meta) */
export type AdminLedgerAccountsResponse = ApiOk<AdminLedgerAccountsData[]>;

// ------------------------------------------------------------
// §16 — GET /api/admin/ledger/transactions — ledger transactions (cursor)
// ------------------------------------------------------------

/** GET /api/admin/ledger/transactions — query params (deviation: cursor pagination) */
export interface AdminLedgerTransactionsQuery {
  type?: string;
  walletId?: string;
  cursor?: string;
}

/** GET /api/admin/ledger/transactions — referenced row: ledger line */
export interface AdminLedgerLineRow {
  id: string;
  txnId: string;
  accountCode: string;
  direction: string;
  amountMinor: number;
  currency: string;
  walletId: string | null;
  availableAt: string | null;
  memo: string | null;
  createdAt: string;
  refType: string | null;
  refId: string | null;
}

/** GET /api/admin/ledger/transactions — referenced row: ledger transaction with lines */
export interface AdminLedgerTxnRow {
  id: string;
  txnType: string;
  refType: string | null;
  refId: string | null;
  description: string | null;
  occurredAt: string;
  dedupKey: string | null;
  lines: AdminLedgerLineRow[];
}

/** GET /api/admin/ledger/transactions — 200 payload (latest 100, cursor-paginated by id desc) */
export interface AdminLedgerTransactionsData {
  items: AdminLedgerTxnRow[];
  nextCursor: string | null;
  count: number;
}

/** GET /api/admin/ledger/transactions — 200 response envelope */
export type AdminLedgerTransactionsResponse = ApiOk<AdminLedgerTransactionsData>;

// ------------------------------------------------------------
// §16 — POST /api/admin/commission/simulate — commission simulator
// ------------------------------------------------------------

/** POST /api/admin/commission/simulate — request body (simulated item inputs, all optional) */
export interface SimulateBody {
  priceMinor?: number;
  qty?: number;
  discountMinor?: number;
  shippingMinor?: number;
  categoryId?: string | null;
  sellerId?: string | null;
  productId?: string | null;
}

/** POST /api/admin/commission/simulate — 200 payload (computed commission + rule trace) */
export interface SimulateData {
  commissionMinor: number;
  sellerNetMinor: number;
  holdDays: number;
  trace: {
    rule_source: string;
    source_id?: string;
    holiday_id?: string;
    percent: number;
    base: number;
    percent_part: number;
    fixed_fee_allocated: number;
    discount_allocated: number;
    shipping_allocated: number;
    affiliate_rate_bps?: number;
    affiliate_base?: number;
    affiliate_pool?: number;
    flags: string[];
  };
}

/** POST /api/admin/commission/simulate — 200 response envelope */
export type SimulateResponse = ApiOk<SimulateData>;

// ------------------------------------------------------------
// §16 — GET /api/admin/commission/psp-settings — PSP split scaffold state
// ------------------------------------------------------------

/** GET /api/admin/commission/psp-settings — 200 payload (dormant split-settlement scaffold) */
export interface PspSettingsData {
  autoSettle: boolean;
  provider: string;
  candidates: {
    id: string;
    label: string;
    note: string;
    awaitingAdapter: boolean;
  }[];
}

/** GET /api/admin/commission/psp-settings — 200 response envelope */
export type PspSettingsResponse = ApiOk<PspSettingsData>;

// ------------------------------------------------------------
// §16 — PUT /api/admin/commission/psp-settings — update PSP scaffold settings
// ------------------------------------------------------------

/** PUT /api/admin/commission/psp-settings — request body (Setting keys only) */
export interface PspSettingsPutBody {
  autoSettle?: boolean;
  provider?: string;
}

/** PUT /api/admin/commission/psp-settings — 200 payload (updated Setting values) */
export interface PspSettingsPutData {
  updated: {
    autoSettle?: string;
    provider?: string;
  };
}

/** PUT /api/admin/commission/psp-settings — 200 response envelope */
export type PspSettingsPutResponse = ApiOk<PspSettingsPutData>;

// ------------------------------------------------------------
// §16 — GET /api/admin/commission/settings — commission settings
// ------------------------------------------------------------

/** GET /api/admin/commission/settings — 200 payload (global commission settings singleton) */
export interface CommissionSettingsData {
  id: number;
  defaultPercent: number;
  appliesToShipping: boolean;
  basePriceRule: string;
  fixedFeeMinor: number;
  minCommissionMinor: number;
  payoutHoldDays: number;
  holdReleaseRule: string;
  graceDaysAfterDelivered: number;
}

/** GET /api/admin/commission/settings — 200 response envelope */
export type CommissionSettingsResponse = ApiOk<CommissionSettingsData>;

// ------------------------------------------------------------
// §16 — PUT /api/admin/commission/settings — update commission settings
// ------------------------------------------------------------

/** PUT /api/admin/commission/settings — request body (partial update with range validation) */
export interface CommissionSettingsPutBody {
  defaultPercent?: number;
  payoutHoldDays?: number;
  appliesToShipping?: boolean;
  basePriceRule?: "paid_price" | "list_price";
  fixedFeeMinor?: number;
  minCommissionMinor?: number;
  holdReleaseRule?: "days_after_paid" | "days_after_delivered";
  graceDaysAfterDelivered?: number;
}

/** PUT /api/admin/commission/settings — 200 payload (updated settings singleton) */
export interface CommissionSettingsPutData {
  id: number;
  defaultPercent: number;
  appliesToShipping: boolean;
  basePriceRule: string;
  fixedFeeMinor: number;
  minCommissionMinor: number;
  payoutHoldDays: number;
  holdReleaseRule: string;
  graceDaysAfterDelivered: number;
}

/** PUT /api/admin/commission/settings — 200 response envelope */
export type CommissionSettingsPutResponse = ApiOk<CommissionSettingsPutData>;

// ------------------------------------------------------------
// §16 — GET /api/admin/commission/holidays — list fee holidays
// ------------------------------------------------------------

/** GET /api/admin/commission/holidays — 200 payload element (holiday with parsed scopeIdsList) */
export interface HolidaysData {
  id: string;
  name: string;
  scope: string;
  scopeIds: string | null;
  percent: number;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  scopeIdsList: string[];
}

/** GET /api/admin/commission/holidays — 200 response envelope (unpaged list, no meta) */
export type HolidaysResponse = ApiOk<HolidaysData[]>;

// ------------------------------------------------------------
// §16 — POST /api/admin/commission/holidays — create fee holiday
// ------------------------------------------------------------

/** POST /api/admin/commission/holidays — request body (scoped rate override window) */
export interface HolidayCreateBody {
  name: string;
  scope?: "all" | "sellers" | "categories";
  scopeIds?: string[];
  percent?: number;
  startsAt: string;
  endsAt: string;
  isActive?: boolean;
}

/** POST /api/admin/commission/holidays — 200 payload (created fee holiday row) */
export interface HolidayCreateData {
  id: string;
  name: string;
  scope: string;
  scopeIds: string | null;
  percent: number;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/admin/commission/holidays — 200 response envelope */
export type HolidayCreateResponse = ApiOk<HolidayCreateData>;

// ------------------------------------------------------------
// §16 — PATCH /api/admin/commission/holidays/[id] — update fee holiday
// ------------------------------------------------------------

/** PATCH /api/admin/commission/holidays/[id] — request body (partial update) */
export interface HolidayPatchBody {
  name?: string;
  percent?: number;
  startsAt?: string;
  endsAt?: string;
  isActive?: boolean;
}

/** PATCH /api/admin/commission/holidays/[id] — 200 payload (updated fee holiday row) */
export interface HolidayPatchData {
  id: string;
  name: string;
  scope: string;
  scopeIds: string | null;
  percent: number;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** PATCH /api/admin/commission/holidays/[id] — 200 response envelope */
export type HolidayPatchResponse = ApiOk<HolidayPatchData>;

// ------------------------------------------------------------
// §16 — DELETE /api/admin/commission/holidays/[id] — delete fee holiday
// ------------------------------------------------------------

/** DELETE /api/admin/commission/holidays/[id] — 200 payload (deletion ack) */
export interface HolidayDeleteData {
  deleted: true;
}

/** DELETE /api/admin/commission/holidays/[id] — 200 response envelope */
export type HolidayDeleteResponse = ApiOk<HolidayDeleteData>;

// ------------------------------------------------------------
// §16 — GET /api/admin/commission/analytics — commission analytics
// ------------------------------------------------------------

/** GET /api/admin/commission/analytics — query params (default 90, clamped 7..730) */
export interface AdminCommissionAnalyticsQuery {
  days?: number;
}

/** GET /api/admin/commission/analytics — 200 payload (ledger-truth analytics + exports + PSP state) */
export interface CommissionAnalyticsData {
  days: number;
  summary: {
    commissionMinor: number;
    salesMinor: number;
    effectiveRatePct: number;
    orderCount: number;
    refundsReversalMinor: number;
    allTimeCommissionMinor: number;
  };
  weekly: {
    weekStart: string;
    commissionMinor: number;
    orderCount: number;
  }[];
  stores: {
    walletId: string;
    storeName: string;
    orderCount: number;
    commissionMinor: number;
  }[];
  exports: {
    id: string;
    periodFrom: string;
    periodTo: string;
    totalMinor: number;
    orderCount: number;
    lineCount: number;
    format: string;
    createdByEmail: string;
    createdAt: string;
  }[];
  psp: {
    webhookPath: string;
    candidates: {
      id: string;
      label: string;
      note: string;
      awaitingAdapter: boolean;
    }[];
    autoSettle: boolean;
    provider: string;
    lastSettlement: {
      description: string | null;
      occurredAt: string;
      amountMinor: number;
    } | null;
    note: string;
  };
}

/** GET /api/admin/commission/analytics — 200 response envelope */
export type CommissionAnalyticsResponse = ApiOk<CommissionAnalyticsData>;

// ------------------------------------------------------------
// §16 — GET /api/admin/commission/overrides — list commission overrides
// ------------------------------------------------------------

/** GET /api/admin/commission/overrides — query params (scope filter) */
export interface AdminCommissionOverridesQuery {
  scope?: string;
}

/** GET /api/admin/commission/overrides — 200 payload element (override with resolved names) */
export interface OverridesData {
  id: string;
  scope: string;
  categoryId: string | null;
  sellerId: string | null;
  productId: string | null;
  percent: number | null;
  fixedFeeMinor: number | null;
  holdDays: number | null;
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  categoryName: string | null;
  sellerName: string | null;
  sellerEmail: string | null;
  productName: string | null;
}

/** GET /api/admin/commission/overrides — 200 response envelope (unpaged list, no meta) */
export type OverridesResponse = ApiOk<OverridesData[]>;

// ------------------------------------------------------------
// §16 — POST /api/admin/commission/overrides — create commission override
// ------------------------------------------------------------

/** POST /api/admin/commission/overrides — request body (scoped override) */
export interface OverrideCreateBody {
  scope: "category" | "seller" | "product";
  categoryId?: string | null;
  sellerId?: string | null;
  productId?: string | null;
  percent?: number;
  fixedFeeMinor?: number;
  holdDays?: number;
  validFrom?: string | null;
  validTo?: string | null;
}

/** POST /api/admin/commission/overrides — 200 payload (created override row) */
export interface OverrideCreateData {
  id: string;
  scope: string;
  categoryId: string | null;
  sellerId: string | null;
  productId: string | null;
  percent: number | null;
  fixedFeeMinor: number | null;
  holdDays: number | null;
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/admin/commission/overrides — 200 response envelope */
export type OverrideCreateResponse = ApiOk<OverrideCreateData>;

// ------------------------------------------------------------
// §16 — PATCH /api/admin/commission/overrides/[id] — update commission override
// ------------------------------------------------------------

/** PATCH /api/admin/commission/overrides/[id] — request body (partial update) */
export interface OverridePatchBody {
  percent?: number;
  fixedFeeMinor?: number;
  holdDays?: number;
  validFrom?: string | null;
  validTo?: string | null;
  isActive?: boolean;
}

/** PATCH /api/admin/commission/overrides/[id] — 200 payload (updated override row) */
export interface OverridePatchData {
  id: string;
  scope: string;
  categoryId: string | null;
  sellerId: string | null;
  productId: string | null;
  percent: number | null;
  fixedFeeMinor: number | null;
  holdDays: number | null;
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** PATCH /api/admin/commission/overrides/[id] — 200 response envelope */
export type OverridePatchResponse = ApiOk<OverridePatchData>;

// ------------------------------------------------------------
// §16 — DELETE /api/admin/commission/overrides/[id] — delete commission override
// ------------------------------------------------------------

/** DELETE /api/admin/commission/overrides/[id] — 200 payload (deletion ack) */
export interface OverrideDeleteData {
  deleted: true;
}

/** DELETE /api/admin/commission/overrides/[id] — 200 response envelope */
export type OverrideDeleteResponse = ApiOk<OverrideDeleteData>;

// ------------------------------------------------------------
// §16 — GET /api/admin/commission/exports — export history
// ------------------------------------------------------------

/** GET /api/admin/commission/exports — 200 payload element (export history row) */
export interface ExportsData {
  id: string;
  periodFrom: string;
  periodTo: string;
  totalMinor: number;
  orderCount: number;
  lineCount: number;
  format: string;
  createdByEmail: string;
  createdAt: string;
}

/** GET /api/admin/commission/exports — 200 response envelope (latest 50, no meta) */
export type ExportsResponse = ApiOk<ExportsData[]>;

// ------------------------------------------------------------
// §16 — POST /api/admin/commission/exports — create commission CSV export
// ------------------------------------------------------------

/** POST /api/admin/commission/exports — request body (days default 90, clamped 7..730) */
export interface ExportCreateBody {
  days?: number;
}

/** POST /api/admin/commission/exports — referenced row: commission snapshot aggregates */
export interface CommissionSnapshot {
  periodFrom: string;
  periodTo: string;
  generatedAt: string;
  createdByEmail: string;
  summary: {
    commissionMinor: number;
    salesMinor: number;
    effectiveRatePct: number;
    orderCount: number;
    refundsReversalMinor: number;
  };
  weekly: {
    weekStart: string;
    commissionMinor: number;
    orderCount: number;
  }[];
  stores: {
    walletId: string;
    storeName: string;
    orderCount: number;
    commissionMinor: number;
  }[];
}

/** POST /api/admin/commission/exports — 201 payload (history row + embedded CSV + snapshot) */
export interface ExportCreateData {
  export: {
    id: string;
    periodFrom: string;
    periodTo: string;
    totalMinor: number;
    orderCount: number;
    lineCount: number;
    format: string;
    snapshotJson: string;
    createdByEmail: string;
    createdAt: string;
  };
  csv: string;
  snapshot: CommissionSnapshot;
}

/** POST /api/admin/commission/exports — 201 response envelope (CSV embedded as string in data) */
export type ExportCreateResponse = ApiOk<ExportCreateData>;
// ============================================================
// §17 Admin — Affiliate Program Management
// §18 Admin — Security (MFA) & Support
// §19 Admin — Content, Config & Reporting
// ============================================================
// Envelope types ApiOk<T> / ApiPage<T> / ApiPageMeta / ApiErr are
// defined once in the assembled contract file and referenced here.

// ============================================================
// §17 Admin — Affiliate Program Management
// ============================================================

/** §17 shared — affiliate balance buckets, all integer minor units */
export interface AdminAffBalances {
  pendingMinor: number;
  approvedMinor: number;
  availableMinor: number;
  payoutInFlightMinor: number;
  paidMinor: number;
  reversedMinor: number;
  heldMinor: number;
  recoveryMinor: number;
  requestableMinor: number;
}

/** GET /api/admin/affiliate/accounts — query params */
export interface AdminAffAccountsQuery {
  status?: string;
  q?: string;
  page?: number;
  size?: number;
}

/** GET /api/admin/affiliate/accounts — affiliate review list row */
export interface AdminAffAccountRow {
  id: string;
  displayName: string;
  slug: string;
  code: string;
  email: string;
  status: string;
  sponsorName: string | null;
  referrals: number;
  lifetimeEarningsMinor: number;
  activatedAt: string;
  suspendedReason: string | null;
}

/** GET /api/admin/affiliate/accounts — list payload (inline total/page; no meta envelope) */
export interface AdminAffAccountsData {
  total: number;
  page: number;
  accounts: AdminAffAccountRow[];
}

/** GET /api/admin/affiliate/accounts — affiliate review list */
export type AdminAffAccountsResponse = ApiOk<AdminAffAccountsData>;

/** GET /api/admin/affiliate/accounts/[id] — affiliate profile block */
export interface AdminAffAccountProfile {
  id: string;
  displayName: string;
  slug: string;
  code: string;
  email: string;
  fullName: string;
  status: string;
  bio: string | null;
  sponsor: { id: string; displayName: string } | null;
  sponsorSource: string | null;
  sponsorAssignedAt: string | null;
  activatedAt: string;
  suspendedReason: string | null;
  userCreatedAt: string;
}

/** GET /api/admin/affiliate/accounts/[id] — sponsor reassignment audit row */
export interface AdminAffSponsorAuditRow {
  fromSponsorId: string | null;
  toSponsorId: string | null;
  reason: string;
  actorId: string;
  createdAt: string;
}

/** GET /api/admin/affiliate/accounts/[id] — commission row on detail view */
export interface AdminAffAccountCommissionRow {
  id: string;
  orderNumber: string;
  status: string;
  poolMinor: number;
  rateBps: number;
  createdAt: string;
  directMinor: number;
  sponsorMinor: number;
}

/** GET /api/admin/affiliate/accounts/[id] — payout row on detail view */
export interface AdminAffAccountPayoutRow {
  id: string;
  amountMinor: number;
  status: string;
  reference: string | null;
  requestedAt: string;
  processedAt: string | null;
}

/** GET /api/admin/affiliate/accounts/[id] — affiliate investigation detail payload */
export interface AdminAffAccountDetailData {
  profile: AdminAffAccountProfile;
  balances: AdminAffBalances;
  referralCount: number;
  sponsorAudit: AdminAffSponsorAuditRow[];
  commissions: AdminAffAccountCommissionRow[];
  payouts: AdminAffAccountPayoutRow[];
}

/** GET /api/admin/affiliate/accounts/[id] — affiliate investigation detail */
export type AdminAffAccountDetailResponse = ApiOk<AdminAffAccountDetailData>;

/** POST /api/admin/affiliate/accounts/[id]/sponsor — sponsor correction body */
export interface AdminAffSponsorBody {
  sponsorCode?: string | null;
  reason: string;
}

/** POST /api/admin/affiliate/accounts/[id]/sponsor — sponsor correction result payload */
export interface AdminAffSponsorData {
  sponsorId: string | null;
}

/** POST /api/admin/affiliate/accounts/[id]/sponsor — sponsor correction result */
export type AdminAffSponsorResponse = ApiOk<AdminAffSponsorData>;

/** POST /api/admin/affiliate/accounts/[id]/status — suspend/reinstate/terminate body */
export interface AdminAffStatusBody {
  action: "suspend" | "reinstate" | "terminate";
  reason?: string | null;
}

/** POST /api/admin/affiliate/accounts/[id]/status — resulting affiliate status payload */
export interface AdminAffStatusData {
  status: string;
}

/** POST /api/admin/affiliate/accounts/[id]/status — suspend/reinstate/terminate result */
export type AdminAffStatusResponse = ApiOk<AdminAffStatusData>;

/** GET /api/admin/affiliate/commissions — query params */
export interface AdminAffCommissionsQuery {
  status?: string;
  affiliateId?: string;
  storeId?: string;
  orderNumber?: string;
  from?: string;
  to?: string;
  page?: number;
  size?: number;
}

/** GET /api/admin/affiliate/commissions — per-role commission allocation entry */
export interface AdminAffCommissionEntryRow {
  role: string;
  status: string;
  amountMinor: number;
  reversedMinor: number;
  availableAt: string | null;
  holdReason: string | null;
}

/** GET /api/admin/affiliate/commissions — commission allocation row */
export interface AdminAffCommissionRow {
  id: string;
  orderNumber: string;
  orderItemId: string;
  affiliate: string;
  status: string;
  rateBps: number;
  baseMinor: number;
  poolMinor: number;
  createdAt: string;
  entries: AdminAffCommissionEntryRow[];
}

/** GET /api/admin/affiliate/commissions — inspector payload (inline total/page/size; no meta envelope) */
export interface AdminAffCommissionsData {
  total: number;
  page: number;
  size: number;
  totals: { poolMinor: number; baseMinor: number };
  filters: { status: string | null; affiliateId: string | null; storeId: string | null; orderNumber: string | null; from: string | null; to: string | null };
  rows: AdminAffCommissionRow[];
}

/** GET /api/admin/affiliate/commissions — commission allocation inspector */
export type AdminAffCommissionsResponse = ApiOk<AdminAffCommissionsData>;

/** POST /api/admin/affiliate/commissions/[id]/hold — hold/release body */
export interface AdminAffHoldBody {
  action: "hold" | "release";
  reason: string;
}

/** POST /api/admin/affiliate/commissions/[id]/hold — resulting commission status payload */
export interface AdminAffHoldData {
  status: string;
}

/** POST /api/admin/affiliate/commissions/[id]/hold — hold/release result */
export type AdminAffHoldResponse = ApiOk<AdminAffHoldData>;

/** GET /api/admin/affiliate/reconciliation — 7-point reconciliation totals */
export interface AdminAffReconciliationPoints {
  expectedPoolMinor: number;
  allocatedMinor: number;
  heldMinor: number;
  availableMinor: number;
  paidOutMinor: number;
  reversalsMinor: number;
  remainingLiabilityMinor: number;
}

/** GET /api/admin/affiliate/reconciliation — reconciliation report (also embedded in overview) */
export interface AdminAffReconciliation {
  points: AdminAffReconciliationPoints;
  ledgerBalanceMinor: number;
  invariantOk: boolean;
  commissionCount: number;
  entriesByStatus: { status: string; count: number; amountMinor: number; reversedMinor: number }[];
  payoutsByStatus: { status: string; count: number; amountMinor: number }[];
  pendingEntryCount: number;
}

/** GET /api/admin/affiliate/reconciliation — 7-point reconciliation report */
export type AdminAffReconciliationResponse = ApiOk<AdminAffReconciliation>;

/** GET /api/admin/affiliate/overview — programme dashboard payload */
export interface AdminAffOverviewData {
  settings: { enabled: boolean; sponsorEnabled: boolean; maxRateBps: number; attrWindowDays: number; sponsorWindowDays: number; reviewDays: number; minPayoutMinor: number; collectionsEnabled: boolean; showcaseEnabled: boolean };
  counts: { affiliates: number; suspended: number; links: number; attributionTouches: number };
  reconciliation: AdminAffReconciliation;
}

/** GET /api/admin/affiliate/overview — programme dashboard */
export type AdminAffOverviewResponse = ApiOk<AdminAffOverviewData>;

/** GET /api/admin/affiliate/payouts — query params */
export interface AdminAffPayoutsQuery {
  status?: string;
  page?: number;
  size?: number;
}

/** GET /api/admin/affiliate/payouts — payout queue row */
export interface AdminAffPayoutRow {
  id: string;
  amountMinor: number;
  status: string;
  method: string;
  reference: string | null;
  note: string | null;
  failReason: string | null;
  statementJson: string;
  requestedAt: string;
  processedAt: string | null;
  affiliate: { displayName: string; slug: string; code: string; email: string; fullName: string; payoutRef: string | null };
}

/** GET /api/admin/affiliate/payouts — payout queue payload (inline total/page; no meta envelope) */
export interface AdminAffPayoutsData {
  total: number;
  page: number;
  queue: { status: string; count: number; amountMinor: number }[];
  payouts: AdminAffPayoutRow[];
}

/** GET /api/admin/affiliate/payouts — payout queue */
export type AdminAffPayoutsResponse = ApiOk<AdminAffPayoutsData>;

/** POST /api/admin/affiliate/payouts/[id]/process — payout state machine body */
export interface AdminAffProcessBody {
  action: "approve" | "mark-paid" | "fail" | "reject";
  reference?: string | null;
  reason?: string | null;
}

/** POST /api/admin/affiliate/payouts/[id]/process — payout state machine result payload */
export interface AdminAffProcessData {
  status: string;
  amountMinor: number;
  reference?: string | null;
  reason?: string | null;
}

/** POST /api/admin/affiliate/payouts/[id]/process — payout state machine result */
export type AdminAffProcessResponse = ApiOk<AdminAffProcessData>;

// ============================================================
// §18 Admin — Security (MFA) & Support
// ============================================================

/** POST /api/admin/mfa/enroll — start TOTP enrollment body */
export interface MfaEnrollBody {
  password: string;
}

/** POST /api/admin/mfa/enroll — one-time plaintext enrollment secret payload */
export interface MfaEnrollData {
  secretBase32: string;
  otpauthUrl: string;
}

/** POST /api/admin/mfa/enroll — start TOTP enrollment result */
export type MfaEnrollResponse = ApiOk<MfaEnrollData>;

/** POST /api/admin/mfa/confirm — confirm enrollment body */
export interface MfaConfirmBody {
  password: string;
  code: string;
}

/** POST /api/admin/mfa/confirm — minted recovery codes payload */
export interface MfaConfirmData {
  recoveryCodes: string[];
}

/** POST /api/admin/mfa/confirm — confirm enrollment result */
export type MfaConfirmResponse = ApiOk<MfaConfirmData>;

/** GET /api/admin/mfa/status — own enrollment state payload (no secrets returned) */
export interface AdminMfaStatus {
  enrolled: boolean;
  confirmed: boolean;
}

/** GET /api/admin/mfa/status — own enrollment state */
export type MfaStatusResponse = ApiOk<AdminMfaStatus>;

/** POST /api/admin/mfa/disable — disable MFA body */
export interface MfaDisableBody {
  password: string;
  code: string;
}

/** POST /api/admin/mfa/disable — disable result payload */
export interface MfaDisableData {
  disabled: boolean;
  revokedSessions: number;
}

/** POST /api/admin/mfa/disable — disable MFA result */
export type MfaDisableResponse = ApiOk<MfaDisableData>;

/** GET /api/admin/tickets — query params */
export interface AdminTicketsQuery {
  status?: string;
  page?: number;
  size?: number;
}

/** GET /api/admin/tickets/[id] — ticket store resolution block */
export interface AdminTicketStoreRef {
  id: string;
  name: string;
  slug: string;
}

/** GET /api/admin/tickets/[id] — ticket thread message row */
export interface AdminTicketMessage {
  id: string;
  ticketId: string;
  authorType: string;
  authorLabel: string;
  body: string;
  createdAt: string;
}

/** GET /api/admin/tickets — support ticket queue row */
export interface AdminTicketRow {
  id: string;
  storeId: string | null;
  sellerEmail: string | null;
  subject: string;
  status: string;
  priority: string;
  contextType: string | null;
  contextId: string | null;
  createdAt: string;
  updatedAt: string;
  store: AdminTicketStoreRef | null;
  lastMessage: AdminTicketMessage | null;
  messageCount: number;
}

/** GET /api/admin/tickets — paginated support ticket queue */
export type AdminTicketsResponse = ApiPage<AdminTicketRow[]>;

/** GET /api/admin/tickets/[id] — ticket thread payload */
export interface AdminTicketDetailData {
  id: string;
  storeId: string | null;
  sellerEmail: string | null;
  subject: string;
  status: string;
  priority: string;
  contextType: string | null;
  contextId: string | null;
  createdAt: string;
  updatedAt: string;
  messages: AdminTicketMessage[];
  store: AdminTicketStoreRef | null;
}

/** GET /api/admin/tickets/[id] — ticket thread */
export type AdminTicketDetailResponse = ApiOk<AdminTicketDetailData>;

/** PATCH /api/admin/tickets/[id] — update ticket status/priority body */
export interface AdminTicketPatchBody {
  status?: "open" | "pending" | "closed";
  priority?: "low" | "normal" | "high" | "urgent";
}

/** PATCH /api/admin/tickets/[id] — ticket core fields (also embedded in reply result) */
export interface AdminTicketSummary {
  id: string;
  storeId: string | null;
  sellerEmail: string | null;
  subject: string;
  status: string;
  priority: string;
  contextType: string | null;
  contextId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** PATCH /api/admin/tickets/[id] — update ticket status/priority result */
export type AdminTicketPatchResponse = ApiOk<AdminTicketSummary>;

/** POST /api/admin/tickets/[id]/reply — admin reply body */
export interface AdminTicketReplyBody {
  body: string;
}

/** POST /api/admin/tickets/[id]/reply — admin reply result payload */
export interface AdminTicketReplyData {
  message: AdminTicketMessage;
  ticket: AdminTicketSummary;
}

/** POST /api/admin/tickets/[id]/reply — admin reply result */
export type AdminTicketReplyResponse = ApiOk<AdminTicketReplyData>;

/** GET /api/admin/announcements — announcement row (shared by list/create/update) */
export interface AdminAnnouncementRow {
  id: string;
  title: string;
  body: string | null;
  audience: string;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  createdAt: string;
}

/** GET /api/admin/announcements — all announcements, newest first (unpaginated, no meta) */
export type AdminAnnouncementsResponse = ApiOk<AdminAnnouncementRow[]>;

/** POST /api/admin/announcements — create announcement body */
export interface AnnouncementPostBody {
  title: string;
  body?: string | null;
  audience?: "all" | "sellers" | "admins";
  startsAt?: string | null;
  endsAt?: string | null;
  isActive?: boolean;
}

/** POST /api/admin/announcements — create announcement result */
export type AnnouncementCreatedResponse = ApiOk<AdminAnnouncementRow>;

/** PATCH /api/admin/announcements/[id] — update announcement body */
export interface AnnouncementPatchBody {
  title?: string;
  body?: string;
  audience?: "all" | "sellers" | "admins";
  startsAt?: string | null;
  endsAt?: string | null;
  isActive?: boolean;
}

/** PATCH /api/admin/announcements/[id] — update announcement result */
export type AnnouncementUpdatedResponse = ApiOk<AdminAnnouncementRow>;

// ============================================================
// §19 Admin — Content, Config & Reporting
// ============================================================

/** §19 shared — campaign visual theme (parsed from themeJson) */
export interface AdminCampaignTheme {
  accent: string;
  accentSoft: string;
  gradientFrom: string;
  gradientTo: string;
  greeting: string;
  greetingBm: string;
  tagline: string;
  taglineBm: string;
  ornament: string;
}

/** §19 shared — campaign row with parsed theme, derived status and day countdowns */
export interface AdminCampaignItem {
  id: string;
  name: string;
  description: string | null;
  presetId: string | null;
  themeJson: string;
  isPublished: boolean;
  placement: string;
  priority: number;
  displayOrder: number;
  ctaLabel: string | null;
  ctaHref: string | null;
  bannerDesktopUrl: string | null;
  bannerMobileUrl: string | null;
  thumbnailUrl: string | null;
  productQuery: string | null;
  archivedAt: string | null;
  startAt: string;
  endAt: string;
  createdAt: string;
  updatedAt: string;
  theme: AdminCampaignTheme;
  status: "draft" | "scheduled" | "live" | "ended" | "archived";
  daysUntilStart: number;
  daysLeft: number;
}

/** GET /api/admin/banners — marketplace banner row (shared by list/create/update) */
export interface AdminBannerRow {
  id: string;
  title: string;
  imageUrl: string;
  linkUrl: string | null;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
}

/** GET /api/admin/banners — list banners (unpaginated, no meta) */
export type AdminBannersResponse = ApiOk<AdminBannerRow[]>;

/** POST /api/admin/banners — create banner body */
export interface BannerCreateBody {
  title: string;
  imageUrl?: string;
  linkUrl?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

/** POST /api/admin/banners — create banner result */
export type BannerCreateResponse = ApiOk<AdminBannerRow>;

/** PATCH /api/admin/banners/[id] — update banner body */
export interface BannerUpdateBody {
  title?: string;
  imageUrl?: string;
  linkUrl?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

/** PATCH /api/admin/banners/[id] — update banner result */
export type BannerUpdateResponse = ApiOk<AdminBannerRow>;

/** DELETE /api/admin/banners/[id] — hard-delete ack payload */
export interface AdminBannerDeleteData {
  deleted: true;
}

/** DELETE /api/admin/banners/[id] — hard-delete ack */
export type BannerDeleteResponse = ApiOk<AdminBannerDeleteData>;

/** GET /api/admin/categories — category tree node */
export interface AdminCategoryNode {
  id: string;
  name: string;
  slug: string;
  commissionPercent: number | null;
  imageUrl: string | null;
  sortOrder: number;
  productCount: number;
  children: AdminCategoryNode[];
}

/** GET /api/admin/categories — full category tree (unpaginated, no meta) */
export type AdminCategoriesResponse = ApiOk<AdminCategoryNode[]>;

/** POST /api/admin/categories — create category body */
export interface CategoryCreateBody {
  name: string;
  parentId?: string | null;
  commissionPercent?: number;
}

/** POST/PATCH /api/admin/categories — category record (create/update result payload) */
export interface AdminCategoryDetail {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  commissionPercent: number | null;
  imageUrl: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/admin/categories — create category result */
export type CategoryCreateResponse = ApiOk<AdminCategoryDetail>;

/** PATCH /api/admin/categories/[id] — update category body */
export interface CategoryUpdateBody {
  name?: string;
  commissionPercent?: number | null;
  sortOrder?: number;
}

/** PATCH /api/admin/categories/[id] — update category result */
export type CategoryUpdateResponse = ApiOk<AdminCategoryDetail>;

/** DELETE /api/admin/categories/[id] — hard-delete ack payload */
export interface AdminCategoryDeleteData {
  deleted: true;
}

/** DELETE /api/admin/categories/[id] — hard-delete ack */
export type CategoryDeleteResponse = ApiOk<AdminCategoryDeleteData>;

/** GET /api/admin/coupons — query params */
export interface AdminCouponsQuery {
  page?: number;
  size?: number;
  scope?: string;
}

/** POST/PATCH /api/admin/coupons — coupon record (create/update result payload) */
export interface AdminCouponDetail {
  id: string;
  scope: string;
  storeId: string | null;
  code: string;
  description: string | null;
  type: string;
  percent: number | null;
  amountMinor: number | null;
  minSpendMinor: number;
  maxRedemptions: number | null;
  perCustomerLimit: number;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  timesUsed: number;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/admin/coupons — coupon list row (coupon record + store join) */
export interface AdminCouponRow extends AdminCouponDetail {
  store: { id: string; name: string } | null;
}

/** GET /api/admin/coupons — paged coupon list */
export type AdminCouponsResponse = ApiPage<AdminCouponRow[]>;

/** POST /api/admin/coupons — create coupon body */
export interface CouponCreateBody {
  code: string;
  type?: "percent" | "fixed" | "freeship";
  percent?: number;
  amountMinor?: number;
  storeId?: string | null;
  description?: string | null;
  minSpendMinor?: number;
  maxRedemptions?: number | null;
  perCustomerLimit?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  isActive?: boolean;
}

/** POST /api/admin/coupons — create coupon result */
export type CouponCreateResponse = ApiOk<AdminCouponDetail>;

/** PATCH /api/admin/coupons/[id] — update coupon body */
export interface CouponUpdateBody {
  description?: string;
  percent?: number;
  amountMinor?: number;
  minSpendMinor?: number;
  maxRedemptions?: number;
  perCustomerLimit?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  isActive?: boolean;
}

/** PATCH /api/admin/coupons/[id] — update coupon result */
export type CouponUpdateResponse = ApiOk<AdminCouponDetail>;

/** DELETE /api/admin/coupons/[id] — hard-delete ack payload */
export interface AdminCouponDeleteData {
  deleted: true;
}

/** DELETE /api/admin/coupons/[id] — hard-delete ack */
export type CouponDeleteResponse = ApiOk<AdminCouponDeleteData>;

/** GET /api/admin/campaigns — query params */
export interface AdminCampaignsQuery {
  page?: number;
  size?: number;
  status?: string;
  placement?: string;
  q?: string;
}

/** GET /api/admin/campaigns — paged campaigns list */
export type AdminCampaignsResponse = ApiPage<AdminCampaignItem[]>;

/** POST /api/admin/campaigns — create campaign body */
export interface CampaignCreateBody {
  name: string;
  presetId?: string | null;
  startAt?: string;
  endAt?: string;
  theme?: AdminCampaignTheme;
  isPublished?: boolean;
  description?: string | null;
  placement?: string;
  priority?: number;
  displayOrder?: number;
  ctaLabel?: string | null;
  ctaHref?: string | null;
  bannerDesktopUrl?: string | null;
  bannerMobileUrl?: string | null;
  thumbnailUrl?: string | null;
  productQuery?: string | null;
}

/** POST /api/admin/campaigns — create campaign result */
export type CampaignCreateResponse = ApiOk<AdminCampaignItem>;

/** PATCH /api/admin/campaigns/[id] — update/publish/archive campaign body */
export interface CampaignUpdateBody {
  publish?: boolean;
  isPublished?: boolean;
  name?: string;
  presetId?: string | null;
  startAt?: string;
  endAt?: string;
  theme?: AdminCampaignTheme;
  archived?: boolean;
  description?: string | null;
  placement?: string;
  priority?: number;
  displayOrder?: number;
  ctaLabel?: string | null;
  ctaHref?: string | null;
  bannerDesktopUrl?: string | null;
  bannerMobileUrl?: string | null;
  thumbnailUrl?: string | null;
  productQuery?: string | null;
}

/** PATCH /api/admin/campaigns/[id] — update/publish/archive campaign result */
export type CampaignUpdateResponse = ApiOk<AdminCampaignItem>;

/** DELETE /api/admin/campaigns/[id] — hard-delete ack payload */
export interface AdminCampaignDeleteData {
  deleted: true;
}

/** DELETE /api/admin/campaigns/[id] — hard-delete ack */
export type CampaignDeleteResponse = ApiOk<AdminCampaignDeleteData>;

/** POST /api/admin/campaign-media — multipart/form-data image upload body */
export interface CampaignMediaBody {
  file: File;
}

/** POST /api/admin/campaign-media — uploaded campaign image payload */
export interface CampaignMediaData {
  url: string;
  bytes: number;
  mime: string;
}

/** POST /api/admin/campaign-media — uploaded campaign image result */
export type CampaignMediaResponse = ApiOk<CampaignMediaData>;

/** GET /api/admin/featured — featured slot row */
export interface AdminFeaturedRow {
  id: string;
  slot: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  product: { id: string; title: string; slug: string; priceMinor: number; status: string; imageUrl: string | null; storeName: string; storeSlug: string };
}

/** GET /api/admin/featured — list featured slots (unpaginated, no meta) */
export type AdminFeaturedResponse = ApiOk<AdminFeaturedRow[]>;

/** POST /api/admin/featured — add featured slot body */
export interface FeaturedCreateBody {
  productId: string;
  slot?: string;
  sortOrder?: number;
}

/** POST /api/admin/featured — add featured slot result payload */
export interface FeaturedCreateData {
  id: string;
  productId: string;
  slot: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
}

/** POST /api/admin/featured — add featured slot result */
export type FeaturedCreateResponse = ApiOk<FeaturedCreateData>;

/** DELETE /api/admin/featured/[id] — hard-delete ack payload */
export interface AdminFeaturedDeleteData {
  deleted: true;
}

/** DELETE /api/admin/featured/[id] — hard-delete ack */
export type FeaturedDeleteResponse = ApiOk<AdminFeaturedDeleteData>;

/** GET/PUT /api/admin/featured-stores — featured stores payload */
export interface AdminFeaturedStoresData {
  key: string;
  stores: { id: string; name: string; slug: string; tagline: string | null; logoUrl: string | null; productCount: number; status: string }[];
}

/** GET /api/admin/featured-stores — list featured stores */
export type AdminFeaturedStoresResponse = ApiOk<AdminFeaturedStoresData>;

/** PUT /api/admin/featured-stores — replace featured stores body */
export interface FeaturedStoresPutBody {
  storeIds: string[];
}

/** PUT /api/admin/featured-stores — replace featured stores result */
export type FeaturedStoresPutResponse = ApiOk<AdminFeaturedStoresData>;

/** GET /api/admin/home-layout — homepage layout payload */
export interface HomeLayoutData {
  order: string[];
  defaults: string[];
  sections: { id: string; label: string; description: string; requires: string }[];
}

/** GET /api/admin/home-layout — homepage layout */
export type HomeLayoutResponse = ApiOk<HomeLayoutData>;

/** PUT /api/admin/home-layout — set homepage order body */
export interface HomeLayoutPutBody {
  order: string[];
}

/** PUT /api/admin/home-layout — saved normalized order payload */
export interface HomeLayoutPutData {
  order: string[];
}

/** PUT /api/admin/home-layout — set homepage order result */
export type HomeLayoutPutResponse = ApiOk<HomeLayoutPutData>;

/** GET /api/admin/reports/[type] — query params */
export interface AdminReportsQuery {
  days?: number;
}

/** GET /api/admin/reports/[type] — daily series point (sales & commission reports) */
export interface AdminReportSeries {
  date: string;
  gmvMinor: number;
  orders: number;
  commissionMinor: number;
}

/** GET /api/admin/reports/sales — sales report payload */
export interface AdminReportSalesData {
  series: AdminReportSeries[];
  totals: { gmvMinor: number; orders: number; commissionMinor: number; aovMinor: number };
  days: number;
}

/** GET /api/admin/reports/sellers — sellers report payload */
export interface AdminReportSellersData {
  rows: { storeName: string; gmvMinor: number; orders: number; commissionMinor: number; aovMinor: number }[];
  totals: { gmvMinor: number; orders: number; commissionMinor: number; stores: number };
  days: number;
}

/** GET /api/admin/reports/commission — commission report payload */
export interface AdminReportCommissionData {
  series: AdminReportSeries[];
  byCategory: { categoryName: string; commissionMinor: number }[];
  effectiveRate: number;
  totals: { commissionMinor: number; gmvMinor: number; items: number; itemsValueMinor: number };
  days: number;
}

/** GET /api/admin/reports/payouts — payout batches report payload */
export interface AdminReportPayoutsData {
  batches: { id: string; runType: string; status: string; totalMinor: number; payoutCount: number; startedAt: string; finishedAt: string | null; payouts: { id: string; referenceNo: string; sellerName: string; amountMinor: number; status: string; method: string; paidAt: string | null }[] }[];
  totals: { totalMinor: number; count: number; paidMinor: number; processingMinor: number; failedMinor: number; batchCount: number };
  days: number;
}

/** GET /api/admin/reports/[type] — analytics report (variant depends on type) */
export type AdminReportResponse = ApiOk<AdminReportSalesData | AdminReportSellersData | AdminReportCommissionData | AdminReportPayoutsData>;

/** GET /api/admin/export — query params */
export interface AdminExportQuery {
  entity?: string;
}

// GET /api/admin/export — non-envelope: raw text/csv; charset=utf-8 attachment download (orders.csv | sellers.csv | ledger.csv; orders/sellers capped at 500 rows, ledger at 3000 lines)

/** GET /api/admin/audit-logs — query params */
export interface AdminAuditLogsQuery {
  page?: number;
  size?: number;
  adminEmail?: string;
  action?: string;
  entityType?: string;
}

/** GET /api/admin/audit-logs — audit log row (before/after JSON parsed) */
export interface AdminAuditLogRow {
  id: string;
  adminId: string;
  adminEmail: string;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

/** GET /api/admin/audit-logs — paged admin audit trail */
export type AuditLogsResponse = ApiPage<AdminAuditLogRow[]>;

/** GET /api/admin/activity-logs — query params */
export interface AdminActivityLogsQuery {
  page?: number;
  size?: number;
  actorType?: string;
  action?: string;
}

/** GET /api/admin/activity-logs — activity log row (meta JSON parsed) */
export interface AdminActivityLogRow {
  id: string;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  meta: unknown;
  createdAt: string;
}

/** GET /api/admin/activity-logs — paged activity trail */
export type ActivityLogsResponse = ApiPage<AdminActivityLogRow[]>;

/** GET /api/admin/activity-logs/purge — purge count payload */
export interface PurgeCountData {
  total: number;
  byActor: { actorType: string; count: number }[];
}

/** GET /api/admin/activity-logs/purge — purge count */
export type PurgeCountResponse = ApiOk<PurgeCountData>;

/** POST /api/admin/activity-logs/purge — purge body (password re-verification) */
export interface PurgeBody {
  password: string;
}

/** POST /api/admin/activity-logs/purge — purge result payload */
export interface PurgeData {
  deleted: number;
  remaining: number;
}

/** POST /api/admin/activity-logs/purge — purge result */
export type PurgeResponse = ApiOk<PurgeData>;

/** GET /api/admin/webhook-deliveries — query params */
export interface AdminWebhookDeliveriesQuery {
  page?: number;
  size?: number;
  status?: string;
  endpointId?: string;
  event?: string;
}

/** GET /api/admin/webhook-deliveries — webhook delivery row */
export interface AdminWebhookDeliveryRow {
  id: string;
  event: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  responseCode: number | null;
  lastAttemptAt: string | null;
  createdAt: string;
  nextRetryAt: string | null;
  endpoint: { id: string; url: string; isActive: boolean };
  store: { id: string; name: string } | null;
  lastError: string | null;
  lastResponseBody: string | null;
  lastAttemptSigned: boolean | null;
  replayPath: string | null;
}

/** GET /api/admin/webhook-deliveries — paged webhook delivery list */
export type AdminWebhookDeliveriesResponse = ApiPage<AdminWebhookDeliveryRow[]>;

/** POST /api/admin/webhook-deliveries/[id]/replay — replay outcome payload */
export interface AdminReplayData {
  replayed: boolean;
  deliveryId: string;
  status: string;
  attempts: number;
  responseCode: number | null;
  error: string | null;
  responseBody: string | null;
  durationMs: number | null;
  nextRetryAt: string | null;
  endpointUrl: string;
  storeName: string;
}

/** POST /api/admin/webhook-deliveries/[id]/replay — replay outcome */
export type AdminReplayResponse = ApiOk<AdminReplayData>;

/** GET /api/admin/feature-flags — feature flag row */
export interface AdminFeatureFlagRow {
  key: string;
  description: string | null;
  isEnabled: boolean;
  rolloutPercent: number;
}

/** GET /api/admin/feature-flags — list feature flags (unpaginated, no meta) */
export type AdminFeatureFlagsResponse = ApiOk<AdminFeatureFlagRow[]>;

/** PATCH /api/admin/feature-flags — upsert feature flag body */
export interface FeatureFlagPatchBody {
  key: string;
  isEnabled?: boolean;
  rolloutPercent?: number;
  description?: string;
}

/** PATCH /api/admin/feature-flags — upserted flag payload */
export interface FeatureFlagPatchData {
  key: string;
  description: string | null;
  isEnabled: boolean;
  rolloutPercent: number;
}

/** PATCH /api/admin/feature-flags — upsert feature flag result */
export type FeatureFlagPatchResponse = ApiOk<FeatureFlagPatchData>;

/** GET /api/admin/notifications — notification log row (latest 100) */
export interface AdminNotificationRow {
  id: string;
  event: string;
  channel: string;
  recipient: string;
  subject: string | null;
  status: string;
  error: string | null;
  createdAt: string;
  dedupKey: string | null;
}

/** GET /api/admin/notifications — notification log list (unpaginated, capped 100) */
export type AdminNotificationsResponse = ApiOk<AdminNotificationRow[]>;

/** GET /api/admin/system/health — wallet cache-vs-ledger drift record */
export interface WalletDrift {
  walletId: string;
  cachedAvailable: number;
  cachedPending: number;
  truthAvailable: number;
  truthPending: number;
  availableDelta: number;
  pendingDelta: number;
  maturedSinceLastWrite: number;
  lastCacheWriteAt: string;
}

/** GET /api/admin/system/health — system health payload */
export interface AdminHealthData {
  status: "healthy" | "degraded";
  db: "up";
  counts: { sellers: number; stores: number; products: number; orders: number };
  paymentReconciliation: { requested: number; processing: number; succeeded: number; failed: number; unknown: number };
  ledger: { ok: boolean; problems: string[]; txnCount: number; walletCount: number; hardDrift: WalletDrift[]; timeMaturityStale: WalletDrift[] };
  recentAudit: { id: string; adminId: string; adminEmail: string; action: string; entityType: string; entityId: string | null; beforeJson: string | null; afterJson: string | null; createdAt: string }[];
}

/** GET /api/admin/system/health — system health */
export type AdminHealthResponse = ApiOk<AdminHealthData>;

/** GET /api/admin/dashboard — dashboard KPI payload */
export interface AdminDashboardData {
  gmvTodayMinor: number;
  ordersToday: number;
  commissionTodayMinor: number;
  activeStores: number;
  pendingKyc: number;
  productsToModerate: number;
  refundsQueue: number;
  disputesOpen: number;
  payoutsDueMinor: number;
  payoutsDueSellers: number;
  gmvSeries30d: { date: string; gmvMinor: number; orders: number }[];
  topStores: { storeName: string; gmv30dMinor: number; orders30d: number }[];
  recentSellers: { id: string; displayName: string; storeName: string | null; status: string; createdAt: string }[];
}

/** GET /api/admin/dashboard — dashboard KPIs */
export type AdminDashboardResponse = ApiOk<AdminDashboardData>;

/** GET /api/admin/settings — settings row merged with registry meta */
export interface AdminSettingsRow {
  key: string;
  valueJson: string;
  description: string | null;
  updatedAt: string | null;
  meta: {
    key: string;
    group: string;
    label: string;
    description: string;
    field: { kind: "boolean" | "integer" | "enum" | "string" | "weights" | "string_list" | "readonly" | "json" } & Record<string, unknown>;
    wired: boolean;
    wiredNote?: string;
    danger?: boolean;
    hidden?: boolean;
  };
}

/** GET /api/admin/settings — list settings (unpaginated, no meta) */
export type AdminSettingsResponse = ApiOk<AdminSettingsRow[]>;

/** PUT /api/admin/settings — bulk settings upsert body */
export interface SettingsPutBody {
  settings: { key: string; valueJson: string | unknown }[];
}

/** PUT /api/admin/settings — updated settings row */
export interface AdminSettingsPutRow {
  key: string;
  valueJson: string;
  description: string | null;
  updatedAt: string;
}

/** PUT /api/admin/settings — update settings result */
export type SettingsPutResponse = ApiOk<AdminSettingsPutRow[]>;
