import { handle, ok, ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { verifySvixSignature } from "@/lib/email-providers/resend";

export const dynamic = "force-dynamic";

// ============================================================================
// POST /api/webhooks/email/resend — SIGNED Resend delivery-event webhook
// (Phase 2.3 transactional email).
// ----------------------------------------------------------------------------
// Ingests email.delivered / email.bounced / email.complained / email.failed /
// email.delivery_delayed / suppression.added / suppression.removed events.
//
// TRUST MODEL (mirrors the payment webhook rails):
//   • Svix HMAC-SHA256 signature over the RAW body — verified with the
//     webhook signing secret (RESEND_WEBHOOK_SECRET). Fail-closed in
//     production when the secret is unset (503); dev keeps a documented
//     public fallback so the sandbox rails work without env setup.
//   • ±5-minute timestamp window (replay protection, svix-timestamp).
//   • Exactly-once processing: (provider, providerEventId) unique — provider
//     retries reuse the svix-id and converge on the stored row.
//
// SIDE EFFECTS:
//   • email.bounced (permanent) / email.complained / suppression.added →
//     upsert EmailSuppression (the send adapters refuse suppressed addresses).
//   • suppression.removed → delete the suppression row.
//   • Every event is stored verbatim (payloadJson) for audit/ops —
//     delivery-event payloads contain ids/addresses only, never OTP codes.
// ============================================================================

const TS_WINDOW_MS = 5 * 60_000;

function webhookSecret(): string {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (secret && secret.length > 0) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new ApiError(
      503,
      "EMAIL_WEBHOOK_SECRET_UNSET",
      "RESEND_WEBHOOK_SECRET is not configured — email delivery webhooks are disabled (fail closed)"
    );
  }
  return "sm_email_webhook_secret_demo";
}

type ResendWebhookPayload = {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    email?: string;
    to?: string[];
    subject?: string;
    bounce?: { type?: string };
  };
};

export const POST = handle(async (req: Request) => {
  const rawBody = await req.text();
  const svixId = req.headers.get("svix-id") ?? "";
  const svixTimestamp = req.headers.get("svix-timestamp") ?? "";
  const svixSignature = req.headers.get("svix-signature") ?? "";

  if (!svixId || !svixTimestamp || !svixSignature) {
    throw new ApiError(400, "BAD_SIGNATURE", "Webhook signature headers missing (svix-id/timestamp/signature)");
  }
  const ts = Number(svixTimestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > TS_WINDOW_MS) {
    throw new ApiError(400, "STALE_EVENT", `Webhook timestamp is outside the ±${TS_WINDOW_MS / 60_000}-minute acceptance window (replay protection)`);
  }
  if (!verifySvixSignature({ secret: webhookSecret(), svixId, svixTimestamp, svixSignature, rawBody })) {
    throw new ApiError(400, "BAD_SIGNATURE", "Webhook signature verification failed");
  }

  let payload: ResendWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as ResendWebhookPayload;
  } catch {
    throw new ApiError(400, "BAD_PAYLOAD", "Webhook body is not valid JSON");
  }
  const eventType = String(payload.type ?? "unknown");
  const email = (payload.data?.email ?? payload.data?.to?.[0] ?? "").trim().toLowerCase() || null;
  const emailId = payload.data?.email_id ?? null;

  // Exactly-once ingestion: the unique (provider, providerEventId) claim is
  // the gate — a replayed delivery returns the stored row's effects summary.
  const inserted = await db.emailDeliveryEvent.create({
    data: {
      provider: "resend",
      providerEventId: svixId,
      eventType,
      emailId,
      email,
      payloadJson: rawBody.slice(0, 20_000),
    },
    select: { id: true },
  }).catch((e: unknown) => {
    // Unique violation ⇒ provider retry of an already-ingested event.
    if (e instanceof Error && (e as { code?: string }).code === "P2002") {
      return null;
    }
    throw e;
  });

  if (inserted === null) {
    return ok({ received: true, duplicate: true, eventType });
  }

  // Side effects — only for FIRST ingestion.
  const suppressReason =
    eventType === "email.bounced" || eventType === "suppression.added"
      ? "hard_bounce"
      : eventType === "email.complained"
        ? "complaint"
        : null;
  if (suppressReason && email) {
    await db.emailSuppression.upsert({
      where: { email },
      create: { email, reason: suppressReason, sourceEventId: svixId },
      update: { reason: suppressReason, sourceEventId: svixId },
    });
  }
  if (eventType === "suppression.removed" && email) {
    await db.emailSuppression.deleteMany({ where: { email } });
  }

  return ok({ received: true, duplicate: false, eventType });
});
