// ============================================================================
// tests/e2e/contract.ts — the RUNTIME mirror of src/lib/types/api-contract.ts.
// ----------------------------------------------------------------------------
// The contract file is types-only (erased at runtime), so this module hand-
// rolls a tiny strict validator toolkit and one validator per payload type
// for every endpoint the E2E golden paths exercise. Two guarantees stack:
//
//   COMPILE TIME — every validator is annotated `Check<ContractType>` and the
//     object combinator's spec is a mapped type over the contract interface:
//     miss a field, mistype a field, or add a bogus one → `tsc` fails HERE,
//     the moment the contract drifts from the harness.
//   RUNTIME — vObject requires the wire JSON to carry EXACTLY the contract
//     keys (no missing, no extra) with exactly the declared primitive types,
//     and the envelope checks require the platform shapes from src/lib/api.ts
//     ({data} | {data, meta} | {error:{code, message, ...}}).
//
// No `any`, no loose assertion-based "trust me" — every narrowing goes through
// a Check.
// ============================================================================
import { expect, type Page } from "@playwright/test";
import type {
  AddCartItemData,
  CartItem,
  CartSettingsDTO,
  CartStore,
  CartView,
  DevAccountsData,
  GetCartData,
  MarketCta,
  MarketHomeData,
  MarketSuggestData,
  MarketTheme,
  MeAnonymousData,
  MeOrderSummary,
  MeOrderSummaryItem,
  MeShopperData,
  MeStoreRef,
  OrdersData,
  PdpData,
  PdpVariant,
  SfAppConfigData,
  SfCardStyle,
  SfCartSettingsData,
  SfProductCard,
  SfReviewItem,
  SfReviewsListData,
  SfTheme,
  StockProbeData,
  UnifiedShopperData,
  UpsellCard,
} from "../../src/lib/types/api-contract";

// ---------------------------------------------------------------- primitives

/** A runtime check that narrows `unknown` to `T` or throws a Violation. */
export type Check<T> = (value: unknown, path: string) => T;

export class Violation extends Error {
  constructor(
    public readonly path: string,
    public readonly problem: string,
  ) {
    super(`${path}: ${problem}`);
  }
}

const fail = (path: string, problem: string): never => {
  throw new Violation(path, problem);
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const describe = (v: unknown): string => {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "string") return `string ${JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v)}`;
  return typeof v;
};

export const vNull: Check<null> = (v, p) => (v === null ? null : fail(p, `expected null, got ${describe(v)}`));
export const vString: Check<string> = (v, p) => (typeof v === "string" ? v : fail(p, `expected string, got ${describe(v)}`));
export const vNumber: Check<number> = (v, p) =>
  typeof v === "number" && Number.isFinite(v) ? v : fail(p, `expected finite number, got ${describe(v)}`);

export function vInt(min = Number.MIN_SAFE_INTEGER): Check<number> {
  return (v, p) =>
    typeof v === "number" && Number.isInteger(v) && v >= min
      ? v
      : fail(p, `expected integer ≥ ${min}, got ${describe(v)}`);
}

export const vBool: Check<boolean> = (v, p) => (typeof v === "boolean" ? v : fail(p, `expected boolean, got ${describe(v)}`));

export function vLiteral<T extends string>(...allowed: readonly T[]): Check<T> {
  return (v, p) => {
    if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
    return fail(p, `expected one of [${allowed.join(" | ")}], got ${describe(v)}`);
  };
}

export const vIso: Check<string> = (v, p) => {
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) return fail(p, `expected ISO-8601 date string, got ${describe(v)}`);
  return v;
};

export function vOrNull<T>(inner: Check<T>): Check<T | null> {
  return (v, p) => (v === null ? null : inner(v, p));
}

export function vArray<T>(item: Check<T>): Check<T[]> {
  return (v, p) => {
    if (!Array.isArray(v)) return fail(p, `expected array, got ${describe(v)}`);
    return v.map((el, i) => item(el, `${p}[${i}]`));
  };
}

export function vRecord<T>(item: Check<T>): Check<Record<string, T>> {
  return (v, p) => {
    if (!isObj(v)) return fail(p, `expected object, got ${describe(v)}`);
    const out: Record<string, T> = {};
    for (const [k, val] of Object.entries(v)) out[k] = item(val, `${p}.${k}`);
    return out;
  };
}

type Spec<T> = { [K in keyof T]-?: Check<T[K]> };

/**
 * Exact-shape object validator: every contract key must be present on the
 * wire, no extra key may appear, and each value must pass its Check.
 * `optionalKeys` covers the rare contract fields marked `?:` (JSON-serialised
 * endpoints simply omit them, so absence is legal — presence still validates).
 */
export function vObject<T extends object>(spec: Spec<T>, optionalKeys: readonly (keyof T & string)[] = []): Check<T> {
  return (v, p) => {
    if (!isObj(v)) return fail(p, `expected object, got ${describe(v)}`);
    const specKeys = Object.keys(spec) as (keyof T & string)[];
    const missing = specKeys.filter((k) => !(k in v) && !optionalKeys.includes(k));
    if (missing.length > 0) return fail(p, `missing key(s): ${missing.join(", ")}`);
    const extra = Object.keys(v).filter((k) => !(k in spec));
    if (extra.length > 0) return fail(p, `unexpected extra key(s): ${extra.join(", ")}`);
    const out: Record<string, unknown> = {};
    for (const k of specKeys) {
      if (optionalKeys.includes(k) && !(k in v)) continue;
      out[k] = (spec[k] as Check<unknown>)(v[k], `${p}.${k}`);
    }
    return out as unknown as T;
  };
}

// ------------------------------------------------------- contract validators

/** Mirrors src/lib/money.ts formatMinor (MYR) — the exact string the UI renders. */
export function formatMinor(minor: number, currency = "MYR"): string {
  const symbols: Record<string, string> = { MYR: "RM", SGD: "S$", IDR: "Rp" };
  const value = minor / 100;
  const sym = symbols[currency] ?? `${currency} `;
  const negative = value < 0;
  const formatted = Math.abs(value).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${negative ? "-" : ""}${sym} ${formatted}`;
}

/** GET /api/sf/[slug]/products & /api/market/* — SfProductCard */
export const vSfProductCard: Check<SfProductCard> = vObject({
  id: vString,
  slug: vString,
  title: vString,
  priceMinor: vInt(0),
  compareAtPriceMinor: vOrNull(vInt(0)),
  variantId: vOrNull(vString),
  imageUrl: vString,
  storeName: vString,
  storeSlug: vString,
  ratingAvg: vNumber,
  ratingCount: vInt(0),
  viewCount: vInt(0),
  salesCount: vInt(0),
  categoryName: vOrNull(vString),
});

/** GET /api/sf/[slug]/cart-settings — UpsellCard (product card + stock) */
export const vUpsellCard: Check<UpsellCard> = vObject({
  id: vString,
  slug: vString,
  title: vString,
  priceMinor: vInt(0),
  compareAtPriceMinor: vOrNull(vInt(0)),
  variantId: vOrNull(vString),
  imageUrl: vString,
  storeName: vString,
  storeSlug: vString,
  ratingAvg: vNumber,
  ratingCount: vInt(0),
  viewCount: vInt(0),
  salesCount: vInt(0),
  categoryName: vOrNull(vString),
  stock: vInt(0),
});

const vMarketTheme: Check<MarketTheme> = vObject({
  accent: vString,
  accentSoft: vString,
  gradientFrom: vString,
  gradientTo: vString,
  greeting: vString,
  greetingBm: vString,
  tagline: vString,
  taglineBm: vString,
  ornament: vString,
});

const vMarketCta: Check<MarketCta> = vObject(
  {
    kind: vLiteral("search", "category", "store", "deals", "vouchers", "external"),
    q: vString,
    slug: vString,
    url: vString,
  },
  ["q", "slug", "url"],
);

/** GET /api/market/home — MarketHomeData (13 top-level keys) */
export const vMarketHomeData: Check<MarketHomeData> = vObject({
  banners: vArray(
    vObject({ id: vString, title: vString, imageUrl: vString, linkUrl: vOrNull(vString) }),
  ),
  categories: vArray(
    vObject({
      id: vString,
      name: vString,
      slug: vString,
      imageUrl: vOrNull(vString),
      children: vArray(vObject({ id: vString, name: vString, slug: vString })),
    }),
  ),
  featured: vArray(vSfProductCard),
  latest: vArray(vSfProductCard),
  trending: vArray(vSfProductCard),
  featuredStores: vArray(
    vObject({
      id: vString,
      name: vString,
      slug: vString,
      tagline: vOrNull(vString),
      logoUrl: vOrNull(vString),
      bannerUrl: vOrNull(vString),
      productCount: vInt(0),
    }),
  ),
  sectionOrder: vArray(
    vLiteral("hero", "quick_access", "showcase", "flash_deals", "categories", "trending", "featured", "stores", "new_arrivals", "inline"),
  ),
  hero: vArray(
    vObject({
      id: vString,
      kind: vLiteral("campaign", "banner"),
      name: vString,
      description: vOrNull(vString),
      ctaLabel: vString,
      cta: vOrNull(vMarketCta),
      endsAt: vIso,
      title: vString,
      subtext: vOrNull(vString),
      imageUrl: vOrNull(vString),
      mobileImageUrl: vOrNull(vString),
      theme: vOrNull(vMarketTheme),
    }),
  ),
  heroSecondary: vArray(
    vObject({
      id: vString,
      name: vString,
      description: vOrNull(vString),
      ctaLabel: vString,
      cta: vOrNull(vMarketCta),
      endsAt: vIso,
      heading: vString,
      subtext: vOrNull(vString),
      imageUrl: vOrNull(vString),
      mobileImageUrl: vOrNull(vString),
      theme: vMarketTheme,
    }),
  ),
  promoTiles: vArray(vObject({ id: vString, name: vString, theme: vMarketTheme, cta: vOrNull(vMarketCta) })),
  showcase: vArray(
    vObject({
      id: vString,
      name: vString,
      description: vOrNull(vString),
      ctaLabel: vString,
      cta: vOrNull(vMarketCta),
      endsAt: vIso,
      thumbnailUrl: vOrNull(vString),
      theme: vMarketTheme,
    }),
  ),
  inline: vArray(
    vObject({
      id: vString,
      name: vString,
      description: vOrNull(vString),
      ctaLabel: vString,
      cta: vOrNull(vMarketCta),
      endsAt: vIso,
      heading: vString,
      subtext: vOrNull(vString),
      bannerDesktopUrl: vOrNull(vString),
      bannerMobileUrl: vOrNull(vString),
      productQuery: vOrNull(vString),
      products: vArray(vSfProductCard),
      theme: vMarketTheme,
    }),
  ),
  flashDeals: vObject({
    products: vArray(vSfProductCard),
    campaign: vOrNull(vObject({ id: vString, name: vString, endAt: vIso })),
  }),
});

/** GET /api/sf/[slug]/products/[pSlug] — PdpVariant */
const vPdpVariant: Check<PdpVariant> = vObject({
  id: vString,
  name: vString,
  optionName: vOrNull(vString),
  optionValue: vOrNull(vString),
  priceMinor: vInt(0),
  compareAtPriceMinor: vOrNull(vInt(0)),
  stock: vInt(0),
  moq: vInt(1),
  sku: vOrNull(vString),
  isActive: vBool,
  imageUrl: vOrNull(vString),
  lowStockThreshold: vInt(0),
});

const vSfTheme: Check<SfTheme> = vObject({
  primaryColor: vString,
  accentColor: vString,
  fontHeading: vString,
  fontBody: vString,
  radius: vString,
  buttonStyle: vString,
});

const vSfCardStyle: Check<SfCardStyle> = vObject({
  nameFont: vString,
  nameSize: vString,
  nameAlign: vString,
  priceFont: vString,
  priceSize: vString,
  priceAlign: vString,
});

const vSfReviewItem: Check<SfReviewItem> = vObject({
  id: vString,
  orderId: vOrNull(vString),
  customerName: vString,
  rating: vInt(1),
  title: vOrNull(vString),
  body: vOrNull(vString),
  reply: vOrNull(vString),
  createdAt: vIso,
});

/** GET /api/sf/[slug]/products/[pSlug] — full PdpData */
export const vPdpData: Check<PdpData> = vObject({
  product: vObject({
    id: vString,
    title: vString,
    slug: vString,
    description: vOrNull(vString),
    priceMinor: vInt(0),
    compareAtPriceMinor: vOrNull(vInt(0)),
    ratingAvg: vNumber,
    ratingCount: vInt(0),
    salesCount: vInt(0),
    viewCount: vInt(0),
    categoryId: vOrNull(vString),
    categoryName: vOrNull(vString),
    images: vArray(vString),
    ratingDist: vArray(vNumber),
    variants: vArray(vPdpVariant),
  }),
  reviews: vArray(vSfReviewItem),
  related: vArray(vSfProductCard),
  store: vObject({
    id: vString,
    name: vString,
    slug: vString,
    tagline: vOrNull(vString),
    logoUrl: vOrNull(vString),
    whatsapp: vOrNull(vString),
    cardStyle: vOrNull(vSfCardStyle),
  }),
});

/** GET /api/sf/[slug]/products/[pSlug]/reviews — SfReviewsListData (paged) */
export const vSfReviewsListData: Check<SfReviewsListData> = vObject({ reviews: vArray(vSfReviewItem) });

// ------------------------------------------------------------------- cart §5

const vCartStore: Check<CartStore> = vObject({
  storeId: vString,
  storeSlug: vString,
  storeName: vString,
  itemCount: vInt(0),
  subtotalMinor: vInt(0),
});

const vCartItem: Check<CartItem> = vObject({
  id: vString,
  variantId: vString,
  productId: vString,
  title: vString,
  productSlug: vString,
  variantLabel: vString,
  unitPriceMinor: vInt(0),
  compareAtPriceMinor: vOrNull(vInt(0)),
  qty: vInt(1),
  stock: vInt(0),
  moq: vInt(1),
  lineTotalMinor: vInt(0),
  imageUrl: vString,
  storeId: vString,
  storeSlug: vString,
  storeName: vString,
  selected: vBool,
});

export const vCartView: Check<CartView> = vObject({
  id: vOrNull(vString),
  storeId: vOrNull(vString),
  storeSlug: vOrNull(vString),
  storeName: vOrNull(vString),
  token: vOrNull(vString),
  stores: vArray(vCartStore),
  items: vArray(vCartItem),
});

/** GET /api/cart — GetCartData */
export const vGetCartData: Check<GetCartData> = vObject({ cart: vCartView, requiresAuth: vBool });

/** POST /api/cart/items — AddCartItemData */
export const vAddCartItemData: Check<AddCartItemData> = vObject({ cart: vCartView, notice: vOrNull(vString) });

/** GET /api/cart/stock — StockProbeData */
export const vStockProbeData: Check<StockProbeData> = vObject({
  stocks: vRecord(vObject({ stock: vInt(0), moq: vInt(1), purchasable: vBool })),
});

const vCartSettingsDTO: Check<CartSettingsDTO> = vObject({
  layout: vString,
  showFreeShippingBar: vBool,
  freeShipThresholdMinor: vInt(0),
  upsellEnabled: vBool,
  upsellMode: vString,
  upsellTitle: vString,
  upsellLimit: vInt(0),
  urgencyStockEnabled: vBool,
  urgencyStockThreshold: vInt(0),
  urgencyViewersEnabled: vBool,
  urgencyViewersMin: vInt(0),
  urgencyViewersMax: vInt(0),
  urgencyCountdownEnabled: vBool,
  urgencyCountdownMinutes: vInt(0),
  showOrderNote: vBool,
  showDiscountHint: vBool,
  checkoutLabel: vString,
  showContinueShopping: vBool,
  stickyCta: vBool,
  trustBadges: vArray(vString),
});

/** GET /api/sf/[slug]/cart-settings — SfCartSettingsData */
export const vSfCartSettingsData: Check<SfCartSettingsData> = vObject({
  store: vObject({ id: vString, name: vString, slug: vString, theme: vSfTheme }),
  settings: vOrNull(vCartSettingsDTO),
  upsell: vArray(vUpsellCard),
  bestSellers: vArray(vUpsellCard),
});

// ------------------------------------------------------- auth & me (§2 / §6)

/** GET /api/auth/me — MeAnonymousData */
export const vMeAnonymousData: Check<MeAnonymousData> = vObject({ userType: vNull });

/** GET /api/auth/me — MeShopperData */
export const vMeShopperData: Check<MeShopperData> = vObject({
  userType: vLiteral("shopper"),
  shopper: vObject({ id: vString, email: vString, fullName: vString, phone: vOrNull(vString) }),
});

/** POST /api/auth/unified-login — UnifiedShopperData success variant */
export const vUnifiedShopperData: Check<UnifiedShopperData> = vObject({
  userType: vLiteral("shopper"),
  shopper: vObject({ id: vString, email: vString, fullName: vString, phone: vOrNull(vString) }),
  isAffiliate: vBool,
  token: vString,
  claimed: vObject(
    {
      addressesClaimed: vInt(0),
      ordersClaimed: vInt(0),
      skipped: vLiteral("email-unverified"),
    },
    ["skipped"],
  ),
  emailVerified: vBool,
  guestCartMerged: vInt(0),
});

/** GET /api/auth/dev-accounts — DevAccountsData (sandbox-only panel data) */
export const vDevAccountsData: Check<DevAccountsData> = vObject({
  title: vString,
  accounts: vArray(
    vObject({
      type: vLiteral("admin", "seller", "buyer", "affiliate"),
      label: vString,
      email: vString,
      password: vString,
      role: vOrNull(vString),
      status: vOrNull(vString),
    }),
  ),
});

/** GET /api/sf/app-config — SfAppConfigData */
export const vSfAppConfigData: Check<SfAppConfigData> = vObject({ footerVisible: vBool });

/** GET /api/market/search/suggest — MarketSuggestData */
export const vMarketSuggestData: Check<MarketSuggestData> = vObject({
  products: vArray(vSfProductCard),
  stores: vArray(vObject({ name: vString, slug: vString, logoUrl: vString })),
});

// ------------------------------------------------------------- me/orders §6

const vMeStoreRef: Check<MeStoreRef> = vObject({ id: vString, name: vString, slug: vString });

const vMeOrderSummaryItem: Check<MeOrderSummaryItem> = vObject({
  id: vString,
  title: vString,
  variantLabel: vOrNull(vString),
  qty: vInt(1),
  unitPriceMinor: vInt(0),
  productId: vOrNull(vString),
  imageUrl: vString,
});

const vMeOrderSummary: Check<MeOrderSummary> = vObject({
  id: vString,
  orderNumber: vString,
  status: vString,
  totalMinor: vInt(0),
  createdAt: vIso,
  receivedAt: vOrNull(vIso),
  paymentProvider: vOrNull(vString),
  trackingNumber: vOrNull(vString),
  shipmentStatus: vOrNull(vString),
  shippingCourierName: vOrNull(vString),
  store: vMeStoreRef,
  items: vArray(vMeOrderSummaryItem),
});

/** GET /api/me/orders — OrdersData (composite paged payload) */
export const vOrdersData: Check<OrdersData> = vObject({
  bucketCounts: vObject({
    to_pay: vInt(0),
    to_ship: vInt(0),
    to_receive: vInt(0),
    to_rate: vInt(0),
    completed: vInt(0),
    cancelled: vInt(0),
  }),
  orders: vArray(vMeOrderSummary),
});

// ------------------------------------------------- response capture & envelope

export interface CapturedResponse {
  method: string;
  url: URL;
  status: number;
  body: unknown;
}

/**
 * Records every JSON response served under /api/ by the dev server while the
 * page runs — the raw material for both the deep per-endpoint contract checks
 * and the global envelope sweep.
 */
export class ApiRecorder {
  private readonly captured: CapturedResponse[] = [];

  attach(page: Page): void {
    page.on("response", (res) => {
      try {
        const url = new URL(res.url());
        if (!url.pathname.startsWith("/api/")) return;
        const contentType = res.headers()["content-type"] ?? "";
        if (!contentType.includes("application/json")) return;
        void res
          .json()
          .then((body: unknown) => {
            this.captured.push({ method: res.request().method(), url, status: res.status(), body });
          })
          .catch(() => {
            /* body unavailable (e.g. aborted request) — nothing to validate */
          });
      } catch {
        /* malformed URL — never ours */
      }
    });
  }

  all(): readonly CapturedResponse[] {
    return this.captured;
  }

  first(pred: (c: CapturedResponse) => boolean): CapturedResponse | undefined {
    return this.captured.find(pred);
  }

  async waitFor(what: string, pred: (c: CapturedResponse) => boolean, timeout = 45_000): Promise<CapturedResponse> {
    let hit: CapturedResponse | null = null;
    await expect
      .poll(
        async () => {
          hit = this.captured.find(pred) ?? null;
          return hit !== null;
        },
        { timeout, message: `waiting for ${what}` },
      )
      .toBeTruthy();
    if (!hit) throw new Error(`Timed out waiting for ${what}`);
    return hit;
  }
}

/** True when the capture's `data.userType` discriminant equals `userType`. */
export function bodyHasUserType(c: CapturedResponse, userType: string): boolean {
  return isObj(c.body) && isObj(c.body.data) && c.body.data.userType === userType;
}

const envelopeKeysProblem = (c: CapturedResponse, label: string): string | null => {
  if (!isObj(c.body)) return `${label}: body is not a JSON object (${describe(c.body)})`;
  const keys = Object.keys(c.body);
  if (!keys.includes("data")) return `${label}: envelope missing "data" (keys: ${keys.join(", ") || "none"})`;
  if (keys.includes("error")) return `${label}: envelope carries BOTH "data" and "error"`;
  const extra = keys.filter((k) => k !== "data" && k !== "meta");
  if (extra.length > 0) return `${label}: envelope has keys beyond {data, meta}: ${extra.join(", ")}`;
  if (c.body.meta !== undefined && !isObj(c.body.meta)) return `${label}: envelope "meta" is not an object`;
  return null;
};

/** Asserts the success envelope from src/lib/api.ts ok()/okPaged() and validates `data`. */
export function expectOkEnvelope<T>(c: CapturedResponse, check: Check<T>, label: string): T {
  if (c.status < 200 || c.status >= 400) {
    throw new Error(`${label}: expected 2xx status, got ${c.status} (${JSON.stringify(c.body)})`);
  }
  const problem = envelopeKeysProblem(c, label);
  if (problem) throw new Error(problem);
  if (!isObj(c.body)) throw new Error(`${label}: body is not a JSON object (${describe(c.body)})`);
  return check(c.body.data, `${label} → data`);
}

/** Asserts the paged envelope okPaged() = {data, meta:{page,size,total}} and validates `data`. */
export function expectPagedEnvelope<T>(
  c: CapturedResponse,
  check: Check<T>,
  label: string,
): { data: T; meta: { page: number; size: number; total: number } } {
  if (c.status < 200 || c.status >= 400) {
    throw new Error(`${label}: expected 2xx status, got ${c.status} (${JSON.stringify(c.body)})`);
  }
  if (!isObj(c.body)) throw new Error(`${label}: body is not a JSON object (${describe(c.body)})`);
  const keys = Object.keys(c.body).sort();
  if (keys.join(",") !== "data,meta") {
    throw new Error(`${label}: paged envelope must be exactly {data, meta} (keys: ${keys.join(", ") || "none"})`);
  }
  const meta = vObject({ page: vInt(1), size: vInt(1), total: vInt(0) })(c.body.meta, `${label} → meta`);
  const data = check(c.body.data, `${label} → data`);
  return { data, meta };
}

/**
 * The universal layer of the harness: EVERY /api JSON response seen during the
 * run must use the platform envelope — 2xx carries `data` (optionally `meta`,
 * nothing else); ≥400 carries `error: {code, message, …}`. Returns the list of
 * violations (empty = clean bill of health for the sweep layer).
 */
export function sweepEnvelopes(items: readonly CapturedResponse[]): string[] {
  const problems: string[] = [];
  for (const c of items) {
    const label = `${c.method} ${c.url.pathname}${c.url.search} [${c.status}]`;
    try {
      if (c.status < 400) {
        const problem = envelopeKeysProblem(c, label);
        if (problem) problems.push(problem);
      } else {
        if (!isObj(c.body)) {
          problems.push(`${label}: error body is not a JSON object (${describe(c.body)})`);
          continue;
        }
        const err = c.body.error;
        if (!isObj(err)) {
          problems.push(`${label}: missing "error" object (keys: ${Object.keys(c.body).join(", ") || "none"})`);
          continue;
        }
        if (typeof err.code !== "string" || typeof err.message !== "string") {
          problems.push(`${label}: error.code / error.message must be strings`);
        }
        const extra = Object.keys(err).filter((k) => !["code", "message", "details", "meta"].includes(k));
        if (extra.length > 0) problems.push(`${label}: error has unexpected key(s): ${extra.join(", ")}`);
      }
    } catch (e) {
      problems.push(`${label}: sweep crashed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return problems;
}
