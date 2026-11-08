import { db } from "@/lib/db";
import { handle, ok, ApiError, notify, logActivity } from "@/lib/api";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { parseJson } from "@/lib/json";
import type { NewsletterBody, NewsletterData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

// B4 — pragmatic email validation: local@domain.tld, no whitespace, ≤ 254
// (RFC 5321 practical limit). Anything fancier belongs to the mail worker.
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,63}$/;

// POST /api/sf/[slug]/newsletter {email}
export const POST = handle(async (req: Request, ctx: { params: Promise<{ slug: string }> }) => {
  // B4 — burst guard: 5 req/min/IP kills scripted submissions across slugs.
  rateLimit(req, "sf-newsletter", 5);
  const { slug } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as NewsletterBody;

  // Email is the only consumed field: trim + lowercase (rate key + storage
  // stability); over-length input is REJECTED (400) rather than silently
  // truncated — a truncated address would be a wrong address.
  const email = String(body.email ?? "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    throw new ApiError(400, "VALIDATION", "A valid email is required");
  }

  // Per-identity limiter: 3/hour/email — brute-force spread across many IPs
  // still throttles, shared-NAT shoppers are not throttled by each other.
  rateLimitKey(email, "sf-newsletter-email", 3, 3600_000);

  // C1.3 defense-in-depth (V-F7 fix): live store + admin-approved seller —
  // an inactive seller's storefront surfaces 404 fail closed (sf/[slug] pattern).
  const store = await db.store.findFirst({ where: { slug, status: "live", seller: { is: { status: "active" } } } });
  if (!store) throw new ApiError(404, "STORE_NOT_FOUND", "Store not found");

  // Cheap duplicate guard: if this store+email already subscribed within the
  // last 24h (double-click, retry), skip the notify/logActivity writes and
  // keep returning the same success shape — idempotent-ish UX, no row flood.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await db.activityLog.findMany({
    where: {
      action: "newsletter.subscribe",
      entityType: "store",
      entityId: store.id,
      createdAt: { gte: since },
    },
    select: { metaJson: true },
    take: 500,
  });
  const alreadySubscribed = recent.some(
    (row) => parseJson<{ email?: unknown }>(row.metaJson, {}).email === email
  );

  if (!alreadySubscribed) {
    await notify({
      event: "newsletter.subscribed",
      channel: "email",
      recipient: email,
      subject: `Welcome to the ${store.name} list`,
    });
    await logActivity({
      actorType: "shopper",
      action: "newsletter.subscribe",
      entityType: "store",
      entityId: store.id,
      meta: { email, storeSlug: store.slug },
    });
  }

  const payload: NewsletterData = { subscribed: true };
  return ok(payload);
});
