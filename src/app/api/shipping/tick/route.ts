import { handle, ok } from "@/lib/api";
import { tickShipments } from "@/lib/shipping";

export const dynamic = "force-dynamic";

// POST /api/shipping/tick — advances EVERY active mock shipment one realistic
// step (cron-ish sweep for the sandbox). Intentionally unauthenticated: it only
// advances the offline simulation, and the buyer endpoints drive the same
// engine lazily. A short in-memory throttle stops request stampedes.
const TICK_THROTTLE_MS = 1_500;

export const POST = handle(async () => {
  const g = globalThis as Record<string, unknown>;
  const last = typeof g.__shippingTickAt === "number" ? g.__shippingTickAt : 0;
  const now = Date.now();
  if (now - last < TICK_THROTTLE_MS) {
    return ok({ advanced: 0, throttled: true, results: [] });
  }
  g.__shippingTickAt = now;
  const result = await tickShipments();
  return ok({ ...result, throttled: false });
});
