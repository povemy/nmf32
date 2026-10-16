import { z } from "zod";
import { db } from "@/lib/db";
import { handle, ok, okPaged, ApiError, getPagination } from "@/lib/api";
import { requireShopper } from "@/lib/auth";

export const dynamic = "force-dynamic";

function parseDataJson(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// GET /api/me/notifications?unread=1&size= — the shopper's notification feed
// (newest first). Envelope: {data:[...], meta:{page,size,total}}.
export const GET = handle(async (req: Request) => {
  const me = await requireShopper();
  const url = new URL(req.url);
  const { page, size, skip, take } = getPagination(url, 50);
  const unreadOnly = ["1", "true"].includes((url.searchParams.get("unread") ?? "").toLowerCase());

  const where = { shopperUserId: me.id, ...(unreadOnly ? { readAt: null } : {}) };
  const [rows, total] = await Promise.all([
    db.notification.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
    db.notification.count({ where }),
  ]);

  return okPaged(
    rows.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      data: parseDataJson(n.dataJson),
      read: n.readAt != null,
      readAt: n.readAt,
      createdAt: n.createdAt,
    })),
    { page, size, total }
  );
});

const readSchema = z
  .object({ ids: z.array(z.string().min(1)).max(200).optional(), all: z.boolean().optional() })
  .refine((v) => v.all === true || (v.ids?.length ?? 0) > 0, { message: "Provide ids[] or all:true" });

// POST /api/me/notifications {ids?: string[] | all: true} — mark as read.
export const POST = handle(async (req: Request) => {
  const me = await requireShopper();
  const parsed = readSchema.safeParse((await req.json().catch(() => ({}))) as unknown);
  if (!parsed.success) throw new ApiError(400, "VALIDATION", "Provide { ids: string[] } or { all: true }");

  const where = parsed.data.all
    ? { shopperUserId: me.id, readAt: null }
    : { shopperUserId: me.id, id: { in: parsed.data.ids ?? [] }, readAt: null };

  const res = await db.notification.updateMany({ where, data: { readAt: new Date() } });
  const unread = await db.notification.count({ where: { shopperUserId: me.id, readAt: null } });
  return ok({ updated: res.count, unread });
});
