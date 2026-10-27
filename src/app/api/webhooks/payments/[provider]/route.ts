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
  // Flood control BEFORE any body parsing/processing — a webhook storm can
  // neither reach the processor nor burn DB reads. Default 60 req/min per
  // client IP+route is far above any legitimate provider retry cadence.
  // WEBHOOK_RATE_LIMIT_PER_MIN is a STAGING LOAD-TEST knob only (external
  // single-IP generator driving payment-path stress); production keeps the
  // default unless an operator deliberately raises it for a known provider.
  const rl = rateLimit(req, { limit: Number(process.env.WEBHOOK_RATE_LIMIT_PER_MIN ?? 60), windowMs: 60_000 });
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
