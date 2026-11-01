// ============================================================================
// WEBHOOK DELIVERY ENGINE — C2.8 (Phase 2.3: real seller webhook delivery)
// ----------------------------------------------------------------------------
// BEFORE: dispatchStoreWebhooks (lib/api.ts) wrote WebhookDelivery rows with
// status:"success", attempts:1, responseCode:200 WITHOUT any HTTP request —
// simulated success records that lied to sellers and admins.
//
// NOW: every WebhookDelivery row is delivered for real through this engine.
//   • dispatchStoreWebhooks — creates PENDING rows for matching endpoints and
//     fires the first attempt inline (best-effort, catch-all, parallel across
//     endpoints); it NEVER throws and NEVER writes success without a real 2xx.
//   • deliverWebhookDelivery — one delivery attempt: atomic claim → SSRF-
//     guarded signed POST (lib/safe-fetch.ts) → real response recorded.
//   • sweepDueWebhookDeliveries — the retry rail; invoked by
//     /api/cron/webhook-delivery (scheduler: mini-services/expiry-scheduler).
//
// STATE MACHINE (WebhookDelivery.status — EXISTING columns only):
//   pending ──2xx──▶ success (TERMINAL; only a real accepted response)
//   pending ──non-2xx / network error──▶ pending (retry on the backoff
//        schedule below) ──attempts == 8──▶ failed (TERMINAL)
//   pending ──endpoint event unsubscribed──▶ failed (no HTTP attempt;
//        deterministic — the seller removed the event from the endpoint)
//   pending ──older than 7 days (paused endpoint etc.)──▶ failed (stale)
//   failed ──admin replay (force claim)──▶ pending → real attempt again
//   success is terminal and is NEVER re-attempted or overwritten.
//
// RETRY SCHEDULE (deterministic — derived, no nextAttemptAt column needed):
//   attempt 1 immediate (inline), then backoff after failures:
//   1m → 5m → 15m → 1h → 4h → 12h → 24h (cap) — 8 attempts total, ≈41.4h
//   horizon. nextRetryAt = lastAttemptAt + BACKOFF[attempts]; a row that has
//   never been attempted (lastAttemptAt null) is due immediately.
//
// WHY NO NEW COLUMNS ON WebhookDelivery: the dev database is intentionally
// un-migrated (dev.log shows `EmailOtpChallenge does not exist` — the running
// environment lags the authored migrations), and WebhookDelivery has
// default-select read sites on seller/admin paths (GET /api/store/webhooks
// `include: { deliveries: … }`). Additive columns would 500 those routes AND
// make every write from the live payment path fail with P2022. The schedule
// above is a pure function of (attempts, lastAttemptAt), so it needs no
// column; per-attempt audit records (error/response body/duration) live in
// the NEW WebhookDeliveryAttempt table (additive — safe), and every access to
// that table degrades gracefully while its migration is pending.
//
// ============================================================================
// RECEIVER VERIFICATION CONTRACT (for sellers — mirrored in the seller UI
// and the cron route comment):
//   POST {endpoint.url}
//     content-type:        application/json
//     user-agent:          SHOPMESH-Webhooks/1.0
//     x-nomofee-event:     <event name, e.g. "order.paid">
//     x-nomofee-timestamp: <unix seconds at send time>
//     x-nomofee-signature: <lowercase hex HMAC-SHA256 of
//                           `${x-nomofee-timestamp}.${rawBody}` using the
//                           endpoint's signing secret>
//   The signature header is OMITTED when the endpoint has no secret
//   configured — such deliveries are unsigned and receivers should treat
//   them as unauthenticated notifications.
//   Recommended verification:
//     1. recompute HMAC-SHA256(secret, `${timestamp}.${rawBody}`) over the
//        RAW request body (byte-exact — before any JSON re-serialization)
//        and timing-safely compare with x-nomofee-signature;
//     2. reject if |now − x-nomofee-timestamp| > 600 s (±10 min replay
//        window; the timestamp is INSIDE the signed material, so an attacker
//        cannot refresh it without invalidating the signature);
//     3. dispatch on x-nomofee-event; respond 2xx quickly — anything else
//        (or a >10 s timeout) is retried on the schedule above.
// ============================================================================
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "./db";
import { parseJson } from "./json";
import { safeRequestJson } from "./safe-fetch";

// ---------------------------------------------------------------- constants

/** Delivery attempt timeout (per hop; redirects are re-validated + re-POSTed). */
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** Total attempts (initial inline attempt + 7 retries). */
export const MAX_WEBHOOK_ATTEMPTS = 8;
/** Backoff AFTER a failed attempt N (index = completed attempts): 1m, 5m,
 *  15m, 1h, 4h, 12h, 24h cap. Index 0 = immediate (never-attempted rows). */
export const WEBHOOK_BACKOFF_SCHEDULE_MS: readonly number[] = [
  0,
  60_000,
  300_000,
  900_000,
  3_600_000,
  14_400_000,
  43_200_000,
  86_400_000,
];
/** Receiver-side replay window we document (±10 minutes). */
export const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 10 * 60_000;
/** Minimum spacing enforced by the atomic claim (matches the shortest
 *  non-zero backoff): a row can be attempted at most once per minute, and a
 *  racing sweep/inline/replay claim loses atomically. */
const WEBHOOK_CLAIM_SPACING_MS = 60_000;
/** Pending rows older than this are failed as abandoned (paused endpoint
 *  etc.) — far past the ≈41.4 h retry horizon. */
const WEBHOOK_STALE_PENDING_MS = 7 * 24 * 60 * 60_000;
/** Synthetic event used by the seller "Send test" action; always deliverable
 *  regardless of the endpoint's subscription list (it IS an explicit test). */
export const WEBHOOK_TEST_EVENT = "webhook.test";

const WEBHOOK_USER_AGENT = "SHOPMESH-Webhooks/1.0";
export const WEBHOOK_SIGNATURE_HEADER = "x-nomofee-signature";
export const WEBHOOK_TIMESTAMP_HEADER = "x-nomofee-timestamp";
export const WEBHOOK_EVENT_HEADER = "x-nomofee-event";

// ---------------------------------------------------------------- schedule (pure)

export function webhookBackoffMs(attemptsCompleted: number): number {
  const idx = Math.max(0, Math.min(attemptsCompleted, WEBHOOK_BACKOFF_SCHEDULE_MS.length - 1));
  return WEBHOOK_BACKOFF_SCHEDULE_MS[idx];
}

/** Derived next-retry time: lastAttemptAt + backoff[attempts]; never-attempted
 *  rows are due immediately; exhausted rows have no next retry (terminal). */
export function webhookNextRetryAt(attempts: number, lastAttemptAt: Date | null, now = new Date()): Date | null {
  if (attempts >= MAX_WEBHOOK_ATTEMPTS) return null;
  if (!lastAttemptAt) return now;
  return new Date(lastAttemptAt.getTime() + webhookBackoffMs(attempts));
}

// ---------------------------------------------------------------- signing (pure)

/** HMAC-SHA256 over `${timestamp}.${rawBody}` — the timestamp is signed so
 *  receivers can enforce the ±10 min window without it being forgeable. */
export function signWebhookBody(secret: string, rawBody: string, timestampSeconds: string): string {
  return createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex");
}

/** Build the outbound header set for one delivery attempt. `secret == null`
 *  ⇒ unsigned delivery (signature header omitted — documented contract). */
export function buildWebhookHeaders(event: string, rawBody: string, secret: string | null, nowMs = Date.now()): Record<string, string> {
  const timestamp = String(Math.floor(nowMs / 1000));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": WEBHOOK_USER_AGENT,
    [WEBHOOK_EVENT_HEADER]: event,
    [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
  };
  if (secret) headers[WEBHOOK_SIGNATURE_HEADER] = signWebhookBody(secret, rawBody, timestamp);
  return headers;
}

/** Receiver-side verifier for the contract above (pure; used by the
 *  verification script and as reference for sellers). Validation order:
 *  signature format → timestamp format → HMAC (timing-safe) → ±10 min
 *  staleness — input-shape errors are reported before crypto runs. */
export type WebhookVerifyResult = { valid: true } | { valid: false; reason: "BAD_SIGNATURE" | "STALE_TIMESTAMP" | "BAD_TIMESTAMP" };
export function verifyWebhookSignature(input: {
  secret: string;
  rawBody: string;
  timestamp: string;
  signature: string;
  nowMs?: number;
}): WebhookVerifyResult {
  const sig = input.signature.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sig)) return { valid: false, reason: "BAD_SIGNATURE" };
  if (!/^\d+$/.test(input.timestamp)) return { valid: false, reason: "BAD_TIMESTAMP" };
  const expected = createHmac("sha256", input.secret).update(`${input.timestamp}.${input.rawBody}`).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(sig, "hex");
  } catch {
    return { valid: false, reason: "BAD_SIGNATURE" };
  }
  if (provided.length !== expected.length || !timingSafeEqual(expected, provided)) {
    return { valid: false, reason: "BAD_SIGNATURE" };
  }
  const ts = Number(input.timestamp) * 1000;
  const now = input.nowMs ?? Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > WEBHOOK_TIMESTAMP_TOLERANCE_MS) {
    return { valid: false, reason: "STALE_TIMESTAMP" };
  }
  return { valid: true };
}

// ---------------------------------------------------------------- helpers

function errShort(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** SSRF refusals and malformed endpoint URLs are deterministic — retrying a
 *  blocked target for 41 hours is pointless, so such errors fail the
 *  delivery immediately (attempts stay honest: the refusal IS recorded). */
const PERMANENT_DELIVERY_REASONS = new Set(["INVALID_URL", "SCHEME", "CREDENTIALS", "PRIVATE_HOST"]);
export function isPermanentDeliveryError(reason: string): boolean {
  if (PERMANENT_DELIVERY_REASONS.has(reason)) return true;
  // dns-guard refusals surface inside NETWORK messages under Bun/Node
  return reason.includes("EPRIVATEADDRESS") || reason.includes("Blocked resolution");
}

/** Is this Prisma/runtime error the "migration not applied / stale client"
 *  shape? Used to degrade the attempt-log table access silently. */
function isMissingSchemaError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  if (code === "P2021" || code === "P2022") return true; // table/column does not exist
  return e instanceof TypeError; // stale in-memory client: model accessor undefined
}

let attemptLogBroken = false;

/** Best-effort per-attempt audit row (WebhookDeliveryAttempt — NEW table,
 *  migration authored but NOT applied in this environment). Absence never
 *  affects the delivery state machine: status/attempts/responseCode/
 *  lastAttemptAt on WebhookDelivery remain the authoritative record. */
async function recordAttemptLog(data: {
  deliveryId: string;
  attemptNo: number;
  trigger: string;
  responseCode: number | null;
  error: string | null;
  responseBody: string | null;
  durationMs: number | null;
  signed: boolean;
}): Promise<void> {
  if (attemptLogBroken) return;
  try {
    await db.webhookDeliveryAttempt.create({
      data: {
        deliveryId: data.deliveryId,
        attemptNo: data.attemptNo,
        trigger: data.trigger,
        responseCode: data.responseCode,
        error: data.error ? data.error.slice(0, 500) : null,
        responseBody: data.responseBody ? data.responseBody.slice(0, 2000) : null,
        durationMs: data.durationMs,
        signed: data.signed,
      },
      select: { id: true },
    });
  } catch (e) {
    if (isMissingSchemaError(e)) {
      attemptLogBroken = true;
      console.warn("[webhook-delivery] attempt log unavailable (migration 20261108000000_phase23_webhook_delivery not applied) — delivery states remain authoritative");
    } else {
      console.error("[webhook-delivery] attempt log write failed:", errShort(e));
    }
  }
}

/** Latest per-attempt audit rows for a set of deliveries (admin visibility).
 *  Returns {} when the table/migration is unavailable — callers degrade to
 *  the delivery columns. */
export async function latestAttemptLogs(deliveryIds: string[]): Promise<Map<string, { responseCode: number | null; error: string | null; responseBody: string | null; attemptNo: number; signed: boolean; at: Date }>> {
  const out = new Map<string, { responseCode: number | null; error: string | null; responseBody: string | null; attemptNo: number; signed: boolean; at: Date }>();
  if (deliveryIds.length === 0 || attemptLogBroken) return out;
  try {
    const rows = await db.webhookDeliveryAttempt.findMany({
      where: { deliveryId: { in: deliveryIds } },
      orderBy: [{ deliveryId: "asc" }, { attemptNo: "desc" }],
      select: { deliveryId: true, attemptNo: true, responseCode: true, error: true, responseBody: true, signed: true, createdAt: true },
    });
    for (const r of rows) if (!out.has(r.deliveryId)) out.set(r.deliveryId, { responseCode: r.responseCode, error: r.error, responseBody: r.responseBody, attemptNo: r.attemptNo, signed: r.signed, at: r.createdAt });
  } catch (e) {
    if (isMissingSchemaError(e)) attemptLogBroken = true;
    else console.error("[webhook-delivery] attempt log read failed:", errShort(e));
  }
  return out;
}

// ---------------------------------------------------------------- one attempt

export type WebhookDeliveryOutcome = {
  deliveryId: string;
  /** false ⇒ no HTTP attempt was made this call (skipped / claimed elsewhere). */
  attempted: boolean;
  skipReason?: "not_found" | "terminal_success" | "terminal_failed" | "endpoint_inactive" | "event_unsubscribed" | "not_due" | "claimed_elsewhere";
  status: "pending" | "success" | "failed";
  attempts: number;
  /** REAL HTTP status of THIS attempt — null when no response arrived. */
  responseCode: number | null;
  error: string | null;
  responseBody: string | null;
  durationMs: number | null;
  nextRetryAt: string | null;
  signed: boolean;
};

/** Attempt one webhook delivery for real.
 *
 * Idempotency: an ATOMIC conditional claim (status pending + lastAttemptAt
 * spacing, or status pending|failed for a forced replay) increments `attempts`
 * and stamps `lastAttemptAt` BEFORE the HTTP call — a racing sweep/inline/
 * replay claim gets count 0 and skips, so a row is attempted at most once per
 * claim-spacing window. Success is terminal (checked up front AND the final
 * write is conditional on our own claim), and it is only ever written for a
 * REAL 2xx response. */
export async function deliverWebhookDelivery(
  deliveryId: string,
  opts: { trigger?: "inline" | "sweep" | "replay" | "test"; force?: boolean; timeoutMs?: number } = {}
): Promise<WebhookDeliveryOutcome> {
  const trigger = opts.trigger ?? "sweep";
  const force = opts.force === true;
  const now = new Date();

  const delivery = await db.webhookDelivery.findUnique({
    where: { id: deliveryId },
    select: {
      id: true,
      status: true,
      attempts: true,
      lastAttemptAt: true,
      event: true,
      payloadJson: true,
      responseCode: true,
      endpoint: { select: { id: true, url: true, secret: true, isActive: true, eventsJson: true } },
    },
  });
  if (!delivery) {
    return { deliveryId, attempted: false, skipReason: "not_found", status: "pending", attempts: 0, responseCode: null, error: null, responseBody: null, durationMs: null, nextRetryAt: null, signed: false };
  }
  if (delivery.status === "success") {
    return { deliveryId, attempted: false, skipReason: "terminal_success", status: "success", attempts: delivery.attempts, responseCode: delivery.responseCode ?? null, error: null, responseBody: null, durationMs: null, nextRetryAt: null, signed: false };
  }
  if (delivery.status === "failed" && !force) {
    return { deliveryId, attempted: false, skipReason: "terminal_failed", status: "failed", attempts: delivery.attempts, responseCode: null, error: null, responseBody: null, durationMs: null, nextRetryAt: null, signed: false };
  }

  // Endpoint guards. A PAUSED endpoint leaves rows pending (the seller may
  // re-enable); an endpoint whose event list no longer covers this event can
  // never be delivered → fail the row without an HTTP attempt (honest: it is
  // failed, never faked-success). The synthetic test event always passes.
  if (!delivery.endpoint) {
    await db.webhookDelivery
      .updateMany({ where: { id: delivery.id, status: "pending" }, data: { status: "failed" } })
      .catch((e) => console.error("[webhook-delivery] endpoint_missing transition failed:", errShort(e)));
    await recordAttemptLog({ deliveryId: delivery.id, attemptNo: 0, trigger, responseCode: null, error: "endpoint_missing", responseBody: null, durationMs: null, signed: false });
    return { deliveryId, attempted: false, skipReason: "not_found", status: "failed", attempts: delivery.attempts, responseCode: null, error: "endpoint_missing", responseBody: null, durationMs: null, nextRetryAt: null, signed: false };
  }
  if (!delivery.endpoint.isActive && !force) {
    const due = webhookNextRetryAt(delivery.attempts, delivery.lastAttemptAt, now);
    return { deliveryId, attempted: false, skipReason: "endpoint_inactive", status: "pending", attempts: delivery.attempts, responseCode: null, error: null, responseBody: null, durationMs: null, nextRetryAt: due ? due.toISOString() : null, signed: false };
  }
  const subscribed = parseJson<string[]>(delivery.endpoint.eventsJson, []);
  if (delivery.event !== WEBHOOK_TEST_EVENT && !subscribed.includes(delivery.event)) {
    await db.webhookDelivery
      .updateMany({ where: { id: delivery.id, status: "pending" }, data: { status: "failed" } })
      .catch((e) => console.error("[webhook-delivery] event_unsubscribed transition failed:", errShort(e)));
    await recordAttemptLog({ deliveryId: delivery.id, attemptNo: 0, trigger, responseCode: null, error: "event_unsubscribed", responseBody: null, durationMs: null, signed: false });
    return { deliveryId, attempted: false, skipReason: "event_unsubscribed", status: "failed", attempts: delivery.attempts, responseCode: null, error: "event_unsubscribed", responseBody: null, durationMs: null, nextRetryAt: null, signed: false };
  }

  // Derived-schedule due check (skipped for forced replays).
  if (!force) {
    const due = webhookNextRetryAt(delivery.attempts, delivery.lastAttemptAt, now);
    if (due && due.getTime() > now.getTime()) {
      return { deliveryId, attempted: false, skipReason: "not_due", status: "pending", attempts: delivery.attempts, responseCode: null, error: null, responseBody: null, durationMs: null, nextRetryAt: due.toISOString(), signed: false };
    }
  }

  // Atomic claim — the conditional WHERE makes double-attempt impossible:
  // after ANY successful claim lastAttemptAt is "now", which fails both the
  // null branch and the ≤ now−60 s branch for every competing claimer.
  const claim = await db.webhookDelivery.updateMany({
    where: force
      ? { id: delivery.id, status: { in: ["pending", "failed"] } }
      : { id: delivery.id, status: "pending", OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lte: new Date(Date.now() - WEBHOOK_CLAIM_SPACING_MS) } }] },
    data: { status: "pending", attempts: { increment: 1 }, lastAttemptAt: now },
  });
  if (claim.count === 0) {
    // The row's status is one of the three documented states (state machine
    // in the model comment) — narrow for the outcome literal type.
    const status = delivery.status as "pending" | "failed" | "success";
    return { deliveryId, attempted: false, skipReason: "claimed_elsewhere", status, attempts: delivery.attempts, responseCode: null, error: null, responseBody: null, durationMs: null, nextRetryAt: null, signed: false };
  }
  const attemptNo = delivery.attempts + 1;

  // ---- the REAL outbound attempt (SSRF-guarded, signed, 10 s timeout) ----
  const secret = delivery.endpoint.secret && delivery.endpoint.secret.trim() ? delivery.endpoint.secret : null;
  const headers = buildWebhookHeaders(delivery.event, delivery.payloadJson, secret);
  const t0 = performance.now();
  const res = await safeRequestJson(delivery.endpoint.url, {
    method: "POST",
    headers,
    body: delivery.payloadJson,
    timeoutMs: opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS,
  });
  const durationMs = Math.round(performance.now() - t0);

  const gotResponse = res.ok;
  const responseCode = gotResponse ? res.status : null;
  const isSuccess = gotResponse && res.status >= 200 && res.status < 300;
  const error = isSuccess ? null : gotResponse ? `HTTP_${res.status}` : res.reason;
  const responseBody = gotResponse && res.body ? res.body.slice(0, 2000) : null;
  const permanent = !gotResponse && isPermanentDeliveryError(res.reason);
  const finalStatus: "success" | "failed" | "pending" = isSuccess
    ? "success"
    : attemptNo >= MAX_WEBHOOK_ATTEMPTS || permanent
      ? "failed"
      : "pending";

  // Final state — conditional on OUR claim (attempts == attemptNo, status
  // still pending) so a concurrent terminal write can never be clobbered.
  await db.webhookDelivery
    .updateMany({
      where: { id: delivery.id, status: "pending", attempts: attemptNo },
      data: { status: finalStatus, responseCode },
    })
    .catch((e) => console.error("[webhook-delivery] final state write failed:", errShort(e)));

  await recordAttemptLog({ deliveryId: delivery.id, attemptNo, trigger, responseCode, error, responseBody, durationMs, signed: !!secret });

  const nextRetry = finalStatus === "pending" ? webhookNextRetryAt(attemptNo, now) : null;
  return {
    deliveryId,
    attempted: true,
    status: finalStatus,
    attempts: attemptNo,
    responseCode,
    error,
    responseBody,
    durationMs,
    nextRetryAt: nextRetry ? nextRetry.toISOString() : null,
    signed: !!secret,
  };
}

// ---------------------------------------------------------------- dispatch

/** REAL webhook fan-out (C2.8). Same signature + call sites as the old
 *  simulated version in lib/api.ts (which this replaces):
 *    dispatchStoreWebhooks({ storeId, event, payload })
 *  Creates PENDING WebhookDelivery rows (attempts 0) for the store's active,
 *  subscribed endpoints and immediately attempts each inline — best-effort,
 *  parallel across endpoints, catch-all: failures leave the row pending for
 *  the retry sweep. NEVER throws (call sites are on live order paths) and
 *  NEVER writes success without a real 2xx response. */
export async function dispatchStoreWebhooks(input: { storeId: string; event: string; payload: unknown }): Promise<void> {
  try {
    const endpoints = await db.webhookEndpoint.findMany({
      where: { storeId: input.storeId, isActive: true },
      select: { id: true, eventsJson: true },
    });
    const matched = endpoints.filter((ep) => parseJson<string[]>(ep.eventsJson, []).includes(input.event));
    if (matched.length === 0) return;

    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(input.payload ?? null);
    } catch {
      payloadJson = JSON.stringify({ error: "unserializable_webhook_payload" });
    }

    const created = await Promise.all(
      matched.map((ep) =>
        db.webhookDelivery.create({
          data: { endpointId: ep.id, event: input.event, payloadJson, status: "pending", attempts: 0 },
          select: { id: true },
        })
      )
    );

    // Happy path delivers inline; allSettled + internal catch-alls keep this
    // total. Worst case adds ~one timeout window (10 s) to the calling route.
    await Promise.allSettled(created.map((row) => deliverWebhookDelivery(row.id, { trigger: "inline" })));
  } catch (e) {
    console.error(
      `[webhook-delivery] dispatch failed for ${input.event} (rows may be pending for the retry sweep):`,
      errShort(e)
    );
  }
}

// ---------------------------------------------------------------- retry sweep

export type WebhookSweepOutcome = {
  scanned: number;
  attempted: number;
  succeeded: number;
  retried: number;
  failedFinal: number;
  skippedNotDue: number;
  skippedInactive: number;
  skippedOther: number;
  unsubscribedFailed: number;
  staleFailed: number;
  errors: number;
  remainingBacklog: number | null;
  durationMs: number;
  at: string;
  schedule: string;
};

/** Retry rail: claim a bounded batch of DUE pending deliveries and attempt
 *  them for real. `status:"failed"` rows are terminal (only an explicit admin
 *  replay revives them), so the sweep only ever claims pending rows whose
 *  derived nextAttemptAt has passed (coarse SQL pre-filter + exact per-row
 *  check) with attempts < 8. Deadline-aware so the scheduler's 45 s tick
 *  timeout is never breached; leftovers roll to the next tick. */
export async function sweepDueWebhookDeliveries(opts: { deadlineMs?: number; batch?: number } = {}): Promise<WebhookSweepOutcome> {
  const t0 = performance.now();
  const deadlineMs = opts.deadlineMs ?? 35_000;
  const batch = opts.batch ?? 25;
  const counts = {
    scanned: 0,
    attempted: 0,
    succeeded: 0,
    retried: 0,
    failedFinal: 0,
    skippedNotDue: 0,
    skippedInactive: 0,
    unsubscribedFailed: 0,
    // skipped without an HTTP attempt and without a dedicated counter
    // (claimed_elsewhere race / vanished row / terminal read): counted here
    // so the outcome always adds up (scanned == attempted + skips + errors).
    skippedOther: 0,
    staleFailed: 0,
    errors: 0,
  };

  // Coarse candidate filter: due-ness is derived (lastAttemptAt + backoff),
  // so the SQL narrows to "pending, under the attempt cap, last attempt at
  // least one claim-spacing ago (or never attempted)"; the exact schedule is
  // re-checked per row inside deliverWebhookDelivery.
  let candidates: { id: string }[] = [];
  try {
    candidates = await db.webhookDelivery.findMany({
      where: {
        status: "pending",
        attempts: { lt: MAX_WEBHOOK_ATTEMPTS },
        OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lte: new Date(Date.now() - WEBHOOK_CLAIM_SPACING_MS) } }],
      },
      orderBy: { createdAt: "asc" },
      take: 100,
      select: { id: true },
    });
  } catch (e) {
    console.error("[webhook-delivery] sweep candidate query failed:", errShort(e));
  }
  counts.scanned = candidates.length;

  for (const c of candidates) {
    if (counts.attempted >= batch) break;
    // Deadline on the SAME monotonic clock as t0 (performance.now()). An
    // earlier version compared Date.now() (epoch, ~1.7e12) against t0
    // (performance.now(), small) — the difference was ALWAYS ≥ deadlineMs, so
    // the loop broke before the first attempt and the retry rail silently
    // no-opped (scanned > 0, attempted 0 forever).
    if (performance.now() - t0 >= deadlineMs) break;
    try {
      const outcome = await deliverWebhookDelivery(c.id, { trigger: "sweep" });
      if (outcome.attempted) {
        counts.attempted++;
        if (outcome.status === "success") counts.succeeded++;
        else if (outcome.status === "failed") counts.failedFinal++;
        else counts.retried++;
      } else if (outcome.skipReason === "not_due") counts.skippedNotDue++;
      else if (outcome.skipReason === "endpoint_inactive") counts.skippedInactive++;
      else if (outcome.skipReason === "event_unsubscribed") counts.unsubscribedFailed++;
      else counts.skippedOther++;
    } catch (e) {
      counts.errors++;
      console.error("[webhook-delivery] sweep attempt error:", errShort(e));
    }
  }

  // Abandoned-pending hygiene: rows pending for > 7 days (paused endpoint
  // etc.) — far past the retry horizon — are closed as failed.
  try {
    const stale = await db.webhookDelivery.updateMany({
      where: { status: "pending", createdAt: { lt: new Date(Date.now() - WEBHOOK_STALE_PENDING_MS) } },
      data: { status: "failed" },
    });
    counts.staleFailed = stale.count;
  } catch (e) {
    console.error("[webhook-delivery] stale-pending sweep failed:", errShort(e));
  }

  let remainingBacklog: number | null = null;
  try {
    remainingBacklog = await db.webhookDelivery.count({ where: { status: "pending", attempts: { lt: MAX_WEBHOOK_ATTEMPTS } } });
  } catch {
    /* count is observability-only */
  }

  return {
    ...counts,
    remainingBacklog,
    durationMs: Math.round(performance.now() - t0),
    at: new Date().toISOString(),
    schedule: "inline → 1m → 5m → 15m → 1h → 4h → 12h → 24h (8 attempts, then failed)",
  };
}
