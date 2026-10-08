import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { hmacSha256Hex } from "@/lib/password";
import { processPaymentWebhook, WEBHOOK_SECRET } from "../../../../webhooks/payments/process";

export const dynamic = "force-dynamic";

// POST /api/checkout/payments/[ref]/simulate {result: "succeeded"|"failed"}
// SANDBOX MOCK (public): the server signs the webhook payload itself and runs the
// exact same verification+processing pipeline as /api/webhooks/payments/[provider].
// The HMAC secret never reaches the client.
export const POST = handle(async (req: Request, ctx: { params: Promise<{ ref: string }> }) => {
  const { ref } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const result = String(body.result ?? "succeeded");
  if (!["succeeded", "failed"].includes(result)) {
    throw new ApiError(400, "VALIDATION", 'result must be "succeeded" or "failed"');
  }

  const intent = await db.paymentIntent.findUnique({ where: { providerRef: ref } });
  if (!intent) throw new ApiError(404, "NOT_FOUND", "Payment not found");

  const eventType = result === "succeeded" ? "payment.succeeded" : "payment.failed";
  const ts = Date.now();
  const payload = { providerRef: ref, eventType, amountMinor: intent.amountMinor, ts };

  // Server-side signature — same MAC the gateway would send.
  const sig = hmacSha256Hex(WEBHOOK_SECRET, `${ref}.${eventType}.${intent.amountMinor}.${ts}`);

  const outcome = await processPaymentWebhook({
    provider: intent.provider,
    body: { ...payload, sig },
    rawBody: JSON.stringify(payload),
  });

  return ok({ status: outcome.intentStatus, orderNumber: outcome.orderNumber });
});
