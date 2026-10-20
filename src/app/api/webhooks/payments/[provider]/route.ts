import { handle, ok, ApiError } from "@/lib/api";
import { rateLimit } from "@/lib/ratelimit";
import { processPaymentWebhook } from "../process";

export const dynamic = "force-dynamic";

// POST /api/webhooks/payments/[provider] — mock gateway callback.
// Body: {providerRef, eventType: payment.succeeded|payment.failed|payout.succeeded|payout.failed, amountMinor, ts, sig?, reason?}
// Signature (HMAC-SHA256 hex of "ref.eventType.amount.ts") accepted via
// header X-SM-Signature OR body.sig. Invalid → 400 BAD_SIGNATURE (still logged).
// Stale (outside ±10 min window) → 400 STALE_EVENT (still logged).
// FIN-2b (2b.6): flood control BEFORE any body parsing/processing — a webhook
// storm can neither reach the processor nor burn DB reads. 60 req/min per
// client IP+route is far above any legitimate provider retry cadence.
export const POST = handle(async (req: Request, ctx: { params: Promise<{ provider: string }> }) => {
  const rl = rateLimit(req, { limit: 60, windowMs: 60_000 });
  if (!rl.ok) {
    throw new ApiError(429, "RATE_LIMITED", "Too many webhook requests", { retryAfterSec: rl.retryAfterSec });
  }

  const { provider } = await ctx.params;
  const rawBody = await req.text(); // raw body read stays BEFORE parsing (order preserved)
  const body = JSON.parse(rawBody || "{}") as Record<string, unknown>;
  const headerSignature = req.headers.get("X-SM-Signature");

  const outcome = await processPaymentWebhook({
    provider,
    body: body as { providerRef?: string; eventType?: string; amountMinor?: number; ts?: number; sig?: string; reason?: string },
    rawBody,
    headerSignature,
  });

  return ok({ ok: true, duplicate: outcome.duplicate, orderNumber: outcome.orderNumber, orderStatus: outcome.orderStatus });
});
