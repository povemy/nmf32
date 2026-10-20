import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { rateLimit } from "@/lib/ratelimit";
import { mockPspAllowed } from "@/lib/psp";
import { processPaymentWebhook, expectedSignature } from "../../../../webhooks/payments/process";

export const dynamic = "force-dynamic";

// POST /api/checkout/payments/[ref]/simulate {result: "succeeded"|"failed"}
// SANDBOX MOCK PSP (public): the server signs the webhook payload itself and
// runs the exact same verification+processing pipeline as
// /api/webhooks/payments/[provider]. The HMAC secret never reaches the client.
// This endpoint PLAYS the licensed PSP in dev (see src/lib/psp.ts — Option B):
// the ref may be a single PaymentIntent OR a multi-seller PaymentGroup
// (one PSP checkout session covering N per-seller orders).
//
// FIN-2b (2b.2) PRODUCTION GATE: refuse with 404 when NODE_ENV=production
// unless an operator explicitly enabled Setting psp.mock.enabled=true —
// mockPspAllowed() (lib/psp.ts) centralizes that decision. In production this
// endpoint must be replaced by the provider's hosted checkout redirect (per
// psp.ts production plug-in points); it exists so the sandbox has a faithful
// PSP stand-in, NOT as a production payment switch. The self-signing nature
// means the HMAC proves nothing here — the gate IS the security control.
// FIN-2b (2b.6): rate-limited to 10 req/min per IP+route.
export const POST = handle(async (req: Request, ctx: { params: Promise<{ ref: string }> }) => {
  const rl = rateLimit(req, { limit: 10, windowMs: 60_000 });
  if (!rl.ok) {
    throw new ApiError(429, "RATE_LIMITED", "Too many simulate requests", { retryAfterSec: rl.retryAfterSec });
  }

  const { ref } = await ctx.params;
  if (process.env.NODE_ENV === "production" && !(await mockPspAllowed())) {
    // 404 (not 403): the endpoint simply does not exist in production.
    throw new ApiError(404, "NOT_FOUND", "Not found");
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const result = String(body.result ?? "succeeded");
  if (!["succeeded", "failed"].includes(result)) {
    throw new ApiError(400, "VALIDATION", 'result must be "succeeded" or "failed"');
  }

  const group = await db.paymentGroup.findUnique({ where: { ref } });
  const intent = group ? null : await db.paymentIntent.findUnique({ where: { providerRef: ref } });
  if (!group && !intent) throw new ApiError(404, "NOT_FOUND", "Payment not found");

  const amountMinor = group ? group.totalMinor : intent!.amountMinor;
  const provider = group ? group.provider : intent!.provider;

  const eventType = result === "succeeded" ? "payment.succeeded" : "payment.failed";
  // Current timestamp — the processor enforces a ±10 min freshness window
  // (STALE_EVENT), so a self-signed payload must always be stamped now.
  const ts = Date.now();
  const payload = { providerRef: ref, eventType, amountMinor, ts };

  // Server-side signature — same MAC the gateway would send, via the shared
  // expectedSignature helper (single source for the signing formula).
  const sig = expectedSignature(ref, eventType, amountMinor, ts);

  const outcome = await processPaymentWebhook({
    provider,
    body: { ...payload, sig },
    rawBody: JSON.stringify(payload),
  });

  return ok({
    status: outcome.intentStatus,
    orderNumber: outcome.orderNumber,
    orderNumbers: outcome.orderNumbers ?? [outcome.orderNumber],
    isGroup: Boolean(outcome.isGroup),
  });
});
