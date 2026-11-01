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

/**
 * C1.3 (seller publication governance): the admin seller routes previously
 * wrote store.status directly (raw db.store.update), forming a second,
 * conflicting publication mechanism that could force stores into statuses the
 * machine forbids. ADMIN_PATHS routes those admin actions back through LEGAL
 * transitions only. Pre-claim lifecycle statuses (generating /
 * pending_verification / pending_claim) and archived are deliberately absent
 * from every path: an admin seller action must not fabricate the store's own
 * claim/configuration steps, and archived is terminal — those cases reject
 * with 409 at the route (e.g. a pending_claim store needs claiming first).
 */
const ADMIN_PATHS: Partial<Record<StoreStatus, Partial<Record<StoreStatus, StoreStatus[]>>>> = {
  // Target "live" (admin approve / activate): publish the store.
  live: {
    draft: ["live"],
    maintenance: ["live"],
    suspended: ["draft", "live"], // un-suspension parks in draft first, then publish
    claimed: ["draft", "live"], // owner-configuration hop, then publish
  },
  // Target "draft" (admin reject / suspend / terminate): take the store down.
  draft: {
    live: ["draft"],
    maintenance: ["suspended", "draft"], // enforcement takedown, then park in draft
    suspended: ["draft"],
    claimed: ["draft"],
  },
};

/** Plan (without applying) the legal hop sequence for an admin-driven store
 * status change. [] ⇒ already at target; null ⇒ no legal path (caller 409s). */
export function planAdminStorePath(current: string, to: StoreStatus): StoreStatus[] | null {
  if (current === to) return [];
  return ADMIN_PATHS[to]?.[current as StoreStatus] ?? null;
}

/**
 * Apply an admin seller action's store-status change through the guarded state
 * machine ONLY (C1.3) — every hop is journaled via transitionStore. Throws
 * TransitionError when the store cannot legally reach the target (routes map
 * that to 409 CONFLICT); re-reads the current status so a concurrent change
 * is caught by the machine's own CAS guard.
 */
export async function transitionStoreToward(opts: {
  storeId: string;
  to: StoreStatus;
  actorId?: string;
  note?: string;
}): Promise<string> {
  const store = await db.store.findUnique({ where: { id: opts.storeId }, select: { status: true } });
  if (!store) throw new TransitionError("Store not found");
  const hops = planAdminStorePath(store.status, opts.to);
  if (!hops) throw new TransitionError(`No legal store transition ${store.status} → ${opts.to}`);
  for (const hop of hops) {
    await transitionStore({ storeId: opts.storeId, to: hop, actorType: "admin", actorId: opts.actorId, note: opts.note });
  }
  return opts.to;
}

export type PublishCheck = { ok: boolean; blockers: string[]; code?: string };

/**
 * Publication gate — the single authoritative check before a store may go
 * publicly live. C1.3 (seller publication governance): alongside the store
 * completeness rules below, publication requires the store's seller to be
 * admin-approved (status "active") — fail closed for public selling until
 * genuine seller verification exists. This unifies the import-claim flow with
 * the native onboarding flow: BOTH need admin approval before going live
 * (claim → claimed → draft keeps working; the seller then submits onboarding
 * → admin approves → publish). kycStatus is deliberately NOT consulted here.
 */
export async function canPublish(storeId: string): Promise<PublishCheck> {
  const store = await db.store.findUnique({
    where: { id: storeId },
    include: {
      seller: { select: { status: true } }, // C1.3: seller approval is part of the gate
      _count: { select: { products: true } },
      domains: { where: { status: "active" }, select: { id: true } },
    },
  });
  if (!store) return { ok: false, blockers: ["Store not found"] };
  const blockers: string[] = [];
  if (!store.sellerId) blockers.push("Store must be claimed by its verified owner");
  // C1.3: fail closed — no admin-approved seller, no public store. Returned
  // with a distinct code so callers can answer 403 (account problem) instead
  // of 422 (store-completeness problem).
  if (store.sellerId && (!store.seller || store.seller.status !== "active")) {
    return {
      ok: false,
      code: "SELLER_NOT_APPROVED",
      blockers: [
        `Seller account is ${store.seller ? `"${store.seller.status}"` : "unlinked"} — an administrator must approve it before this store can go live`,
      ],
    };
  }
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
