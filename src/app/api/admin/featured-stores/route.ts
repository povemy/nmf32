import { NextRequest } from "next/server";
import { handle, ok, ApiError, auditAdmin } from "@/lib/api";
import { requireAdmin, requireCap } from "@/lib/auth";
import { db } from "@/lib/db";
import { readBody, parseMaybeJson } from "@/app/api/admin/_helpers";

// R8 — featured STORES on the marketplace home ("Featured stores" section).
// The ordered list lives in Setting `home.featured_stores` as a JSON array of
// store ids. Empty/missing setting = marketplace falls back to its default
// curation (first 6 live stores by createdAt), exactly like before this route.

export const FEATURED_STORES_KEY = "home.featured_stores";
const MAX_SLOTS = 12;

type StoreCard = {
  id: string;
  name: string;
  slug: string;
  tagline: string | null;
  logoUrl: string | null;
  productCount: number;
  status: string;
};

async function loadConfiguredIds(): Promise<string[]> {
  const row = await db.setting.findUnique({ where: { key: FEATURED_STORES_KEY } });
  const parsed = parseMaybeJson<unknown>(row?.valueJson, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

/** Resolve ordered ids → store cards (missing stores are dropped silently). */
async function resolveStores(ids: string[]) {
  if (ids.length === 0) return [] as StoreCard[];
  const rows = await db.store.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      name: true,
      slug: true,
      tagline: true,
      logoUrl: true,
      status: true,
      _count: { select: { products: { where: { status: "active" } } } },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is (typeof rows)[number] => Boolean(r))
    .map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      tagline: r.tagline,
      logoUrl: r.logoUrl,
      productCount: r._count.products,
      status: r.status,
    }));
}

// GET /api/admin/featured-stores — ordered featured stores for the admin UI.
export const GET = handle(async () => {
  await requireAdmin();
  const ids = await loadConfiguredIds();
  const stores = await resolveStores(ids);
  return ok({ key: FEATURED_STORES_KEY, stores });
});

// PUT /api/admin/featured-stores { storeIds: string[] } — replace the whole
// ordered list (the client sends add/remove/reorder results as one array).
// F-18 (Phase 3): this writes the Setting table, so it now carries the same
// `settings.manage` (superadmin) gate as every other Setting write
// (/api/admin/settings PUT) — previously bare requireAdmin bypassed the cap.
export const PUT = handle(async (req: NextRequest) => {
  const admin = await requireCap("settings.manage");
  const body = await readBody(req);

  const rawIds = Array.isArray(body.storeIds) ? body.storeIds : null;
  if (!rawIds) throw new ApiError(400, "VALIDATION", "storeIds array is required");

  // validate type + dedupe (keep first occurrence = display order)
  const ids: string[] = [];
  for (const v of rawIds) {
    if (typeof v !== "string" || v.trim() === "") continue;
    if (!ids.includes(v)) ids.push(v);
  }
  if (ids.length > MAX_SLOTS) {
    throw new ApiError(400, "VALIDATION", `At most ${MAX_SLOTS} stores can be featured`);
  }
  if (ids.length > 0) {
    const found = await db.store.findMany({ where: { id: { in: ids } }, select: { id: true } });
    const foundIds = new Set(found.map((f) => f.id));
    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) throw new ApiError(404, "NOT_FOUND", "One or more stores no longer exist");
  }

  const before = parseMaybeJson<unknown>(
    (await db.setting.findUnique({ where: { key: FEATURED_STORES_KEY } }))?.valueJson,
    null
  );
  const valueJson = JSON.stringify(ids);
  await db.setting.upsert({
    where: { key: FEATURED_STORES_KEY },
    create: { key: FEATURED_STORES_KEY, valueJson },
    update: { valueJson },
  });

  await auditAdmin({
    adminId: admin.id,
    adminEmail: admin.email,
    action: "featured_stores.update",
    entityType: "setting",
    entityId: FEATURED_STORES_KEY,
    before,
    after: ids,
  });

  const stores = await resolveStores(ids);
  return ok({ key: FEATURED_STORES_KEY, stores });
});
