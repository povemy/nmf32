import { handle, ok } from "@/lib/api";
import { processPaymentWebhook } from "../process";

export const dynamic = "force-dynamic";

// POST /api/webhooks/payments/[provider] — mock gateway callback.
// Body: {providerRef, eventType: payment.succeeded|payment.failed, amountMinor, ts, sig?}
// Signature (HMAC-SHA256 hex of "ref.eventType.amount.ts") accepted via
// header X-SM-Signature OR body.sig. Invalid → 400 BAD_SIGNATURE (still logged).
export const POST = handle(async (req: Request, ctx: { params: Promise<{ provider: string }> }) => {
  const { provider } = await ctx.params;
  const rawBody = await req.text();
  const body = JSON.parse(rawBody || "{}") as Record<string, unknown>;
  const headerSignature = req.headers.get("X-SM-Signature");

  const outcome = await processPaymentWebhook({
    provider,
    body: body as { providerRef?: string; eventType?: string; amountMinor?: number; ts?: number; sig?: string },
    rawBody,
    headerSignature,
  });

  return ok({ ok: true, duplicate: outcome.duplicate, orderNumber: outcome.orderNumber, orderStatus: outcome.orderStatus });
});
