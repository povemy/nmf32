// Store lifecycle state machine (Phase 4) — additive to existing Store.status values.
// Native stores keep: draft | live | maintenance. Import lifecycle adds:
// generating → pending_verification → pending_claim → claimed → draft → live ⇄ maintenance, suspended, archived.
import { db } from "@/lib/db";
import { logActivity } from "@/lib/api";

export const IMPORT_STATUSES = [
  "queued",
  "validating",
  "awaiting_authorisation",
  "connecting",
  "fetching_shop",
  "importing_products",
  "importing_variants",
  "processing_images",
  "generating_seo",
  "generating_storefront",
  "awaiting_claim",
  "completed",
  "completed_with_warnings",
  "failed",
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** Terminal-ish import statuses that stop progress polling. */
export function isImportTerminal(status: string): boolean {
  return status === "completed" || status === "completed_with_warnings" || status === "failed";
}

export const STORE_STATUSES = [
  "generating",
  "pending_verification",
  "pending_claim",
  "claimed",
  "draft",
  "live",
  "maintenance",
  "suspended",
  "archived",
] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];

const TRANSITIONS: Record<string, StoreStatus[]> = {
  generating: ["pending_verification", "pending_claim", "failed" as StoreStatus, "archived"],
  pending_verification: ["pending_claim", "archived"],
  pending_claim: ["claimed", "archived"],
  claimed: ["draft", "archived"],
  draft: ["live", "claimed", "archived"], // claimed → draft = owner configuring
  live: ["maintenance", "suspended", "archived", "draft"],
  maintenance: ["live", "suspended", "archived"],
  suspended: ["draft", "archived"],
  archived: [],
};

export class TransitionError extends Error {}

/**
 * Perform a guarded store-status transition, journaling actor + note.
 * Uses updateMany guard so concurrent transitions cannot race.
 */
export async function transitionStore(opts: {
  storeId: string;
  to: StoreStatus;
  actorType: "system" | "seller" | "admin";
  actorId?: string;
  note?: string;
}): Promise<{ id: string; status: string }> {
  const store = await db.store.findUnique({ where: { id: opts.storeId }, select: { id: true, status: true } });
  if (!store) throw new TransitionError("Store not found");
  const allowed = TRANSITIONS[store.status] ?? [];
  if (!allowed.includes(opts.to)) {
    throw new TransitionError(`Invalid store transition ${store.status} → ${opts.to}`);
  }
  const updated = await db.store.updateMany({
    where: { id: opts.storeId, status: store.status },
    data: { status: opts.to },
  });
  if (updated.count !== 1) throw new TransitionError("Concurrent store transition — retry");
  await logActivity({
    actorType: opts.actorType,
    actorId: opts.actorId ?? null,
    action: `store.transition.${opts.to}`,
    entityType: "store",
    entityId: opts.storeId,
    meta: opts.note ? { note: opts.note } : undefined,
  }).catch(() => undefined);
  return { id: opts.storeId, status: opts.to };
}

export type PublishCheck = { ok: boolean; blockers: string[] };

/**
 * Publication gate for import-generated stores. Native stores (created via the
 * existing onboarding flow) are unaffected — they keep their own approval flow.
 */
export async function canPublish(storeId: string): Promise<PublishCheck> {
  const store = await db.store.findUnique({
    where: { id: storeId },
    include: {
      _count: { select: { products: true } },
      domains: { where: { status: "active" }, select: { id: true } },
    },
  });
  if (!store) return { ok: false, blockers: ["Store not found"] };
  const blockers: string[] = [];
  if (!store.sellerId) blockers.push("Store must be claimed by its verified owner");
  const activeProducts = await db.product.count({ where: { storeId, status: "active" } });
  if (store._count.products === 0) blockers.push("Store has no products");
  if (store._count.products > 0 && activeProducts === 0) blockers.push("No active products — publish at least one product");
  if (!store.supportEmail) blockers.push("Support email is required");
  if (!store.name || store.name.trim().length < 3) blockers.push("Store name is too short");
  const seo = await db.seoMeta.findUnique({ where: { entityType_entityId: { entityType: "store", entityId: storeId } } });
  if (!seo?.seoTitle) blockers.push("Store SEO title is missing");
  if (store.domains.length === 0) {
    // platform slug is acceptable default; custom domain optional — not a blocker
  }
  return { ok: blockers.length === 0, blockers };
}
