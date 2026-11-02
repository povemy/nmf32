// API envelope + error handling + audit (PART 0 §0.7 conventions).
// Envelope: single => {data}; list => {data:[], meta:{page,size,total}}.
// Errors:   {error:{code, message, details}}.
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import {
  als,
  routeLabel,
  enterRequest,
  exitRequest,
  recordRequest,
  commitScopeToRoute,
  type ReqScope,
} from "./metrics";

// C2.8 (Phase 2.3 — real seller webhook delivery): dispatchStoreWebhooks now
// lives in lib/webhook-delivery.ts and performs REAL HTTP delivery (HMAC-
// signed, SSRF-guarded, retried by /api/cron/webhook-delivery). It is
// re-exported here so every existing import/call site
// (webhooks/payments/process.ts, store orders ship/deliver, shipping.ts,
// admin refunds process) keeps working unchanged. The old implementation
// wrote status:"success"/responseCode:200 rows WITHOUT any HTTP request.
export { dispatchStoreWebhooks } from "./webhook-delivery";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  /** Optional response headers (e.g. Retry-After on 503 CHECKOUT_BUSY). */
  headers?: Record<string, string>;
  constructor(status: number, code: string, message: string, details?: unknown, headers?: Record<string, string>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ data }, init);
}

/** Paged envelope: {data, meta}. `data` is usually an array, but composite
 *  payloads (e.g. {bucketCounts, orders}) are allowed too. */
export function okPaged<T>(data: T, meta: { page: number; size: number; total: number }): NextResponse {
  return NextResponse.json({ data, meta });
}

export function fail(status: number, code: string, message: string, details?: unknown, headers?: Record<string, string>): NextResponse {
  return NextResponse.json({ error: { code, message, details } }, { status, headers });
}

// ============================================================================
// Phase 2.3 (P2.3-6) — production error sanitization helpers.
// ----------------------------------------------------------------------------
// Unhandled exceptions (Prisma internals like table/column names and query
// text, filesystem paths, stack fragments) must never reach API clients when
// NODE_ENV=production. Dev keeps the historical full-message behavior.
// ============================================================================

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Short correlation id stamped on sanitized production error responses so a
 * support report ("ref a1b2c3d4") maps back to the full server-side log line. */
export function errorRefId(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  } catch {
    return Math.random().toString(16).slice(2, 10);
  }
}

/** Wrap a route handler: converts thrown ApiErrors into envelope responses.
 *
 * Phase 2.3 (P2.3-6) production sanitization: a NON-ApiError throw returns
 * {error: {code: "INTERNAL", message: "Something went wrong on our side",
 * meta: {refId}}} — the raw message/stack is logged server-side under the
 * same refId, never serialized to the client. ApiErrors keep their intentional
 * client-facing message in every environment (that IS the contract). DEV is
 * unchanged: full exception message in the 500 envelope for debugging. The
 * response shape stays {error: {code, message, ...}} — clients only read
 * error.code / error.message / error.details (verified across components),
 * so the added meta field is additive, not a contract change.
 *
 * P2.3-7 (monitoring honesty — Phase 2.3 audit "dead metrics code"): the
 * metrics registry (lib/metrics.ts) previously had recordRequest/
 * enterRequest/exitRequest defined but ZERO callers — every /api/metrics
 * response carried permanently-empty routes/totals sections. handle() is
 * the single choke point every API route already flows through, so wiring
 * the recorders HERE makes route latency, status codes, in-flight gauges
 * and (via the ALS scope + the lib/db.ts Prisma hook) per-route DB time
 * REAL for every endpoint — including the audit's named surfaces that were
 * not safely touchable this phase: checkout admission (byStatus on
 * POST /api/checkout/*, incl. 503 CHECKOUT_BUSY), payout failures
 * (byStatus/errors on payout routes) and webhook outcomes. /api/metrics
 * remains excluded from its own counters (EXCLUDED_LABELS). All metric
 * calls are non-throwing so instrumentation can never fail a response. */
export function handle<Args extends unknown[]>(
  fn: (...args: Args) => Promise<NextResponse>
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    // Route label from the first argument when it is a Request (all App-Router
    // route handlers). Anything else (direct lib call) is skipped defensively.
    let label: string | null = null;
    try {
      const first = args[0];
      if (first instanceof Request) label = routeLabel(first.method, new URL(first.url).pathname);
    } catch {
      label = null;
    }
    const tracked = label != null && enterRequest(label);
    const scope: ReqScope | null = tracked && label != null
      ? { label, dbMs: 0, dbCount: 0, dbSlowestMs: 0, dbSlowestModel: null, dbSlowestOp: null }
      : null;
    const t0 = performance.now();
    try {
      const res = scope ? await als.run(scope, () => fn(...args)) : await fn(...args);
      if (tracked) recordRequest(label, res.status, performance.now() - t0);
      return res;
    } catch (e) {
      if (tracked) recordRequest(label, e instanceof ApiError ? e.status : 500, performance.now() - t0);
      if (e instanceof ApiError) {
        return fail(e.status, e.code, e.message, e.details, e.headers);
      }
      if (!isProduction()) {
        console.error("[api]", e);
        const message = e instanceof Error ? e.message : "Internal error";
        return fail(500, "INTERNAL", message);
      }
      const refId = errorRefId();
      // Full details (message, stack, Prisma error internals) stay server-side.
      console.error(`[api] ref=${refId} unhandled error:`, e);
      return NextResponse.json(
        { error: { code: "INTERNAL", message: "Something went wrong on our side", meta: { refId } } },
        { status: 500 }
      );
    } finally {
      if (tracked) {
        commitScopeToRoute(label);
        exitRequest(label);
      }
    }
  };
}

export function getPagination(url: URL, maxSize = 100) {
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const size = Math.min(maxSize, Math.max(1, parseInt(url.searchParams.get("size") ?? "20", 10) || 20));
  return { page, size, skip: (page - 1) * size, take: size };
}

export async function auditAdmin(input: {
  adminId: string;
  adminEmail: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}) {
  await db.adminAuditLog.create({
    data: {
      adminId: input.adminId,
      adminEmail: input.adminEmail,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      beforeJson: input.before != null ? JSON.stringify(input.before) : null,
      afterJson: input.after != null ? JSON.stringify(input.after) : null,
    },
  });
  await db.activityLog.create({
    data: {
      actorType: "admin",
      actorId: input.adminId,
      actorLabel: input.adminEmail,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      metaJson: input.after != null ? JSON.stringify(input.after) : null,
    },
  });
}

export async function logActivity(input: {
  actorType: "admin" | "seller" | "system" | "shopper";
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  meta?: unknown;
}) {
  await db.activityLog.create({
    data: {
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      actorLabel: input.actorLabel ?? null,
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      metaJson: input.meta != null ? JSON.stringify(input.meta) : null,
    },
  });
}

/** Fire notification log rows (M14 — template-driven; worker renders in prod, we log inline).
 *
 *  FIN-2b (2b.7) — optional `dedupKey`: when provided, the row is written with
 *  a stable per-event key and the (channel, dedupKey) unique constraint (FIN-1
 *  schema) turns duplicate deliveries into a P2002, which we answer with a
 *  SILENT skip (`{ skipped: true }`) instead of inserting a second copy —
 *  webhook retries / racing processors can no longer multiply seller emails.
 *  Without a dedupKey the legacy always-insert behavior is untouched (Postgres
 *  unique treats NULLs as distinct). Callers never consumed the return value
 *  (verified: all call-sites plain `await notify(...)`), so the richer return
 *  shape is backward-compatible. */
export async function notify(input: { event: string; channel: "email" | "whatsapp" | "inapp"; recipient: string; subject?: string; status?: "queued" | "sent" | "failed"; error?: string; dedupKey?: string }): Promise<{ skipped: boolean }> {
  try {
    await db.notificationLog.create({
      data: {
        event: input.event,
        channel: input.channel,
        recipient: input.recipient,
        subject: input.subject ?? null,
        // W-3 honesty fix (Phase 2 final remediation): notify() writes a
        // RECORD, not a delivery receipt — it never sends anything. The old
        // default "sent" claimed email delivery that never happened (the
        // same honesty class as the fake webhook success fixed in C2.8).
        // Default now matches the column's own schema default ("queued"); a
        // real delivery path passes an explicit status when it exists.
        status: input.status ?? "queued",
        error: input.error ?? null,
        dedupKey: input.dedupKey ?? null,
      },
    });
  } catch (e) {
    // Silent dedup: only when a dedupKey was supplied — the unique violation
    // on (channel, dedupKey) means the FIRST delivery already logged this
    // exact notification, so a retry converges instead of erroring the flow.
    if (input.dedupKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { skipped: true };
    }
    throw e;
  }
  return { skipped: false };
}

/** Advance order status with history + side-effects.
 *
 *  FIN-2b (2b.3) — optional `tx`: when the caller is mid-transaction (webhook
 *  success path groups the status flip + ledger posting + history atomically)
 *  the read, the order update and the history insert ALL run on that client;
 *  without it the legacy sequential db behavior is byte-identical. */
export async function transitionOrder(input: {
  orderId: string;
  toStatus: string;
  actor?: string;
  note?: string;
  timestamps?: Partial<Record<"paidAt" | "fulfilledAt" | "shippedAt" | "deliveredAt" | "completedAt" | "cancelledAt", Date>>;
  tx?: Prisma.TransactionClient;
}) {
  const client = input.tx ?? db;
  const order = await client.order.findUnique({ where: { id: input.orderId } });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
  await client.order.update({
    where: { id: order.id },
    data: { status: input.toStatus, ...input.timestamps },
  });
  await client.orderStatusHistory.create({
    data: {
      orderId: order.id,
      fromStatus: order.status,
      toStatus: input.toStatus,
      actor: input.actor ?? "system",
      note: input.note ?? null,
    },
  });
  return { ...order, status: input.toStatus };
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

export async function nextOrderNumber(): Promise<string> {
  const c = await db.counter.upsert({
    where: { key: "order_number" },
    create: { key: "order_number", value: 100001 },
    update: { value: { increment: 1 } },
  });
  return `NM-${c.value}`;
}
