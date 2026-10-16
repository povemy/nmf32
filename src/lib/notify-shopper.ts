// ============================================================================
// Shopper (buyer) in-app notifications — TASK 10-d "smart nudges" backend.
// Shopper-ONLY: sellers/admins are intentionally NOT notified here (seller
// paths keep using the legacy email/inapp `notify()` logger in lib/api.ts).
//
// Trigger wiring status (Task 13-d):
// - payment confirmed → notifyShopperOrderConfirmed() WIRED in BOTH success
//   branches of src/app/api/webhooks/payments/process.ts.
// - shipped → notifyShopperShipped() exported ready-to-call. 13-a owns
//   src/app/api/store/orders/[id]/ship/route.ts CONCURRENTLY, so the one-line
//   integration is left to the orchestrator (see worklog 13-d):
//     await notifyShopperShipped({ orderNumber: order.orderNumber, shopperId: order.shopperId, storeId: order.storeId });
// - delivered → 13-a owns the deliver/receive routes; it can call
//   createNotification(shopperId, "order.delivered", "Parcel delivered — confirm receipt", ...)
//   directly (skip when the buyer triggered the transition themselves).
// - promo (seller publish/new-product → followers) → trigger not wired yet;
//   the 1/store/day cap already lives in createNotification (type "promo").
//
// dataJson contract: JSON string shaped {orderNumber?, slug?} (+ free-form
// extras) so the bell UI can click-through to order detail / storefront.
// ============================================================================
import { db } from "./db";

export type NotificationData = { orderNumber?: string; slug?: string } & Record<string, unknown>;

/** Minimal order shape the trigger helpers accept (callers pass what they have). */
export type NotifyOrderLike = {
  orderNumber: string;
  shopperId?: string | null;
  storeId: string;
  store?: { slug?: string | null; name?: string | null } | null;
};

const PROMO_CAP_WINDOW_MS = 24 * 60 * 60 * 1000; // 1 promo per store per shopper per rolling 24h

/**
 * Core creator — best-effort by design: never throws into the caller's
 * payment/order flow, returns the created row id or null (skipped/failed).
 * type "promo" is capped at 1 per store per shopper per day (spec 10-d).
 */
export async function createNotification(
  shopperId: string | null | undefined,
  type: string,
  title: string,
  body?: string,
  data?: NotificationData
): Promise<{ id: string } | null> {
  if (!shopperId) return null; // guest orders have no account to notify
  try {
    if (type === "promo" && data?.slug) {
      const since = new Date(Date.now() - PROMO_CAP_WINDOW_MS);
      const recent = await db.notification.findMany({
        where: { shopperUserId: shopperId, type: "promo", createdAt: { gte: since } },
        select: { dataJson: true },
      });
      const capped = recent.some((n) => {
        try {
          return (JSON.parse(n.dataJson) as NotificationData).slug === data.slug;
        } catch {
          return false;
        }
      });
      if (capped) return null;
    }
    return await db.notification.create({
      data: {
        shopperUserId: shopperId,
        type,
        title,
        body: body ?? null,
        dataJson: JSON.stringify(data ?? {}),
      },
      select: { id: true },
    });
  } catch (e) {
    console.error("[notify-shopper] createNotification failed:", e);
    return null;
  }
}

/** Payment confirmed → "Order confirmed" nudge (wired in webhooks/payments/process.ts). */
export async function notifyShopperOrderConfirmed(order: NotifyOrderLike): Promise<void> {
  const meta = order.store?.slug ? { slug: order.store.slug, name: order.store.name ?? "the seller" } : await storeMetaOf(order.storeId);
  await createNotification(
    order.shopperId,
    "order.paid",
    "Order confirmed",
    `Your order ${order.orderNumber} from ${meta.name} is confirmed — the seller is preparing it for dispatch.`,
    { orderNumber: order.orderNumber, slug: meta.slug }
  );
}

/** Shipped → "Parcel on the way" nudge (integration pending in ship route — see header). */
export async function notifyShopperShipped(order: NotifyOrderLike): Promise<void> {
  const meta = order.store?.slug ? { slug: order.store.slug, name: order.store.name ?? "the seller" } : await storeMetaOf(order.storeId);
  await createNotification(
    order.shopperId,
    "order.shipped",
    "Parcel on the way",
    `Your ${meta.name} parcel ${order.orderNumber} has shipped — track it in My Orders.`,
    { orderNumber: order.orderNumber, slug: meta.slug }
  );
}

async function storeMetaOf(storeId: string): Promise<{ slug?: string; name: string }> {
  const s = await db.store.findUnique({ where: { id: storeId }, select: { slug: true, name: true } });
  return { slug: s?.slug ?? undefined, name: s?.name ?? "the seller" };
}
