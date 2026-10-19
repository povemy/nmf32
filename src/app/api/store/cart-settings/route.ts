import { handle, ok, ApiError } from "@/lib/api";
import { requireActiveSellerStore } from "@/lib/auth";
import { db } from "@/lib/db";
import { toJson, parseJson } from "@/lib/json";

export const dynamic = "force-dynamic";

// Cart drawer experience settings — one config per store. The Seller Backend
// sends structured fields (toggles / selects / ids); the ONLY free-form data
// is the list of picked product ids for manual upsells, validated against the
// seller's own catalogue. Vendors never see or write JSON.
const LAYOUTS = ["compact", "standard", "pro"];
const UPSELL_MODES = ["auto", "manual"];

type CartPayload = {
  layout?: unknown;
  showFreeShippingBar?: unknown;
  freeShipThresholdMinor?: unknown;
  upsellEnabled?: unknown;
  upsellMode?: unknown;
  upsellProductIds?: unknown;
  upsellTitle?: unknown;
  upsellLimit?: unknown;
  urgencyStockEnabled?: unknown;
  urgencyStockThreshold?: unknown;
  urgencyViewersEnabled?: unknown;
  urgencyViewersMin?: unknown;
  urgencyViewersMax?: unknown;
  urgencyCountdownEnabled?: unknown;
  urgencyCountdownMinutes?: unknown;
  trustBadges?: unknown;
  showOrderNote?: unknown;
  showDiscountHint?: unknown;
  checkoutLabel?: unknown;
  showContinueShopping?: unknown;
  stickyCta?: unknown;
};

const TRUST_BADGE_IDS = ["secure", "returns", "support", "shipping", "cod", "warranty"];

function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function intOr(v: unknown, fallback: number, min: number, max: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function strOr(v: unknown, fallback: string, maxLen: number): string {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, maxLen) : fallback;
}

async function buildData(body: CartPayload, storeId: string, existing: { upsellProductIdsJson: string } | null) {
  if (typeof body.layout === "string" && !LAYOUTS.includes(body.layout)) {
    throw new ApiError(400, "BAD_LAYOUT", `Layout must be one of: ${LAYOUTS.join(", ")}`);
  }
  if (typeof body.upsellMode === "string" && !UPSELL_MODES.includes(body.upsellMode)) {
    throw new ApiError(400, "BAD_UPSELL_MODE", `Upsell mode must be one of: ${UPSELL_MODES.join(", ")}`);
  }

  // Manual upsell picks: must be the seller's own active products.
  let upsellProductIdsJson: string | undefined;
  if (body.upsellProductIds !== undefined) {
    const ids = Array.isArray(body.upsellProductIds) ? body.upsellProductIds.filter((x): x is string => typeof x === "string") : [];
    const unique = [...new Set(ids)].slice(0, 8);
    if (unique.length > 0) {
      const owned = await db.product.findMany({
        where: { id: { in: unique }, storeId, status: { in: ["active", "draft"] } },
        select: { id: true },
      });
      const ownedIds = new Set(owned.map((p) => p.id));
      const bad = unique.filter((id) => !ownedIds.has(id));
      if (bad.length > 0) throw new ApiError(400, "BAD_UPSELL_PRODUCT", "Upsell picks must be products from your own catalogue");
    }
    upsellProductIdsJson = toJson(unique);
  }

  // Trust badges: preset chips only.
  let trustBadgesJson: string | undefined;
  if (body.trustBadges !== undefined) {
    const ids = Array.isArray(body.trustBadges) ? body.trustBadges.filter((x): x is string => typeof x === "string") : [];
    const clean = [...new Set(ids)].filter((id) => TRUST_BADGE_IDS.includes(id));
    trustBadgesJson = toJson(clean);
  }

  const viewersMin = intOr(body.urgencyViewersMin, 8, 2, 200);
  const viewersMax = intOr(body.urgencyViewersMax, 28, 2, 500);

  return {
    layout: strOr(body.layout, "standard", 16),
    showFreeShippingBar: boolOr(body.showFreeShippingBar, true),
    freeShipThresholdMinor: intOr(body.freeShipThresholdMinor, 10000, 0, 10_000_000),
    upsellEnabled: boolOr(body.upsellEnabled, false),
    upsellMode: strOr(body.upsellMode, "auto", 8),
    upsellProductIdsJson: upsellProductIdsJson ?? existing?.upsellProductIdsJson ?? "[]",
    upsellTitle: strOr(body.upsellTitle, "Frequently bought together", 60),
    upsellLimit: intOr(body.upsellLimit, 3, 1, 6),
    urgencyStockEnabled: boolOr(body.urgencyStockEnabled, false),
    urgencyStockThreshold: intOr(body.urgencyStockThreshold, 5, 1, 100),
    urgencyViewersEnabled: boolOr(body.urgencyViewersEnabled, false),
    urgencyViewersMin: Math.min(viewersMin, viewersMax),
    urgencyViewersMax: Math.max(viewersMin, viewersMax),
    urgencyCountdownEnabled: boolOr(body.urgencyCountdownEnabled, false),
    urgencyCountdownMinutes: intOr(body.urgencyCountdownMinutes, 15, 3, 240),
    trustBadgesJson: trustBadgesJson ?? undefined,
    showOrderNote: boolOr(body.showOrderNote, false),
    showDiscountHint: boolOr(body.showDiscountHint, true),
    checkoutLabel: strOr(body.checkoutLabel, "Checkout", 30),
    showContinueShopping: boolOr(body.showContinueShopping, true),
    stickyCta: boolOr(body.stickyCta, false),
  };
}

// GET /api/store/cart-settings — current drawer configuration.
export const GET = handle(async () => {
  const { store } = await requireActiveSellerStore();
  const settings = await db.cartSettings.findUnique({ where: { storeId: store.id } });

  const upsellIds = parseJson<string[]>(settings?.upsellProductIdsJson ?? "[]", []);
  const picked = upsellIds.length
    ? await db.product.findMany({
        where: { id: { in: upsellIds }, storeId: store.id },
        select: { id: true, title: true, priceMinor: true, status: true },
      })
    : [];

  return ok({
    settings: settings
      ? {
          layout: settings.layout,
          showFreeShippingBar: settings.showFreeShippingBar,
          freeShipThresholdMinor: settings.freeShipThresholdMinor,
          upsellEnabled: settings.upsellEnabled,
          upsellMode: settings.upsellMode,
          upsellTitle: settings.upsellTitle,
          upsellLimit: settings.upsellLimit,
          urgencyStockEnabled: settings.urgencyStockEnabled,
          urgencyStockThreshold: settings.urgencyStockThreshold,
          urgencyViewersEnabled: settings.urgencyViewersEnabled,
          urgencyViewersMin: settings.urgencyViewersMin,
          urgencyViewersMax: settings.urgencyViewersMax,
          urgencyCountdownEnabled: settings.urgencyCountdownEnabled,
          urgencyCountdownMinutes: settings.urgencyCountdownMinutes,
          showOrderNote: settings.showOrderNote,
          showDiscountHint: settings.showDiscountHint,
          checkoutLabel: settings.checkoutLabel,
          showContinueShopping: settings.showContinueShopping,
          stickyCta: settings.stickyCta,
          trustBadges: parseJson<string[]>(settings.trustBadgesJson, []),
        }
      : null,
    upsellPicked: picked,
    freeShippingDefaultMinor: 10000,
  });
});

// PUT /api/store/cart-settings — save the drawer configuration.
export const PUT = handle(async (req: Request) => {
  const { store } = await requireActiveSellerStore();
  const body = (await req.json().catch(() => ({}))) as CartPayload;
  const existing = await db.cartSettings.findUnique({ where: { storeId: store.id } });
  const data = await buildData(body, store.id, existing);

  const saved = await db.cartSettings.upsert({
    where: { storeId: store.id },
    // undefined fields (e.g. trustBadgesJson when not sent) keep their stored
    // values on update and fall back to column defaults on create.
    create: { storeId: store.id, ...data },
    update: data,
  });

  return ok({ settings: { layout: saved.layout }, savedAt: saved.updatedAt });
});
