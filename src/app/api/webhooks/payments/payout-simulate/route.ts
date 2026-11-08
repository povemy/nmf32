import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { rateLimit } from "@/lib/ratelimit";
import { mockPspAllowed } from "@/lib/psp";
import { processPaymentWebhook, expectedSignature } from "../process";
import type { PayoutSimulateBody, PayoutSimulateData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// POST /api/webhooks/payments/payout-simulate
// Body: {referenceNo: string, result?: "succeeded"|"failed" (default "succeeded"), reason?: string}
//
// SANDBOX-ONLY mock-PSP endpoint (FIN-2b 2b.5): emits the SIGNED
// payout.succeeded / payout.failed webhook a real PSP would send when the bank
// transfer behind a "processing" payout completes or fails, and feeds it
// through the EXACT same verification+processing pipeline as
// /api/webhooks/payments/[provider] (processPaymentWebhook) — i.e. it plays
// the PSP exactly like the payment simulate endpoint does for checkouts.
//
// This is the sandbox "provider completion evidence" source: it is the ONLY
// sanctioned way a payout reaches paid/failed without a human admin mark-paid,
// and it exists so FIN-4 (and the orchestrator E2E) can probe the full payout
// lifecycle requested → processing → paid/failed end-to-end. In production it
// is replaced by the real PSP's webhook; the route refuses (404) under
// NODE_ENV=production unless Setting psp.mock.enabled=true (mockPspAllowed).
//
// Idempotent by construction: the processor's claim-first pattern makes a
// replay a no-op (payoutConflict=true) with zero ledger movement.
export const POST = handle(async (req: Request) => {
  const rl = rateLimit(req, { limit: 10, windowMs: 60_000 });
  if (!rl.ok) {
    throw new ApiError(429, "RATE_LIMITED", "Too many simulate requests", { retryAfterSec: rl.retryAfterSec });
  }
  if (process.env.NODE_ENV === "production" && !(await mockPspAllowed())) {
    // 404 (not 403): the endpoint simply does not exist in production.
    throw new ApiError(404, "NOT_FOUND", "Not found");
  }

  const body = (await req.json().catch(() => ({}))) as PayoutSimulateBody;
  const referenceNo = String(body.referenceNo ?? "").trim();
  if (!referenceNo) throw new ApiError(400, "VALIDATION", "referenceNo is required");
  const result = String(body.result ?? "succeeded");
  if (!["succeeded", "failed"].includes(result)) {
    throw new ApiError(400, "VALIDATION", 'result must be "succeeded" or "failed"');
  }

  // Same resolution contract the webhook processor uses for payout events:
  // Payout.referenceNo first, Payout.providerRef fallback.
  const payout =
    (await db.payout.findUnique({ where: { referenceNo } })) ??
    (await db.payout.findFirst({ where: { providerRef: referenceNo } }));
  if (!payout) throw new ApiError(404, "NOT_FOUND", "Payout not found");

  const eventType = result === "succeeded" ? "payout.succeeded" : "payout.failed";
  // Current timestamp — the processor enforces a ±10 min freshness window.
  const ts = Date.now();
  const amountMinor = payout.amountMinor;
  const payload: Record<string, unknown> = { providerRef: referenceNo, eventType, amountMinor, ts };
  if (result === "failed" && body.reason) payload.reason = String(body.reason);

  // Server-side signature — same MAC the gateway would send.
  const sig = expectedSignature(referenceNo, eventType, amountMinor, ts);

  const outcome = await processPaymentWebhook({
    provider: "mock",
    body: { ...payload, sig } as { providerRef?: string; eventType?: string; amountMinor?: number; ts?: number; sig?: string; reason?: string },
    rawBody: JSON.stringify(payload),
  });

  const refreshed = await db.payout.findUnique({ where: { id: payout.id } });
  const data: PayoutSimulateData = {
    ...outcome,
    referenceNo: payout.referenceNo,
    payoutStatus: refreshed?.status ?? outcome.payoutStatus ?? payout.status,
  };
  return ok(data);
});
