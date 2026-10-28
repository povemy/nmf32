import { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api";
import { db } from "@/lib/db";

// GET /api/sf/app-config — PUBLIC lightweight platform chrome config for the
// shopper web app. Currently exposes the global footer visibility
// (Setting ui.footer_visible, default ON when absent/unparseable).
// Response shape: { data: { footerVisible: boolean } }
export const GET = handle(async (_req: NextRequest) => {
  let footerVisible = true;
  try {
    const row = await db.setting.findUnique({ where: { key: "ui.footer_visible" } });
    if (row) {
      const parsed = JSON.parse(row.valueJson) as unknown;
      if (typeof parsed === "boolean") footerVisible = parsed;
    }
  } catch {
    /* missing table/connection at boot — default stays ON */
  }
  return ok({ footerVisible });
});
