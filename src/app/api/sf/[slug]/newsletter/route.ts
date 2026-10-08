import { db } from "@/lib/db";
import { handle, ok, ApiError, notify, logActivity } from "@/lib/api";

export const dynamic = "force-dynamic";

// POST /api/sf/[slug]/newsletter {email}
export const POST = handle(async (req: Request, ctx: { params: Promise<{ slug: string }> }) => {
  const { slug } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const email = String(body.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, "VALIDATION", "A valid email is required");
  }

  const store = await db.store.findUnique({ where: { slug } });
  if (!store || store.status !== "live") throw new ApiError(404, "STORE_NOT_FOUND", "Store not found");

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

  return ok({ subscribed: true });
});
