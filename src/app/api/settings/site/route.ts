import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";

// GET /api/settings/site — public appearance settings consumed by client chrome
// (no auth). Backed by the generic Setting key/value store.
export const GET = handle(async () => {
  const row = await db.setting.findUnique({ where: { key: "ui.footer_visible" } });
  // Admin writes the JSON string "true"/"false"; missing row = visible (default).
  const footerVisible = row?.valueJson !== "false";
  return ok({ footerVisible });
});
