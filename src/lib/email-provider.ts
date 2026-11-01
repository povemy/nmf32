// ============================================================================
// Transactional email — provider SEAM (FINAL CLOSURE §4).
//
// STATUS: INTERFACE + SELECTION ONLY. No concrete provider adapter is shipped
// and NO email is sent from this codebase today, because the provider
// decision (Resend / Postmark / AWS SES / Supabase Auth mailer) is an OPEN
// OPERATIONS DECISION. Every OTP-issuing route fails closed (503
// ORDER_OTP_NOT_CONFIGURED / EMAIL_PROVIDER_NOT_CONFIGURED) while
// getEmailChannel() returns null — the same posture as PSP_WEBHOOK_SECRET /
// MFA_ENCRYPTION_KEY before configuration.
//
// The security logic (src/lib/guest-otp.ts) depends ONLY on this interface:
//   send({ to, subject, textBody, htmlBody?, meta? }) => Promise<void>
// so the provider can be selected later by (a) implementing one ~40-line
// adapter per candidate, (b) wiring it into getEmailChannel() via
// EMAIL_PROVIDER — WITHOUT touching any security logic. Registration email
// verification reuses the SAME channel (mandate: "Preserve the option to
// implement registration verification using the same email infrastructure").
//
// Adapter contract (must hold for every future implementation):
//   1. send() MUST NOT log the message body or any OTP code (meta carries
//      purpose/subject ids only — never the code).
//   2. send() MUST time out (<= 10 s) — issuance routes must never hang on a
//      slow provider.
//   3. Failures MUST reject (thrown Error) — callers decide between fail-closed
//      503 (pre-flight) and uniform silent-degrade (post-match delivery).
//   4. The adapter MUST honor provider rate limits and surface them as
//      rejections (never silently drop).
//   5. Delivery address is ALWAYS taken from server-side records (the email
//      on the order / the account) — an adapter must never be callable with a
//      caller-supplied redirect address.
//
// Operational prerequisites (documented for ops; see
// docs/security/guest-order-otp-design.md §6):
//   • Sending domain + SPF/DKIM/DMARC for the envelope sender.
//   • Provider API credentials in the deployment secret store
//     (EMAIL_PROVIDER + per-provider keys) — never in the repo.
//   • Bounce/complaint handling: hard bounces must disable issuance for the
//     affected address (provider webhook → audit row); delivery failures are
//     audited as email.otp.delivery_failed.
//   • Provider rate limits vs the route limits (5/min/IP, 3/h/email,
//     5/h/order, 3/h/pair) — provider ceilings must exceed them.
//   • Templates: subject/body for order-OTP and registration-verification.
//   • Audit logging: issuance/verification/delivery-failure events only —
//     never codes, never grant tokens.
// ============================================================================
import { ApiError } from "./api";

/** One transactional email. `meta` is audit context only — NEVER a code. */
export interface TransactionalEmail {
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
  meta?: { purpose: string; subjectId?: string };
}

/** The single dependency the security logic has on email delivery. */
export interface TransactionalEmailChannel {
  readonly providerId: string;
  send(email: TransactionalEmail): Promise<void>;
}

/** Supported provider ids (selection happens via EMAIL_PROVIDER env var once
 *  an adapter ships). Kept as documentation of the seam, not a promise. */
export type EmailProviderId = "resend" | "postmark" | "ses" | "supabase-auth";

/**
 * The configured channel, or null when no provider decision has landed.
 * Today this ALWAYS returns null: no adapter is compiled in (mandate §4 —
 * do not implement external delivery before the provider decision; do not
 * simulate a delivery mechanism either).
 *
 * When an adapter ships, this function becomes the single selection point:
 *   switch (process.env.EMAIL_PROVIDER) { case "resend": ... }
 * — nothing else in the codebase changes.
 */
export function getEmailChannel(): TransactionalEmailChannel | null {
  const requested = (process.env.EMAIL_PROVIDER ?? "").trim().toLowerCase();
  if (!requested) return null;
  // A provider is NAMED but no adapter exists yet → surface loudly instead of
  // silently ignoring the env var (misconfiguration must be visible).
  console.warn(
    `[email-provider] EMAIL_PROVIDER="${requested}" is set but no provider adapter is compiled in — email delivery stays disabled (fail closed). Implement the adapter in src/lib/email-provider.ts after the provider decision.`
  );
  return null;
}

/** Fail-closed pre-flight used by every OTP-issuing route BEFORE any
 *  order/account lookup (uniform for all callers — no existence oracle).
 *  In production the 503 is permanent until ops configures a provider. */
export function requireEmailChannel(): TransactionalEmailChannel {
  const channel = getEmailChannel();
  if (!channel) {
    throw new ApiError(
      503,
      "EMAIL_PROVIDER_NOT_CONFIGURED",
      "Email delivery is not configured on this deployment — email verification is unavailable (fail closed)"
    );
  }
  return channel;
}
