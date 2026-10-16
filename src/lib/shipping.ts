// ============================================================================
// TASK 10 — Smart shipping & fulfilment layer (lib engine)
// ============================================================================
// Provider abstraction `ShippingProvider` with a deterministic MOCK Malaysian
// courier network (providerId "mock"). No external network calls anywhere —
// AWB numbers, labels, tracking milestones and proof-of-delivery photos are
// all derived locally (lib/placeholder pipeline), so demos work fully offline.
//
// State machine (Shipment.status):
//   PENDING_BOOKING → BOOKED → PICKED_UP → IN_TRANSIT → OUT_FOR_DELIVERY
//                   → DELIVERED   (or EXCEPTION / RETURNED — not simulated v1)
//
// The demo advances without a cron: POST /api/shipping/tick advances every
// active mock shipment one step, and buyer-facing GET endpoints call
// maybeSyncTracking() lazily (45s per-shipment guard).
// ============================================================================
import { db } from "./db";
import { ApiError, dispatchStoreWebhooks, notify, transitionOrder } from "./api";
import { createNotification } from "./notify-shopper";
import { hashStr, placeholderDataUrl, svgDataUrl } from "./placeholder";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShippingParcel = {
  weightGrams: number;
  itemCount: number;
};

export type ShippingDestination = {
  state: string;
  postcode?: string | null;
};

export type ShippingQuote = {
  /** Stable key the ship route re-derives + validates on booking. */
  rateId: string;
  providerId: string;
  courierName: string;
  serviceLevel: string;
  priceMinor: number;
  etaFromDays: number;
  etaToDays: number;
};

export type ShippingZone = "peninsular" | "east";

export type ShipmentSnapshot = {
  id: string;
  orderId: string;
  status: string;
  providerId: string;
  awbNumber: string | null;
  courierName: string | null;
  labelUrl: string | null;
  bookedAt: Date | null;
  pickedUpAt: Date | null;
  etaFrom: Date | null;
  etaTo: Date | null;
  deliveredAt: Date | null;
  lastSyncedAt: Date | null;
};

export const MOCK_PROVIDER_ID = "mock";

/**_statuses the mock network actively advances. */
export const ACTIVE_SHIPMENT_STATUSES = ["BOOKED", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY"] as const;

const TRACK_FLOW: Record<string, string> = {
  BOOKED: "PICKED_UP",
  PICKED_UP: "IN_TRANSIT",
  IN_TRANSIT: "OUT_FOR_DELIVERY",
  OUT_FOR_DELIVERY: "DELIVERED",
};

// ---------------------------------------------------------------------------
// Zones + geography (deterministic, offline)
// ---------------------------------------------------------------------------

const EAST_MALAYSIA_STATES = new Set(["sabah", "sarawak", "labuan", "wp labuan"]);

export function zoneOf(dest: string | null | undefined): ShippingZone {
  const s = (dest ?? "").trim().toLowerCase();
  return EAST_MALAYSIA_STATES.has(s) ? "east" : "peninsular";
}

const STATE_CITY: Record<string, string> = {
  "kuala lumpur": "Kuala Lumpur",
  "selangor": "Shah Alam",
  "putrajaya": "Putrajaya",
  "cyberjaya": "Cyberjaya",
  "johor": "Johor Bahru",
  "kedah": "Alor Setar",
  "kelantan": "Kota Bharu",
  "melaka": "Melaka City",
  "malacca": "Melaka City",
  "negeri sembilan": "Seremban",
  "pahang": "Kuantan",
  "penang": "George Town",
  "pulau pinang": "George Town",
  "perak": "Ipoh",
  "perlis": "Kangar",
  "terengganu": "Kuala Terengganu",
  "sabah": "Kota Kinabalu",
  "sarawak": "Kuching",
  "labuan": "Labuan",
};

export function cityForState(dest: string | null | undefined): string {
  const s = (dest ?? "").trim().toLowerCase();
  return STATE_CITY[s] ?? "Kuala Lumpur";
}

const HUBS_PENINSULAR = [
  "Petaling Jaya Collection Centre",
  "Kuala Lumpur Hub (KL)",
  "Shah Alam Sortation Centre",
  "Johor Bahru Hub",
  "Penang Hub (Bayan Lepas)",
];
const HUBS_TRANSIT = [
  "KLIA Cargo Terminal, Sepang",
  "Shah Alam Regional Sortation",
  "Ipoh Transit Facility",
  "Melaka Cross-Dock",
];
const HUBS_EAST = ["Kuching Hub, Sarawak", "Kota Kinabalu Hub, Sabah", "Labuan Collection Centre"];

function pick<T>(pool: T[], seedStr: string): T {
  return pool[hashStr(seedStr) % pool.length];
}

// ---------------------------------------------------------------------------
// Rate card — fixed table so quote → book re-derivation always matches.
// ---------------------------------------------------------------------------

type CourierSpec = {
  code: string;
  name: string;
  serviceLevel: string;
  etaFromDays: number;
  etaToDays: number;
  /** base price by weight-band ceiling (grams) → minor, peninsular */
  bandsPen: Array<[number, number]>;
  /** east-malaysia multiplier applied on top of the peninsular band price */
  eastSurcharge: number;
  /** per-kg surcharge beyond the last band */
  perKgBeyondPen: number;
};

const COURIERS: CourierSpec[] = [
  {
    code: "jt",
    name: "J&T Express",
    serviceLevel: "economy",
    etaFromDays: 2,
    etaToDays: 4,
    bandsPen: [[500, 550], [1000, 690], [2000, 950], [3000, 1350], [5000, 1900], [10000, 3200]],
    eastSurcharge: 1.9,
    perKgBeyondPen: 260,
  },
  {
    code: "poslaju",
    name: "Pos Laju",
    serviceLevel: "standard",
    etaFromDays: 1,
    etaToDays: 3,
    bandsPen: [[500, 700], [1000, 900], [2000, 1250], [3000, 1700], [5000, 2400], [10000, 3900]],
    eastSurcharge: 2.0,
    perKgBeyondPen: 320,
  },
  {
    code: "citylink",
    name: "City-Link Express",
    serviceLevel: "standard_plus",
    etaFromDays: 1,
    etaToDays: 2,
    bandsPen: [[500, 850], [1000, 1100], [2000, 1500], [3000, 2000], [5000, 2800], [10000, 4500]],
    eastSurcharge: 2.1,
    perKgBeyondPen: 360,
  },
];

/** Deterministic parcel estimate: 150g packaging + 120g per ordered unit. */
export function parcelWeightForItems(items: { qty: number }[]): number {
  const units = items.reduce((s, i) => s + Math.max(0, Math.floor(i.qty)), 0);
  return 150 + units * 120;
}

function bandPriceMinor(spec: CourierSpec, weightGrams: number, zone: ShippingZone): number {
  let base = spec.bandsPen[spec.bandsPen.length - 1][1];
  for (const [ceiling, price] of spec.bandsPen) {
    if (weightGrams <= ceiling) {
      base = price;
      break;
    }
  }
  const lastCeiling = spec.bandsPen[spec.bandsPen.length - 1][0];
  if (weightGrams > lastCeiling) {
    const extraKg = Math.ceil((weightGrams - lastCeiling) / 1000);
    base += extraKg * spec.perKgBeyondPen;
  }
  return Math.round(base * (zone === "east" ? spec.eastSurcharge : 1));
}

/** Quote 3 Malaysian courier options — deterministic by (courier, weight, zone). */
export function quoteRates(parcel: ShippingParcel, dest: ShippingDestination): ShippingQuote[] {
  const zone = zoneOf(dest.state);
  return COURIERS.map((spec) => ({
    rateId: `${MOCK_PROVIDER_ID}:${spec.code}:${spec.serviceLevel}`,
    providerId: MOCK_PROVIDER_ID,
    courierName: spec.name,
    serviceLevel: spec.serviceLevel,
    priceMinor: bandPriceMinor(spec, Math.max(1, Math.round(parcel.weightGrams)), zone),
    etaFromDays: spec.etaFromDays + (zone === "east" ? 1 : 0),
    etaToDays: spec.etaToDays + (zone === "east" ? 3 : 0),
  }));
}

export function findQuote(rateId: string, parcel: ShippingParcel, dest: ShippingDestination): ShippingQuote | null {
  return quoteRates(parcel, dest).find((q) => q.rateId === rateId) ?? null;
}

// ---------------------------------------------------------------------------
// AWB + label + POD (all deterministic, offline-safe)
// ---------------------------------------------------------------------------

const AWB_DIGITS = 10;

/** `PLJ` + 10 digits — per-courier prefix (Pos Laju style) + hashed digits. */
export function awbFor(orderNumber: string, courierCode: string): string {
  const prefix =
    {
      poslaju: "PLJ",
      jt: "JTE",
      citylink: "CLX",
    }[courierCode] ?? "MYX";
  const h = hashStr(`${orderNumber}:${courierCode}:${Math.floor(Date.now() / 1000)}`);
  const digits = String(h % 10_000_000_000).padStart(AWB_DIGITS, "0");
  return `${prefix}${digits}`;
}

/** Barcode-ish deterministic vertical bars for an AWB number. */
function barcodeBars(awb: string, x0: number, y0: number, h: number): string {
  const rects: string[] = [];
  let x = x0;
  for (let i = 0; i < 44; i++) {
    const bit = hashStr(`${awb}:${i}`) % 3; // 0 thin, 1 mid, 2 thick
    const w = 2 + bit * 2;
    if (i % 2 === 0) rects.push(`<rect x="${x}" y="${y0}" width="${w}" height="${h}" fill="#111111"/>`);
    x += w + 2;
  }
  return rects.join("");
}

export type LabelInput = {
  awbNumber: string;
  courierName: string;
  orderNumber: string;
  storeName: string;
  destCity: string;
  destState: string;
  recipient: string;
  etaText: string;
};

/** AWB shipping label as an inline SVG (640×880) — printable, no fonts needed. */
export function labelSvgFor(input: LabelInput): string {
  const W = 640;
  const H = 880;
  const esc = (s: string) => s.replace(/[<>&]/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <rect x="0" y="0" width="${W}" height="110" fill="#0f766e"/>
  <text x="32" y="48" font-family="system-ui,Segoe UI,sans-serif" font-weight="700" font-size="34" fill="#ffffff">${esc(input.courierName)}</text>
  <text x="32" y="82" font-family="system-ui,Segoe UI,sans-serif" font-size="18" fill="#ccfbf1">Air Waybill · NOMOFEE mock network (sandbox)</text>
  <text x="${W - 32}" y="66" text-anchor="end" font-family="monospace" font-size="26" font-weight="700" fill="#ffffff">${esc(input.awbNumber)}</text>
  <rect x="32" y="140" width="${W - 64}" height="120" fill="none" stroke="#0f766e" stroke-width="3"/>
  ${barcodeBars(input.awbNumber, 52, 165, 70)}
  <text x="52" y="250" font-family="monospace" font-size="26" letter-spacing="6" fill="#111111">${esc(input.awbNumber)}</text>
  <text x="32" y="310" font-family="system-ui,Segoe UI,sans-serif" font-size="15" fill="#6b7280">FROM (SELLER)</text>
  <text x="32" y="338" font-family="system-ui,Segoe UI,sans-serif" font-weight="600" font-size="22" fill="#111111">${esc(input.storeName)}</text>
  <text x="32" y="392" font-family="system-ui,Segoe UI,sans-serif" font-size="15" fill="#6b7280">TO (RECIPIENT)</text>
  <text x="32" y="422" font-family="system-ui,Segoe UI,sans-serif" font-weight="700" font-size="26" fill="#111111">${esc(input.recipient)}</text>
  <text x="32" y="456" font-family="system-ui,Segoe UI,sans-serif" font-size="22" fill="#111111">${esc(input.destCity)}, ${esc(input.destState)}, Malaysia</text>
  <rect x="32" y="496" width="${W - 64}" height="96" fill="#f0fdfa"/>
  <text x="48" y="532" font-family="system-ui,Segoe UI,sans-serif" font-size="16" fill="#6b7280">ORDER REF</text>
  <text x="48" y="566" font-family="monospace" font-size="24" font-weight="700" fill="#0f766e">${esc(input.orderNumber)}</text>
  <text x="${W - 48}" y="532" text-anchor="end" font-family="system-ui,Segoe UI,sans-serif" font-size="16" fill="#6b7280">ETA</text>
  <text x="${W - 48}" y="566" text-anchor="end" font-family="system-ui,Segoe UI,sans-serif" font-size="20" font-weight="600" fill="#111111">${esc(input.etaText)}</text>
  <rect x="32" y="632" width="${W - 64}" height="150" fill="none" stroke="#9ca3af" stroke-dasharray="6 6"/>
  <text x="52" y="662" font-family="system-ui,Segoe UI,sans-serif" font-size="15" fill="#6b7280">COURIER SIGNATURE</text>
  <text x="52" y="756" font-family="system-ui,Segoe UI,sans-serif" font-size="14" fill="#9ca3af">Handled by NOMOFEE Fulfilment (demo). Not a valid postal document.</text>
  <text x="32" y="842" font-family="system-ui,Segoe UI,sans-serif" font-weight="700" font-size="18" fill="#dc2626">MOCK LABEL — DEMO USE ONLY</text>
</svg>`;
}

/** Deterministic mock proof-of-delivery "photo" (inline SVG data-URL). */
export function mockPodUrl(awb: string): string {
  return placeholderDataUrl({
    seed: `pod:${awb}`,
    w: 640,
    h: 480,
    label: "Proof of delivery",
  });
}

// ---------------------------------------------------------------------------
// Notification plumbing — delegates to the shared Task 10-d helper
// (src/lib/notify-shopper.ts) so buyer nudges behave identically across the
// payment / ship / deliver paths. Best-effort: never throws into the flow.
// ---------------------------------------------------------------------------

/** Buyer "Parcel on the way" nudge — called by both ship modes. */
export async function pushBuyerNotificationForShipped(input: {
  shopperId: string | null;
  orderNumber: string;
  storeId: string;
  storeName: string;
  storeSlug: string | null;
  courierName: string;
  awbNumber: string | null;
}): Promise<void> {
  await createNotification(
    input.shopperId,
    "order.shipped",
    "Parcel on the way",
    `Your order ${input.orderNumber} from ${input.storeName} is on the way via ${input.courierName}${input.awbNumber ? ` · AWB ${input.awbNumber}` : ""}`,
    { orderNumber: input.orderNumber, slug: input.storeSlug ?? undefined }
  );
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

export type BookingOrder = {
  id: string;
  orderNumber: string;
  storeId: string;
  storeName: string;
  customerName: string;
  shippingAddressJson: string;
  items: { qty: number }[];
};

function parseAddress(json: string): { line1?: string; city?: string; state?: string; postcode?: string } {
  try {
    const v = JSON.parse(json || "{}") as Record<string, unknown>;
    return {
      line1: typeof v.line1 === "string" ? v.line1 : undefined,
      city: typeof v.city === "string" ? v.city : undefined,
      state: typeof v.state === "string" ? v.state : undefined,
      postcode: typeof v.postcode === "string" ? v.postcode : undefined,
    };
  } catch {
    return {};
  }
}

export function etaTextFor(quote: ShippingQuote): string {
  return quote.etaFromDays === quote.etaToDays
    ? `${quote.etaFromDays} day${quote.etaFromDays === 1 ? "" : "s"}`
    : `${quote.etaFromDays}-${quote.etaToDays} working days`;
}

/**
 * Book the chosen quote for an order: creates/refreshes the Shipment (BOOKED),
 * stamps the AWB, generates the SVG label (inline data-URL) and writes the
 * first BOOKED ShipmentEvent. Deterministic + offline.
 */
export async function bookShipment(
  order: BookingOrder,
  quote: ShippingQuote
): Promise<ShipmentSnapshot> {
  const dest = parseAddress(order.shippingAddressJson);
  const now = new Date();
  const awb = awbFor(order.orderNumber, quote.rateId.split(":")[1] ?? "myx");
  const labelSvg = labelSvgFor({
    awbNumber: awb,
    courierName: quote.courierName,
    orderNumber: order.orderNumber,
    storeName: order.storeName,
    destCity: cityForState(dest.state),
    destState: dest.state || "Malaysia",
    recipient: order.customerName,
    etaText: etaTextFor(quote),
  });

  const data = {
    storeId: order.storeId,
    providerId: MOCK_PROVIDER_ID,
    providerRef: awb,
    status: "BOOKED",
    awbNumber: awb,
    courierName: quote.courierName,
    trackingUrl: null,
    labelUrl: svgDataUrl(labelSvg),
    bookedAt: now,
    pickedUpAt: null,
    etaFrom: new Date(now.getTime() + quote.etaFromDays * 24 * 3600 * 1000),
    etaTo: new Date(now.getTime() + quote.etaToDays * 24 * 3600 * 1000),
    deliveredAt: null,
    lastSyncedAt: now,
  };

  const shipment = await db.shipment.upsert({
    where: { orderId: order.id },
    create: { orderId: order.id, ...data },
    update: { ...data },
    include: { order: { select: { shopperId: true } } },
  });

  // Fresh tracking history for a new booking (upsert replaces stale rows).
  await db.shipmentEvent.deleteMany({ where: { shipmentId: shipment.id } });
  await db.shipmentEvent.create({
    data: {
      shipmentId: shipment.id,
      status: "BOOKED",
      description: `Shipping label created — parcel registered by ${quote.courierName} for ${order.storeName}`,
      location: `${order.storeName}, ${cityForState(dest.state)}`,
      occurredAt: now,
    },
  });

  return shapeShipment(shipment);
}

type ShipmentWithRelations = NonNullable<Awaited<ReturnType<typeof db.shipment.findFirst>>>;

function shapeShipment(s: ShipmentWithRelations): ShipmentSnapshot {
  return {
    id: s.id,
    orderId: s.orderId,
    status: s.status,
    providerId: s.providerId,
    awbNumber: s.awbNumber,
    courierName: s.courierName,
    labelUrl: s.labelUrl,
    bookedAt: s.bookedAt,
    pickedUpAt: s.pickedUpAt,
    etaFrom: s.etaFrom,
    etaTo: s.etaTo,
    deliveredAt: s.deliveredAt,
    lastSyncedAt: s.lastSyncedAt,
  };
}

// ---------------------------------------------------------------------------
// Delivery side-effects (shared by courier sync + manual seller deliver)
// ---------------------------------------------------------------------------

async function deliverySideEffects(input: {
  order: { id: string; orderNumber: string; customerEmail: string; shopperId: string | null; storeId: string };
  storeSlug: string | null;
  courierName: string | null;
  awbNumber: string | null;
  note: string;
  deliveredAt: Date;
}): Promise<void> {
  await dispatchStoreWebhooks({
    storeId: input.order.storeId,
    event: "order.delivered",
    payload: {
      orderNumber: input.order.orderNumber,
      awb: input.awbNumber,
      courier: input.courierName,
      deliveredAt: input.deliveredAt.toISOString(),
    },
  });
  await notify({
    event: "order.delivered",
    channel: "email",
    recipient: input.order.customerEmail,
    subject: `Your order ${input.order.orderNumber} was delivered`,
  });
  await createNotification(
    input.order.shopperId,
    "order.delivered",
    "Parcel delivered — confirm receipt",
    `${input.note} (${input.order.orderNumber})`,
    { orderNumber: input.order.orderNumber, slug: input.storeSlug ?? undefined }
  );
}

// ---------------------------------------------------------------------------
// Tracking sync — one realistic step per call
// ---------------------------------------------------------------------------

/**
 * Advance a mock shipment exactly one step down the state machine, writing a
 * ShipmentEvent with a plausible Malaysian location. On DELIVERED it attaches
 * the mock POD photo and flips the order to "delivered" (history via
 * transitionOrder). Idempotent-safe: non-active shipments are returned as-is.
 */
export async function syncTracking(shipmentId: string): Promise<ShipmentSnapshot | null> {
  const shipment = await db.shipment.findUnique({
    where: { id: shipmentId },
    include: { order: { select: { id: true, orderNumber: true, status: true, customerEmail: true, shopperId: true, storeId: true, shippingAddressJson: true, store: { select: { slug: true } } } } },
  });
  if (!shipment) return null;
  if (!ACTIVE_SHIPMENT_STATUSES.includes(shipment.status as (typeof ACTIVE_SHIPMENT_STATUSES)[number])) {
    return shapeShipment(shipment);
  }

  const next = TRACK_FLOW[shipment.status];
  const now = new Date();
  const awb = shipment.awbNumber ?? "UNKNOWN";
  const destState = parseAddress(shipment.order.shippingAddressJson ?? "{}").state ?? "";
  const destCity = cityForState(destState);

  const steps: Record<string, { description: string; location: string; patch: Record<string, unknown> }> = {
    PICKED_UP: {
      description: `Parcel collected by ${shipment.courierName ?? "courier"} from the seller`,
      location: pick(zoneOf(destState) === "east" ? HUBS_EAST : HUBS_PENINSULAR, `${awb}:pickup`),
      patch: { pickedUpAt: now },
    },
    IN_TRANSIT: {
      description: "Arrived at transit facility — departing on the next scheduled trailer",
      location: pick(HUBS_TRANSIT, `${awb}:transit`),
      patch: {},
    },
    OUT_FOR_DELIVERY: {
      description: "Out for delivery — your courier is on the way",
      location: `${destCity} Delivery Base`,
      patch: {},
    },
    DELIVERED: {
      description: "Delivered — signed by recipient at the delivery address",
      location: destCity,
      patch: { deliveredAt: now },
    },
  };
  const step = steps[next];

  await db.shipmentEvent.create({
    data: {
      shipmentId: shipment.id,
      status: next,
      description: step.description,
      location: step.location,
      occurredAt: now,
      ...(next === "DELIVERED" ? { proofImageUrl: mockPodUrl(awb) } : {}),
    },
  });

  const updated = await db.shipment.update({
    where: { id: shipment.id },
    data: { status: next, lastSyncedAt: now, ...step.patch },
    include: { order: { select: { id: true, orderNumber: true, status: true, customerEmail: true, shopperId: true, storeId: true, store: { select: { slug: true } } } } },
  });

  if (next === "DELIVERED") {
    if (["shipped", "processing"].includes(updated.order.status)) {
      await transitionOrder({
        orderId: updated.order.id,
        toStatus: "delivered",
        actor: "courier",
        note: `Delivered by ${updated.courierName ?? "courier"} (mock network) · AWB ${awb}`,
        timestamps: { deliveredAt: now },
      });
    }
    await deliverySideEffects({
      order: updated.order,
      storeSlug: updated.order.store?.slug ?? null,
      courierName: updated.courierName,
      awbNumber: awb,
      note: `Delivered by ${updated.courierName ?? "courier"}`,
      deliveredAt: now,
    });
  }

  return shapeShipment(updated);
}

/**
 * Lazy sync for read endpoints: only advances when the shipment has been idle
 * for longer than `minIntervalMs` (default 45s — the dev demo cadence).
 * Never throws: lazy side-roads must not break the primary read.
 */
export async function maybeSyncTracking(
  shipmentId: string,
  minIntervalMs = 45_000
): Promise<ShipmentSnapshot | null> {
  try {
    const s = await db.shipment.findUnique({
      where: { id: shipmentId },
      select: { id: true, status: true, lastSyncedAt: true },
    });
    if (!s || !ACTIVE_SHIPMENT_STATUSES.includes(s.status as (typeof ACTIVE_SHIPMENT_STATUSES)[number])) return null;
    if (s.lastSyncedAt && Date.now() - s.lastSyncedAt.getTime() < minIntervalMs) return null;
    return await syncTracking(shipmentId);
  } catch (e) {
    console.error("[shipping] lazy sync failed", e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tick — advance ALL active mock shipments one step (cron-ish sweep)
// ---------------------------------------------------------------------------

export async function tickShipments(limit = 100): Promise<{ advanced: number; results: { shipmentId: string; orderId: string; awbNumber: string | null; status: string }[] }> {
  const rows = await db.shipment.findMany({
    where: { providerId: MOCK_PROVIDER_ID, status: { in: [...ACTIVE_SHIPMENT_STATUSES] } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  const results: { shipmentId: string; orderId: string; awbNumber: string | null; status: string }[] = [];
  for (const r of rows) {
    const s = await syncTracking(r.id);
    if (s) results.push({ shipmentId: s.id, orderId: s.orderId, awbNumber: s.awbNumber, status: s.status });
  }
  return { advanced: results.length, results };
}

// ---------------------------------------------------------------------------
// Fast-forward — manual "mark delivered" backfill
// ---------------------------------------------------------------------------

/**
 * Seller marks delivered manually while a platform shipment exists: backfill
 * the skipped milestone events between bookedAt and deliveredAt (strictly
 * increasing, never OUT_FOR_DELIVERY after DELIVERED), append the DELIVERED
 * event with the proof photo, flip shipment + order states.
 */
export async function fastForwardDelivery(
  orderId: string,
  deliveredAt: Date,
  proofUrl?: string | null
): Promise<ShipmentSnapshot | null> {
  const shipment = await db.shipment.findUnique({
    where: { orderId },
    include: {
      order: {
        select: {
          id: true, orderNumber: true, status: true, customerEmail: true, shopperId: true, storeId: true,
          shippingAddressJson: true,
          store: { select: { slug: true } },
        },
      },
    },
  });
  if (!shipment) return null;

  const awb = shipment.awbNumber ?? "UNKNOWN";
  const destState = parseAddress(shipment.order.shippingAddressJson ?? "{}").state ?? "";
  const destCity = cityForState(destState);
  const booked = shipment.bookedAt ?? shipment.createdAt;
  const span = Math.max(60_000, deliveredAt.getTime() - booked.getTime());
  const at = (frac: number) => new Date(booked.getTime() + Math.round(span * frac));

  const existing = await db.shipmentEvent.findMany({
    where: { shipmentId: shipment.id },
    select: { status: true },
  });
  const have = new Set(existing.map((e) => e.status));

  // Backfill plan, ordered, timestamps clamped to [booked, deliveredAt].
  const plan: { status: string; frac: number; description: string; location: string; proof?: boolean }[] = [];
  if (!have.has("BOOKED"))
    plan.push({
      status: "BOOKED",
      frac: 0,
      description: `Shipping label created — parcel registered by ${shipment.courierName ?? "courier"}`,
      location: `Seller warehouse, ${destCity}`,
    });
  if (!have.has("PICKED_UP"))
    plan.push({
      status: "PICKED_UP",
      frac: 0.12,
      description: `Parcel collected by ${shipment.courierName ?? "courier"} from the seller`,
      location: pick(zoneOf(destState) === "east" ? HUBS_EAST : HUBS_PENINSULAR, `${awb}:pickup`),
    });
  if (!have.has("IN_TRANSIT"))
    plan.push({
      status: "IN_TRANSIT",
      frac: 0.4,
      description: "Arrived at transit facility — line-haul departed on time",
      location: pick(HUBS_TRANSIT, `${awb}:transit`),
    });
  if (!have.has("OUT_FOR_DELIVERY"))
    plan.push({
      status: "OUT_FOR_DELIVERY",
      frac: 0.9,
      description: "Out for delivery — courier completing the neighbourhood route",
      location: `${destCity} Delivery Base`,
    });
  plan.push({
    status: "DELIVERED",
    frac: 1,
    description: "Delivered — signed by recipient at the delivery address",
    location: destCity,
    proof: true,
  });

  let prev = booked.getTime() - 1;
  for (const p of plan) {
    let ts = Math.min(Math.max(at(p.frac).getTime(), prev + 1), deliveredAt.getTime());
    if (p.status === "DELIVERED") ts = deliveredAt.getTime();
    await db.shipmentEvent.create({
      data: {
        shipmentId: shipment.id,
        status: p.status,
        description: p.description,
        location: p.location,
        occurredAt: new Date(ts),
        ...(p.proof ? { proofImageUrl: proofUrl ?? mockPodUrl(awb) } : {}),
      },
    });
    prev = ts;
  }

  const updated = await db.shipment.update({
    where: { id: shipment.id },
    data: {
      status: "DELIVERED",
      deliveredAt,
      lastSyncedAt: new Date(),
      pickedUpAt: shipment.pickedUpAt ?? at(0.12),
    },
    include: { order: { select: { id: true, orderNumber: true, status: true, customerEmail: true, shopperId: true, storeId: true, store: { select: { slug: true } } } } },
  });

  if (["shipped", "processing"].includes(updated.order.status)) {
    await transitionOrder({
      orderId: updated.order.id,
      toStatus: "delivered",
      actor: "seller",
      note: "Seller marked the parcel delivered",
      timestamps: { deliveredAt },
    });
  }
  await deliverySideEffects({
    order: updated.order,
    storeSlug: updated.order.store?.slug ?? null,
    courierName: updated.courierName,
    awbNumber: awb,
    note: `Delivered by ${updated.courierName ?? "the seller"}`,
    deliveredAt,
  });

  return shapeShipment(updated);
}

// ---------------------------------------------------------------------------
// Shared helpers for routes
// ---------------------------------------------------------------------------

/** Ship-guard parity helper: throws ApiError when the order cannot be shipped. */
export function assertShippable(order: { status: string; orderNumber: string }): void {
  if (!["paid", "processing"].includes(order.status)) {
    throw new ApiError(409, "INVALID_STATUS", `Cannot ship order ${order.orderNumber} in status '${order.status}'`);
  }
}

/** Validate a seller-uploaded proof-of-delivery data-URL (≤1.2MB). */
export function validateProofDataUrl(proof: unknown): string | null {
  if (proof == null) return null;
  const s = String(proof);
  if (!s.startsWith("data:image/")) {
    throw new ApiError(400, "VALIDATION", "proof must be a data:image/* URL");
  }
  if (s.length > 1_200_000) {
    throw new ApiError(413, "PROOF_TOO_LARGE", "proof image must be 1.2MB or smaller");
  }
  return s;
}
