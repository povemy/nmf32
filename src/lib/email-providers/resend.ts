// ============================================================================
// email-providers/resend.ts — RESEND adapter (Phase 2.3 transactional email).
// ----------------------------------------------------------------------------
// Selected by EMAIL_PROVIDER=resend + RESEND_API_KEY (+ EMAIL_FROM). The
// provider decision (2026-11-06 research verification, Phase 2.3): Resend is
// the preferred candidate — native Idempotency-Key support (24 h window,
// response replay), Svix-signed delivery webhooks, automatic suppression,
// Tokyo sending region (nearest to MY), SOC 2 Type II. Brevo is the
// documented fallback (see docs/phase23/ for the comparison report).
//
// IMPLEMENTS the TransactionalEmailChannel contract (lib/email-provider.ts):
//   1. Never logs bodies or OTP codes — only ids/status codes.
//   2. Hard timeout (8 s < the contract's 10 s ceiling) via AbortController.
//   3. Failures REJECT — callers choose fail-closed vs silent-degrade.
//   4. Provider rate limits surface as rejections (429 typed).
//   5. Recipient always from server-side records — this adapter never
//      accepts a redirect address; callers construct the email.
//
// IDEMPOTENCY: Resend supports the Idempotency-Key header (24 h retention;
// same key + same payload returns the ORIGINAL email id without re-sending;
// same key + different payload → 409). Key derivation here is a content
// hash over (to, subject, text, html): a retry of the identical send dedupes
// at the provider, while a legitimately re-issued OTP (new code ⇒ new body)
// produces a new key and a fresh email — exactly the semantics the OTP flows
// need.
//
// SUPPRESSION: hard-bounced/complained addresses (maintained by the signed
// webhook /api/webhooks/email/resend) are refused before delivery.
//
// CONFIG (see .env.example):
//   RESEND_API_KEY          — "Sending access" key from the Resend dashboard
//   EMAIL_FROM              — verified sender, e.g. "NOMOFEE <no-reply@mail.nomofee.com>"
//   RESEND_API_URL          — optional override (default https://api.resend.com)
//   RESEND_WEBHOOK_SECRET   — Svix signing secret for the delivery webhook
// ============================================================================
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { TransactionalEmail, TransactionalEmailChannel } from "@/lib/email-provider";
import { isSuppressed, SuppressedAddressError } from "./suppression";

const SEND_TIMEOUT_MS = 8_000;
const DEFAULT_API_URL = "https://api.resend.com";

/** Typed rejection for provider rate limiting (contract rule 4). */
export class EmailRateLimitError extends Error {
  readonly status = 429;
  constructor(detail: string) {
    super(`Resend rate limit reached — retry after the indicated window (${detail})`);
    this.name = "EmailRateLimitError";
  }
}

function configError(which: string): string {
  return `Resend email adapter misconfiguration: ${which} is not set. Configure it in the deployment secret store (see .env.example).`;
}

/** Build the adapter. Returns null (with a loud, once-per-process warning)
 *  when required configuration is missing — the selection seam then keeps
 *  email delivery disabled (fail-closed) instead of erroring per send. */
export function getResendChannel(): TransactionalEmailChannel | null {
  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  const from = (process.env.EMAIL_FROM ?? "").trim();
  if (!apiKey || !from) {
    console.warn(`[email-provider] EMAIL_PROVIDER=resend but ${!apiKey ? "RESEND_API_KEY" : "EMAIL_FROM"} is missing — email delivery stays disabled (fail closed)`);
    return null;
  }
  return {
    providerId: "resend",
    async send(email: TransactionalEmail): Promise<void> {
      const to = email.to.trim().toLowerCase();
      if (await isSuppressed(to)) throw new SuppressedAddressError(to);

      // Content-derived idempotency key (see header comment for rationale).
      const contentHash = createHash("sha256")
        .update(`${to}\n${email.subject}\n${email.textBody}\n${email.htmlBody ?? ""}`)
        .digest("hex")
        .slice(0, 32);
      const idempotencyKey = `${email.meta?.purpose ?? "transactional"}:${contentHash}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
      try {
        const res = await fetch(`${process.env.RESEND_API_URL ?? DEFAULT_API_URL}/emails`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            from,
            to,
            subject: email.subject,
            text: email.textBody,
            ...(email.htmlBody ? { html: email.htmlBody } : {}),
          }),
          signal: controller.signal,
        });

        if (res.status === 429) {
          // Contract rule 4: surface rate limits — never silently drop.
          const retryAfter = res.headers.get("retry-after") ?? "unspecified";
          throw new EmailRateLimitError(`retry-after=${retryAfter}`);
        }
        if (!res.ok) {
          // 4xx/5xx body is provider diagnostic JSON (codes, not message
          // bodies) — safe to summarize, never logged at payload level.
          let detail = "";
          try {
            const j = (await res.json()) as { message?: string; name?: string };
            detail = `${j.name ?? ""} ${j.message ?? ""}`.trim().slice(0, 200);
          } catch {
            detail = "(no body)";
          }
          throw new Error(`Resend send failed (${res.status}): ${detail || "unspecified error"}`);
        }
        // 200 — the provider accepted the email. The returned id is provider
        // correlation only; intentionally NOT logged with content.
        await res.json().catch(() => undefined);
      } catch (e) {
        if (e instanceof SuppressedAddressError || e instanceof EmailRateLimitError) throw e;
        if (e instanceof Error && e.name === "AbortError") {
          throw new Error(`Resend send timed out after ${SEND_TIMEOUT_MS}ms`);
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Svix-style signature verification for the delivery webhook
 *  (/api/webhooks/email/resend). Exported for the route + tests.
 *  Format: HMAC-SHA256(webhookSecret, `${svix-id}.${svix-timestamp}.${rawBody}`)
 *  → base64, presented as space-separated "v1,<sig>" candidates in the
 *  svix-signature header. Constant-time comparison per candidate. */
export function verifySvixSignature(input: {
  secret: string;
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
  rawBody: string;
}): boolean {
  const expected = createHmac("sha256", input.secret)
    .update(`${input.svixId}.${input.svixTimestamp}.${input.rawBody}`)
    .digest("base64");
  const candidates = input.svixSignature.split(" ").filter((c) => c.startsWith("v1,"));
  const expectedBuf = Buffer.from(expected, "base64");
  for (const candidate of candidates) {
    const sigBuf = Buffer.from(candidate.slice("v1,".length), "base64");
    if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) {
      return true;
    }
  }
  return false;
}

export { configError };
