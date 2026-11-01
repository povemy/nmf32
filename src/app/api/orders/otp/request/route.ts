import { db } from "@/lib/db";
import { handle, ok, logActivity } from "@/lib/api";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { requireEmailChannel, type TransactionalEmailChannel } from "@/lib/email-provider";
import { assertEmailOtpStorage, issueEmailOtp } from "@/lib/guest-otp";

export const dynamic = "force-dynamic";

// POST /api/orders/otp/request { email, orderNumber } — FINAL CLOSURE §1.
//
// The knowledge pair (email + NM- order number) can REQUEST a verification
// challenge here — and that is ALL it can do. It never authorizes order data
// (lookup/receipt require an order-access grant or an owning session).
//
// Uniformity contract (no order-existence oracle):
//   • The response is ALWAYS 200 { sent: true, message } — identical for a
//     matching pair, a non-matching pair and a non-existent order.
//   • The two GLOBAL fail-closed pre-flights (email provider, OTP storage)
//     run BEFORE any order lookup, so their 503s are equally uniform.
//   • Delivery failures never propagate (issueEmailOtp fail-soft) — an error
//     burst aimed at a matching order must not differ from a miss.
//
// Throttling (retained + strengthened — the anti-enumeration axes that used
// to live on the knowledge-pair LOOKUP now protect OTP issuance, which is
// where the knowledge pair is accepted):
//   • 5/min per IP
//   • 3/hour per email        (identity-keyed — many IPs, one victim)
//   • 5/hour per order number (identity-keyed — many emails, one order)
//   • 3/hour per (email, orderNumber) pair
//
// Codes: 6-digit CSPRNG, sent ONLY to order.customerEmail (the address on
// file — never caller-supplied), stored ONLY as a keyed HMAC hash, 10-minute
// TTL, 5 attempts, never logged, never in any response.
const UNIFORM_MESSAGE =
  "If an order matches those details, a 6-digit verification code has been sent to the email address on file. It expires in 10 minutes.";

export const POST = handle(async (req: Request) => {
  rateLimit(req, "orders-otp-request", 5);
  const body = (await req.json().catch(() => ({}))) as { email?: string; orderNumber?: string };
  const email = (body.email ?? "").trim().toLowerCase();
  const orderNumber = (body.orderNumber ?? "").trim();
  if (!email.includes("@") || !orderNumber) {
    return ok({ sent: true, message: UNIFORM_MESSAGE });
  }
  if (email.length > 254 || orderNumber.length > 32) {
    return ok({ sent: true, message: UNIFORM_MESSAGE });
  }
  rateLimitKey(email, "orders-otp-email", 3, 3_600_000);
  rateLimitKey(orderNumber, "orders-otp-order", 5, 3_600_000);
  rateLimitKey(`${email}|${orderNumber}`, "orders-otp-pair", 3, 3_600_000);

  // Fail-closed pre-flights BEFORE the order lookup (uniform for everyone):
  // no provider → 503 for every caller; storage not migrated → 503 likewise.
  const channel: TransactionalEmailChannel = requireEmailChannel();
  await assertEmailOtpStorage();

  const order = await db.order.findUnique({
    where: { orderNumber },
    select: { id: true, orderNumber: true, customerEmail: true },
  });
  const matched = !!order && order.customerEmail.toLowerCase() === email;

  if (matched && order) {
    const target = order.customerEmail;
    const result = await issueEmailOtp({
      purpose: "guest-order",
      subjectId: order.id,
      deliver: (code) =>
        channel.send({
          to: target,
          subject: `Your NOMOFEE order verification code (${order.orderNumber})`,
          textBody:
            `Your verification code for NOMOFEE order ${order.orderNumber} is ${code}.\n\n` +
            `It expires in 10 minutes. If you did not request it, you can ignore this email.\n` +
            `NOMOFEE will never ask you to reply with this code.`,
          meta: { purpose: "guest-order", subjectId: order.id },
        }),
    });
    // Audit WITHOUT the code (and without the customer email — the order id
    // is the durable correlation key). Delivery failures are recorded here.
    await logActivity({
      actorType: "shopper",
      actorLabel: "guest-order-otp",
      action: "order.otp.request",
      entityType: "order",
      entityId: order.id,
      meta: { issued: result.issued, suppressed: result.suppressed ?? null },
    }).catch(() => undefined);
  }

  // ALWAYS the uniform response.
  return ok({ sent: true, message: UNIFORM_MESSAGE });
});
