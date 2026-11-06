// Buyer-facing shipping DISPLAY constants for the PDP (purchase-confidence
// section). The authoritative engine lives in src/app/api/checkout/pricing.ts
// (FREE_SHIP_THRESHOLD_MINOR + SHIPPING_RATES) — checkout revalidates every
// cent server-side; these mirrors exist ONLY so the PDP can preview the real
// rates without importing the server module into a client bundle. Keep the
// values in sync when pricing.ts changes (both files grep-match on "10000").
export const PDP_SHIPPING_DISPLAY = {
  freeShipThresholdMinor: 10000, // RM 100 — free STANDARD delivery per seller group
  standard: { label: "Standard", eta: "2-4 working days", amountMinor: 800 },
  express: { label: "Express", eta: "1-2 working days", amountMinor: 1500, note: "West Malaysia only" },
} as const;
