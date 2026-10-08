import { db } from "@/lib/db";
import { handle, ok, ApiError, logActivity } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { parseTheme } from "@/lib/sections";
import { toJson } from "@/lib/json";

export const dynamic = "force-dynamic";

// GET /api/store/theme
export const GET = handle(async () => {
  const { store } = await requireActiveSellerStore();
  return ok({ theme: parseTheme(store.themeJson) });
});

// PUT /api/store/theme {theme: {...tokens}}
export const PUT = handle(async (req: Request) => {
  const { me, store } = await requireActiveSellerStore();
  const body = (await req.json().catch(() => ({}))) as { theme?: Record<string, unknown> };
  if (!body.theme || typeof body.theme !== "object") {
    throw new ApiError(400, "VALIDATION", "theme object is required");
  }
  // merge over existing tokens so unspecified ones persist
  const merged = { ...parseTheme(store.themeJson), ...body.theme };
  const updated = await db.store.update({
    where: { id: store.id },
    data: { themeJson: toJson(merged) },
  });
  await logActivity({
    actorType: "seller",
    actorId: me.id,
    actorLabel: me.email,
    action: "store.theme.updated",
    entityType: "store",
    entityId: store.id,
  });
  return ok({ theme: parseTheme(updated.themeJson) });
});
