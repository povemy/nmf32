import { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { parseMaybeJson } from "@/app/api/admin/_helpers";

// GET /api/admin/webhook-deliveries — deliveries joined with endpoint + store
export const GET = handle(async (req: NextRequest) => {
  await requireAdmin();
  const url = new URL(req.url);
  const status = url.searchParams.get("status");

  const rows = await db.webhookDelivery.findMany({
    where: status && status !== "all" ? { status } : {},
    include: {
      endpoint: {
        select: {
          id: true,
          url: true,
          isActive: true,
          store: { select: { id: true, name: true, slug: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const data = rows.map((d) => ({
    id: d.id,
    event: d.event,
    status: d.status,
    attempts: d.attempts,
    responseCode: d.responseCode,
    lastAttemptAt: d.lastAttemptAt,
    createdAt: d.createdAt,
    payload: parseMaybeJson<unknown>(d.payloadJson, null),
    endpointUrl: d.endpoint.url,
    endpointActive: d.endpoint.isActive,
    storeName: d.endpoint.store.name,
    storeSlug: d.endpoint.store.slug,
  }));
  return ok(data);
});
