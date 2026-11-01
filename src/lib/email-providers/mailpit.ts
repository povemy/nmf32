// ============================================================================
// email-providers/mailpit.ts — DEV-ONLY local mail testing adapter
// (Phase 2.3: "use a real local mail testing service such as Mailpit").
// ----------------------------------------------------------------------------
// Selected by EMAIL_PROVIDER=mailpit (+ optional MAILPIT_URL, default
// http://127.0.0.1:8025). Sends REAL emails to the local Mailpit SMTP
// catcher via its REST API — genuine delivery (inspectable at the Mailpit
// web UI), never a simulated "success" record. This is the honest
// development path for the OTP/verification flows: no provider account, no
// external network, no fake delivery claims.
//
// NEVER available in production (constructor throws — fail closed), matching
// the sandbox-only guard on the mock PSP rails.
// ============================================================================
import type { TransactionalEmail, TransactionalEmailChannel } from "@/lib/email-provider";

const SEND_TIMEOUT_MS = 5_000;
const DEFAULT_MAILPIT_URL = "http://127.0.0.1:8025";

export function getMailpitChannel(): TransactionalEmailChannel | null {
  if (process.env.NODE_ENV === "production") {
    // Fail closed: a production deployment must never point transactional
    // email at a local dev catcher.
    console.warn("[email-provider] EMAIL_PROVIDER=mailpit is dev-only — ignored in production (fail closed)");
    return null;
  }
  const base = (process.env.MAILPIT_URL ?? DEFAULT_MAILPIT_URL).replace(/\/+$/, "");
  const from = (process.env.EMAIL_FROM ?? "NOMOFEE <dev@localhost>").trim();
  return {
    providerId: "mailpit",
    async send(email: TransactionalEmail): Promise<void> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/api/v1/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: [{ Email: from, Name: from }],
            to: [{ Email: email.to }],
            subject: email.subject,
            text: email.textBody,
            ...(email.htmlBody ? { html: email.htmlBody } : {}),
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`Mailpit send failed (${res.status}) — is Mailpit running at ${base}?`);
        }
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          throw new Error(`Mailpit send timed out after ${SEND_TIMEOUT_MS}ms (${base})`);
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
