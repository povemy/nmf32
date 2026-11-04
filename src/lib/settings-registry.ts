// Settings registry — single source of truth for every Setting key the admin
// Settings page knows how to render. PURE DATA (no server imports) so both the
// API route and the client Settings UI can import it without pulling Prisma
// into the browser bundle.
//
// Honesty rule (RX-CHECKLIST addendum #6): a key may only ship `wired: true`
// when running code actually reads it. Unwired keys render with a "Not wired"
// badge instead of pretending to work.

export type SettingField =
  | { kind: "boolean"; default: boolean }
  | {
      kind: "integer";
      default: number;
      min: number;
      max: number;
      /** Rendered as a major-unit money/quantity input (e.g. minor → RM). */
      major?: { label: string; factor: number; decimals: number };
    }
  | { kind: "enum"; default: string; options: { value: string; label: string }[] }
  | { kind: "string"; default: string }
  | { kind: "weights"; default: Record<string, number>; keys: { key: string; label: string }[] }
  | { kind: "string_list"; default: string[]; options: { value: string; label: string }[] }
  | { kind: "readonly" }
  | { kind: "json" };

export type SettingGroup = {
  id: string;
  label: string;
  description: string;
  icon: "store" | "banknote" | "shield" | "credit-card" | "sliders" | "activity" | "wrench";
  order: number;
};

export type SettingMeta = {
  key: string;
  group: string;
  label: string;
  description: string;
  field: SettingField;
  /** Consumed by running code? */
  wired: boolean;
  /** When it takes effect / why it is not wired yet. */
  wiredNote?: string;
  /** Destructive or test-only semantics — render with a warning accent. */
  danger?: boolean;
  /** Internal/test keys never rendered in the friendly UI. */
  hidden?: boolean;
};

export const SETTING_GROUPS: SettingGroup[] = [
  {
    id: "storefront",
    label: "Storefront",
    description: "Controls the shopper-facing web app chrome.",
    icon: "store",
    order: 1,
  },
  {
    id: "payouts",
    label: "Payouts",
    description: "Seller payout rules — amounts, method and cadence.",
    icon: "banknote",
    order: 2,
  },
  {
    id: "moderation",
    label: "Moderation",
    description: "Product review policy for new sellers.",
    icon: "shield",
    order: 3,
  },
  {
    id: "payments",
    label: "Payments & PSP",
    description: "Gateway rails — sandbox mock controls and payout mode.",
    icon: "credit-card",
    order: 4,
  },
  {
    id: "ranking",
    label: "Ranking",
    description: "Marketplace search ordering.",
    icon: "sliders",
    order: 5,
  },
  {
    id: "analytics",
    label: "Analytics",
    description: "Seller Insights event retention and maintenance.",
    icon: "activity",
    order: 6,
  },
  {
    id: "system",
    label: "System",
    description: "Read-only runtime state written by schedulers and workers.",
    icon: "activity",
    order: 7,
  },
  {
    id: "affiliate",
    label: "Affiliate",
    description: "Affiliate programme availability, rates and payout rules.",
    icon: "banknote",
    order: 8,
  },
  {
    id: "advanced",
    label: "Advanced",
    description: "Unrecognised keys — edit as raw JSON. Shown for forward compatibility.",
    icon: "wrench",
    order: 99,
  },
];

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export const SETTINGS_REGISTRY: SettingMeta[] = [
  // ---------------------------------------------------------- Storefront
  {
    key: "ui.footer_visible",
    group: "storefront",
    label: "Show global footer",
    description:
      "Toggles the teal footer at the bottom of the shopper web app (market home, search, product pages, store pages). Checkout and payment screens never show it.",
    field: { kind: "boolean", default: true },
    wired: true,
    wiredNote: "Takes effect the next time the shopper app loads (cached up to 60 s).",
  },
  {
    key: "home.section_order",
    group: "storefront",
    label: "Homepage section order",
    description:
      "JSON array of homepage section ids in render order (work order 14). Managed with up/down controls in Marketing → Homepage Layout — prefer that page over editing raw JSON here. Omitted sections are hidden; hero is always first; up to 3 'inline' promo slots.",
    field: { kind: "json" },
    wired: true,
    wiredNote: "Read by /api/market/home on every homepage load (cached ≤ 60 s); changes apply within that window.",
  },
  {
    key: "maintenance.mode",
    group: "storefront",
    label: "Maintenance mode",
    description: "Reserved for a storefront-wide maintenance screen. Not enforced by the current storefront build.",
    field: { kind: "boolean", default: false },
    wired: false,
    wiredNote: "Not wired yet — flipping this has no effect in the current version.",
  },

  // ------------------------------------------------------------- Payouts
  {
    key: "payout.min_minor",
    group: "payouts",
    label: "Minimum payout amount",
    description: "Sellers cannot request a payout below this amount. Stored in minor units (sen); edited as RM.",
    field: { kind: "integer", default: 1000, min: 0, max: 10_000_000, major: { label: "RM", factor: 100, decimals: 2 } },
    wired: true,
    wiredNote: "Enforced when sellers request payouts and when admin runs payout batches.",
  },
  {
    key: "payout.mode",
    group: "payouts",
    label: "Payout method",
    description: "manual_csv = finance exports a bank file and marks batches paid by hand. bank_transfer = staged for the PSP payout adapter.",
    field: {
      kind: "enum",
      default: "manual_csv",
      options: [
        { value: "manual_csv", label: "Manual CSV (bank file export)" },
        { value: "bank_transfer", label: "Bank transfer (PSP adapter)" },
      ],
    },
    wired: true,
    wiredNote: "Read when payout batches are created and when due payouts are listed.",
  },
  {
    key: "payout.schedule.day",
    group: "payouts",
    label: "Weekly payout run day",
    description: "Reserved for the weekly payout cadence. Batches are currently run manually or by cron ticks.",
    field: {
      kind: "enum",
      default: "monday",
      options: WEEKDAYS.map((d) => ({ value: d, label: d[0].toUpperCase() + d.slice(1) })),
    },
    wired: false,
    wiredNote: "Not wired yet — no scheduler reads this key in the current version.",
  },

  // ---------------------------------------------------------- Moderation
  {
    key: "moderation.first_n",
    group: "moderation",
    label: "New-seller review window",
    description:
      "A new seller's first N products (0–100) go to Product Moderation before they go live. Set 0 to publish immediately.",
    field: { kind: "integer", default: 5, min: 0, max: 100 },
    wired: true,
    wiredNote: "Applied every time a seller creates a product.",
  },

  // ------------------------------------------------- Payments & PSP
  {
    key: "psp.mock.enabled",
    group: "payments",
    label: "Sandbox mock payment rails",
    description:
      "Keeps the demo checkout / payout simulation endpoints available. Production guard: in a production deployment this must be OFF or the mock rails stay reachable.",
    field: { kind: "boolean", default: true },
    wired: true,
    wiredNote: "Read on every mock payment / payout simulate call (production deployments only).",
    danger: true,
  },
  {
    key: "psp.payouts.mode",
    group: "payments",
    label: "PSP payout mode",
    description:
      "manual = the current human payout flow (safe default). transfer / bank_payout engage the PSP payout adapter phases once a real provider is connected.",
    field: {
      kind: "enum",
      default: "manual",
      options: [
        { value: "manual", label: "Manual (human payout flow)" },
        { value: "transfer", label: "Transfer (adapter phase)" },
        { value: "bank_payout", label: "Bank payout (adapter phase)" },
      ],
    },
    wired: false,
    wiredNote:
      "Not yet wired — read only by the dormant PSP payout adapter scaffold (src/lib/psp-adapter.ts, resolvePayoutMode). No payout flow invokes the adapter today; it engages when a real provider payout phase ships. Unknown/missing values still fall back to manual, so money can never move on a malformed value.",
  },
  {
    key: "psp.mock.refund.behavior",
    group: "payments",
    label: "Mock refund behaviour (test control)",
    description:
      "Forces the sandbox mock PSP refund rails to succeed, reject, or hang. Used by the late-payment refund test suite — leave on Succeed outside testing.",
    field: {
      kind: "enum",
      default: "succeed",
      options: [
        { value: "succeed", label: "Succeed (normal)" },
        { value: "reject", label: "Reject (provider refuses)" },
        { value: "timeout", label: "Timeout (provider hangs)" },
      ],
    },
    wired: true,
    wiredNote: "Sandbox-only adapter; production refund execution replaces it entirely.",
    danger: true,
  },
  {
    key: "payments.providers",
    group: "payments",
    label: "Enabled payment providers (informational)",
    description:
      "Legacy list from the original seed — informational only. The checkout method list buyers actually see and the server accepts comes from the single source in src/lib/payment-methods.ts (F-14), not this key and not the PSP adapter registry.",
    field: {
      kind: "string_list",
      default: ["fpx_toyyibpay", "tng", "grabpay", "card_stripe"],
      options: [
        { value: "fpx_toyyibpay", label: "FPX (ToyyibPay)" },
        { value: "fpx_ipay88", label: "FPX (iPay88)" },
        { value: "tng", label: "Touch ’n Go eWallet" },
        { value: "grabpay", label: "GrabPay" },
        { value: "card_stripe", label: "Cards (Stripe)" },
        { value: "card_curlec", label: "Cards (Curlec)" },
      ],
    },
    wired: false,
    wiredNote: "Not wired — informational only in the current version.",
  },

  // ------------------------------------------------------------- Ranking
  {
    key: "ranking.weights",
    group: "ranking",
    label: "Search ranking weights",
    description: "Reserved for marketplace ranking tuning. Search currently uses fixed internal weights.",
    field: {
      kind: "weights",
      default: { recency: 0.4, sales: 0.3, rating: 0.2, ctr: 0.1 },
      keys: [
        { key: "recency", label: "Recency" },
        { key: "sales", label: "Sales" },
        { key: "rating", label: "Rating" },
        { key: "ctr", label: "Click-through" },
      ],
    },
    wired: false,
    wiredNote: "Not wired yet — no search path reads this key in the current version.",
  },

  // -------------------------------------------------------------- System
  {
    key: "cron.expiry_sweep.last",
    group: "system",
    label: "Expiry sweep — last run",
    description: "Outcome of the most recent payment-window expiry tick (written by the expiry scheduler).",
    field: { kind: "readonly" },
    wired: true,
  },
  {
    key: "cron.refund_reconcile.last",
    group: "system",
    label: "Refund reconcile — last run",
    description: "Outcome of the most recent refund-reconciliation tick (written by the scheduler).",
    field: { kind: "readonly" },
    wired: true,
  },
  {
    key: "cron.analytics.last",
    group: "system",
    label: "Analytics retention — last run",
    description: "Outcome of the most recent Seller-Insights retention tick (written by the scheduler).",
    field: { kind: "readonly" },
    wired: true,
  },

  // ----------------------------------------------------------- Analytics
  {
    key: "analytics.retention_days",
    group: "analytics",
    label: "Analytics event retention (days)",
    description:
      "Seller Insights browsing/cart events older than this are permanently deleted by the scheduled retention tick. Order, payment and refund records are NEVER deleted by this rule — sales history is authoritative and permanent.",
    field: { kind: "integer", default: 180, min: 7, max: 730 },
    wired: true,
    wiredNote:
      "Enforced by /api/cron/analytics-tick (reads THIS key; env SI_RETENTION_DAYS is only the fallback when the row is absent — F-11). Called by the expiry scheduler service.",
    danger: true,
  },

  // ----------------------------------------------------------- Affiliate
  {
    key: "affiliate.enabled",
    group: "affiliate",
    label: "Affiliate programme enabled",
    description:
      "Master switch (kill switch). When off: no new commission liabilities are computed at checkout or posted at payment, promotional links still navigate but stop recording attribution, and the Affiliate Hub shows the programme as paused. Existing commission records are immutable and unaffected.",
    field: { kind: "boolean", default: true },
    wired: true,
    wiredNote: "Read by lib/affiliate.ts getAffiliateSettings() at checkout, payment posting, activation, discovery and hub gates.",
    danger: true,
  },
  {
    key: "affiliate.sponsor_enabled",
    group: "affiliate",
    label: "One-level sponsor override enabled (90/10 split)",
    description:
      "When on, the direct affiliate receives 90% of the commission pool and their one direct sponsor receives 10%. When off, the direct affiliate receives 100%. The decision is FROZEN PER ORDER at checkout (OrderItem.affiliateSponsorEnabled) — changing this never rewrites in-flight or historical orders. PRODUCTION LAUNCH GATE: legal clearance required before enabling (see docs/affiliate/rollout-checklist.md).",
    field: { kind: "boolean", default: false },
    wired: true,
    wiredNote: "Frozen onto each OrderItem at checkout; applied at commission POSTING time (webhook payment confirmation) from the frozen snapshot — the split is computed once, then immutable.",
    danger: true,
  },
  {
    key: "affiliate.collections_enabled",
    group: "affiliate",
    label: "Affiliate collections enabled (deferred feature)",
    description:
      "Curated affiliate collections are DEFERRED for the initial release. While off: collection creation, publishing and new collection promotional links fail closed, and public collection pages return not-found. Historical collections and their data are preserved (readable by their owner) — flipping this on deliberately re-enables the full feature.",
    field: { kind: "boolean", default: false },
    wired: true,
    wiredNote: "Read by /api/affiliate/collections*, /api/affiliate/links*, /api/affiliate/pub/collection/* and link tracking (lib/affiliate-attribution.ts).",
  },
  {
    key: "affiliate.showcase_enabled",
    group: "affiliate",
    label: "Affiliate public showcases enabled (deferred feature)",
    description:
      "Public affiliate showcase pages are DEFERRED for the initial release. While off: new showcase promotional links fail closed and public showcase pages return not-found. Product and store affiliate links are NOT affected by this switch. Historical data is preserved — flip on deliberately to re-enable.",
    field: { kind: "boolean", default: false },
    wired: true,
    wiredNote: "Read by /api/affiliate/links*, /api/affiliate/pub/showcase/* and link tracking (lib/affiliate-attribution.ts).",
  },
  {
    key: "affiliate.max_rate_bps",
    group: "affiliate",
    label: "Maximum commission rate (basis points)",
    description:
      "Platform ceiling for seller-funded affiliate commission rates. Seller product/store rates are clamped to this at every read (checkout, discovery, seller settings). 1000 = 10% (launch ceiling).",
    field: { kind: "integer", default: 1000, min: 0, max: 10000 },
    wired: true,
    wiredNote: "Enforced by effectiveAffiliateRateBps() (lib/affiliate.ts) at checkout and by the seller settings route.",
  },
  {
    key: "affiliate.attr_window_days",
    group: "affiliate",
    label: "Product attribution window (days)",
    description:
      "How long a promotional-link click stays eligible for last-click product-sale attribution. Default 30 days.",
    field: { kind: "integer", default: 30, min: 1, max: 365 },
    wired: true,
    wiredNote: "Applied when attribution touches are recorded and re-validated at checkout resolution.",
  },
  {
    key: "affiliate.sponsor_window_days",
    group: "affiliate",
    label: "Referral attribution window (days)",
    description:
      "How long a first-touch referral visit stays valid for sponsor assignment when the visitor activates as an affiliate. Default 30 days, first valid touch wins.",
    field: { kind: "integer", default: 30, min: 1, max: 365 },
    wired: true,
    wiredNote: "Applied at referral-touch recording and activation validation (lib/affiliate.ts activateAffiliate).",
  },
  {
    key: "affiliate.review_days",
    group: "affiliate",
    label: "Commission review window (days)",
    description:
      "Days after an order reaches an authoritative delivered/completed state before the approved affiliate commission becomes available for payout (return/refund review period).",
    field: { kind: "integer", default: 14, min: 0, max: 365 },
    wired: true,
    wiredNote: "Sets entry availableAt at approval (deliver/receive routes + /api/cron/affiliate-tick sweep).",
  },
  {
    key: "affiliate.min_payout_minor",
    group: "affiliate",
    label: "Minimum payout amount",
    description: "Minimum requestable affiliate payout. Payouts are executed manually by finance (bank transfer reference recorded on the payout row).",
    field: { kind: "integer", default: 1000, min: 0, max: 10000000, major: { label: "RM", factor: 100, decimals: 2 } },
    wired: true,
    wiredNote: "Enforced at payout request (lib/affiliate.ts requestAffiliatePayout).",
  },

  // ---------------------------------------------- hidden internal keys
  { key: "lt.seed.state", group: "system", label: "", description: "", field: { kind: "readonly" }, wired: false, hidden: true },
  { key: "recon.fault", group: "system", label: "", description: "", field: { kind: "readonly" }, wired: false, hidden: true },
];

/** Metadata for a key. Unknown keys fall back to the Advanced raw-JSON editor. */
export function settingMetaFor(key: string): SettingMeta {
  const found = SETTINGS_REGISTRY.find((m) => m.key === key);
  if (found) return found;
  return {
    key,
    group: "advanced",
    label: key,
    description: "Unrecognised setting — edit the raw JSON value carefully.",
    field: { kind: "json" },
    wired: false,
  };
}

/** Default valueJson for a registry entry (used when the key is absent from the DB). */
export function defaultJsonValue(field: SettingField): string {
  switch (field.kind) {
    case "boolean":
      return JSON.stringify(field.default);
    case "integer":
      return JSON.stringify(field.default);
    case "enum":
      return JSON.stringify(field.default);
    case "string":
      return JSON.stringify(field.default);
    case "weights":
      return JSON.stringify(field.default);
    case "string_list":
      return JSON.stringify(field.default);
    default:
      return "null";
  }
}

/** Server-side type validation for a draft value. Returns the normalized
 *  valueJson to store, or an error message when the draft is invalid. */
export function validateSettingValue(key: string, draft: string): { ok: true; valueJson: string } | { ok: false; error: string } {
  const meta = settingMetaFor(key);
  const field = meta.field;
  const trimmed = draft.trim();

  const parsed = (() => {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return undefined;
    }
  })();

  switch (field.kind) {
    case "boolean": {
      if (typeof parsed === "boolean") return { ok: true, valueJson: trimmed };
      if (trimmed === "true" || trimmed === "false") return { ok: true, valueJson: trimmed };
      return { ok: false, error: "Value must be ON or OFF." };
    }
    case "integer": {
      const n = typeof parsed === "number" ? parsed : Number(trimmed);
      if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: "Enter a whole number." };
      if (n < field.min || n > field.max) return { ok: false, error: `Must be between ${field.min} and ${field.max}.` };
      return { ok: true, valueJson: String(n) };
    }
    case "enum": {
      if (typeof parsed === "string" && field.options.some((o) => o.value === parsed)) return { ok: true, valueJson: JSON.stringify(parsed) };
      return { ok: false, error: "Pick one of the listed options." };
    }
    case "string": {
      if (typeof parsed === "string") return { ok: true, valueJson: JSON.stringify(parsed) };
      if (typeof parsed === "undefined" && trimmed !== "") return { ok: true, valueJson: JSON.stringify(trimmed) };
      return { ok: false, error: "Enter a text value." };
    }
    case "weights": {
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "Expected an object of weights." };
      const obj = parsed as Record<string, unknown>;
      const out: Record<string, number> = {};
      for (const k of field.keys) {
        const v = Number(obj[k.key]);
        if (!Number.isFinite(v)) return { ok: false, error: `${k.label} must be a number.` };
        if (v < 0 || v > 1) return { ok: false, error: `${k.label} must be between 0 and 1.` };
        out[k.key] = v;
      }
      return { ok: true, valueJson: JSON.stringify(out) };
    }
    case "string_list": {
      if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "string")) return { ok: false, error: "Expected a list of provider ids." };
      return { ok: true, valueJson: JSON.stringify(parsed) };
    }
    case "readonly":
      return { ok: false, error: "This setting is written by the system and cannot be edited." };
    case "json":
    default: {
      if (parsed === undefined) return { ok: false, error: "Value must be valid JSON." };
      return { ok: true, valueJson: trimmed };
    }
  }
}
