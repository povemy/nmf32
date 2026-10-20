// API envelope + error handling + audit (PART 0 §0.7 conventions).
// Envelope: single => {data}; list => {data:[], meta:{page,size,total}}.
// Errors:   {error:{code, message, details}}.
import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "./db";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
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

export function fail(status: number, code: string, message: string, details?: unknown): NextResponse {
  return NextResponse.json({ error: { code, message, details } }, { status });
}

/** Wrap a route handler: converts thrown ApiErrors into envelope responses. */
export function handle<Args extends unknown[]>(
  fn: (...args: Args) => Promise<NextResponse>
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof ApiError) {
        return fail(e.status, e.code, e.message, e.details);
      }
      console.error("[api]", e);
      const message = e instanceof Error ? e.message : "Internal error";
      return fail(500, "INTERNAL", message);
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
        status: input.status ?? "sent",
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

/** Simulated outbound webhook fan-out (M13): enqueue deliveries for store endpoints. */
export async function dispatchStoreWebhooks(input: { storeId: string; event: string; payload: unknown }) {
  const endpoints = await db.webhookEndpoint.findMany({ where: { storeId: input.storeId, isActive: true } });
  for (const ep of endpoints) {
    const events = JSON.parse(ep.eventsJson || "[]") as string[];
    if (!events.includes(input.event)) continue;
    await db.webhookDelivery.create({
      data: {
        endpointId: ep.id,
        event: input.event,
        payloadJson: JSON.stringify(input.payload),
        status: "success",
        attempts: 1,
        responseCode: 200,
        lastAttemptAt: new Date(),
      },
    });
  }
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
