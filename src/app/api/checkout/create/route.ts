import { db } from "@/lib/db";
import { handle, ok, ApiError, nextOrderNumber, notify, logActivity } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { computePricing, assertShippingAvailable } from "../pricing";
import { computeOrderCommissions } from "@/lib/commission";
import { randomToken } from "@/lib/password";
import { toJson } from "@/lib/json";
import { findCartForShopper } from "../../cart/cart";

export const dynamic = "force-dynamic";

const KNOWN_PROVIDERS = ["fpx_toyyibpay", "fpx_curlec", "tng", "grabpay", "card_stripe"];

// POST /api/checkout/create — header Idempotency-Key REQUIRED.
// Server recomputes ALL money math; stock + salesCount updated here (NOT in webhook).
export const POST = handle(async (req: Request) => {
  const idemKey = req.headers.get("Idempotency-Key")?.trim();
  if (!idemKey) {
    throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required");
  }

  // Checkout is account-only now: the order is tied to the signed-in shopper.
  const me = await requireShopper();

  // Idempotent replay: same key → return the original order.
  const existing = await db.order.findUnique({
    where: { idemKey },
    include: { paymentIntents: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (existing) {
    if (existing.shopperId !== me.id) throw new ApiError(403, "FORBIDDEN", "This checkout session belongs to a different account");
    return ok({
      orderNumber: existing.orderNumber,
      orderPaymentRef: existing.paymentIntents[0]?.providerRef ?? null,
      totalMinor: existing.totalMinor,
      status: existing.status,
      duplicate: true,
    });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const storeSlug = String(body.storeSlug ?? "");
  const store = await db.store.findUnique({ where: { slug: storeSlug } });
  if (!store || store.status !== "live") throw new ApiError(404, "STORE_NOT_FOUND", "Store not found");

  // Contact details prefill from the account; a shopper may still override
  // them per-order (e.g. sending a gift), but blanks fall back to the account.
  const customer = (body.customer ?? {}) as Record<string, unknown>;
  const customerName = String(customer.name ?? "").trim() || me.fullName;
  const customerEmail = (String(customer.email ?? "").trim() || me.email).toLowerCase();
  const customerPhone = customer.phone != null ? String(customer.phone).trim() || null : me.phone;
  if (!customerName) throw new ApiError(400, "VALIDATION", "customer.name is required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) throw new ApiError(400, "VALIDATION", "customer.email is invalid");
  if (customerPhone && !/^[+()\d\s-]{6,20}$/.test(customerPhone)) throw new ApiError(400, "VALIDATION", "customer.phone is invalid");

  const provider = String(body.provider ?? "fpx_toyyibpay");
  if (!KNOWN_PROVIDERS.includes(provider)) {
    throw new ApiError(400, "INVALID_PROVIDER", `provider must be one of: ${KNOWN_PROVIDERS.join(", ")}`);
  }

  // Shipping address — full destination is REQUIRED (drives delivery eligibility).
  const shippingAddress = (body.shippingAddress ?? {}) as Record<string, unknown>;
  const addr = {
    line1: String(shippingAddress.line1 ?? "").trim(),
    city: String(shippingAddress.city ?? "").trim(),
    state: String(shippingAddress.state ?? "").trim(),
    postcode: String(shippingAddress.postcode ?? "").trim(),
  };
  if (!addr.line1 || !addr.city || !addr.state || !addr.postcode) {
    throw new ApiError(400, "VALIDATION", "shippingAddress.line1, city, state and postcode are required");
  }
  if (!/^\d{5}$/.test(addr.postcode)) throw new ApiError(400, "VALIDATION", "shippingAddress.postcode must be a 5-digit Malaysian postcode");
  const shippingAddressJson = toJson(addr);

  // Recompute totals EXACTLY like quote — never trust client numbers.
  const pricing = await computePricing({
    storeId: store.id,
    items: (body.items ?? []) as { variantId: string; qty: number }[],
    couponCode: body.couponCode != null ? String(body.couponCode) : null,
    shippingRateId: body.shippingRateId != null ? String(body.shippingRateId) : null,
    state: addr.state,
  });

  // Destination-aware delivery rule, enforced server-side.
  assertShippingAvailable(pricing.shippingRateId, addr.state);

  const comm = await computeOrderCommissions({
    sellerId: store.sellerId,
    items: pricing.lines.map((l) => ({
      productId: l.productId,
      categoryId: l.categoryId,
      title: l.title,
      variantLabel: l.variantLabel,
      unitPriceMinor: l.unitPriceMinor,
      qty: l.qty,
    })),
    orderDiscountMinor: pricing.discountMinor,
    shippingMinorTotal: pricing.shippingMinor,
  });

  const orderNumber = await nextOrderNumber();
  const providerRef = `ref_${randomToken(8)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);

  // The order records the shopper's cart token so the webhook can clear the
  // purchased items from the account cart once payment is verified.
  const shopperCart = await findCartForShopper(me.id);

  const { order, intent } = await db.$transaction(async (tx) => {
    // Re-validate stock inside the transaction (guards concurrent checkouts).
    for (const line of pricing.lines) {
      const v = await tx.productVariant.findUnique({ where: { id: line.variantId } });
      if (!v || !v.isActive || v.stock < line.qty) {
        throw new ApiError(409, "OUT_OF_STOCK", `Insufficient stock for "${line.title}"${line.variantLabel ? ` (${line.variantLabel})` : ""}`);
      }
    }

    const order = await tx.order.create({
      data: {
        storeId: store.id,
        orderNumber,
        customerName,
        customerEmail,
        customerPhone,
        shopperId: me.id,
        status: "payment_pending",
        channel: "storefront",
        currency: store.currency,
        subtotalMinor: pricing.subtotalMinor,
        discountMinor: pricing.discountMinor,
        shippingMinor: pricing.shippingMinor,
        totalMinor: pricing.totalMinor,
        couponCode: pricing.coupon.valid ? pricing.coupon.code : null,
        shippingAddressJson,
        customerNote: body.customerNote != null ? String(body.customerNote) : null,
        paymentProvider: provider,
        cartToken: shopperCart?.token ?? null,
        idemKey,
      },
    });

    await tx.orderItem.createMany({
      data: pricing.lines.map((l, i) => {
        const c = comm.items[i];
        return {
          orderId: order.id,
          productId: l.productId,
          variantId: l.variantId,
          title: l.title,
          variantLabel: l.variantLabel,
          unitPriceMinor: l.unitPriceMinor,
          qty: l.qty,
          lineSubtotalMinor: l.lineTotalMinor,
          discountMinor: c.discountMinor,
          shippingMinor: c.shippingMinor,
          commissionPercent: c.percent,
          commissionMinor: c.commissionMinor,
          fixedFeeMinor: c.fixedFeeMinor,
          sellerNetMinor: c.sellerNetMinor,
          breakdownJson: toJson(c.breakdown),
        };
      }),
    });

    // Stock + sales move AT CHECKOUT (per contract) — never repeated in webhook.
    for (const line of pricing.lines) {
      await tx.productVariant.update({ where: { id: line.variantId }, data: { stock: { decrement: line.qty } } });
      await tx.inventoryLog.create({
        data: { variantId: line.variantId, delta: -line.qty, reason: `order:${orderNumber}`, refId: order.id },
      });
      if (line.productId) {
        await tx.product.update({ where: { id: line.productId }, data: { salesCount: { increment: line.qty } } });
      }
    }

    const intent = await tx.paymentIntent.create({
      data: {
        orderId: order.id,
        provider,
        providerRef,
        amountMinor: pricing.totalMinor,
        status: "requires_payment",
        redirectUrl: `/pay/${providerRef}`,
        expiresAt,
      },
    });

    await tx.orderStatusHistory.create({
      data: { orderId: order.id, fromStatus: null, toStatus: "payment_pending", actor: "shopper", note: `Checkout via ${provider}` },
    });

    if (pricing.coupon.valid && pricing.coupon.couponId) {
      await tx.couponRedemption.create({
        data: {
          couponId: pricing.coupon.couponId,
          orderId: order.id,
          customerEmail,
          discountMinor: pricing.discountMinor,
        },
      });
      await tx.coupon.update({ where: { id: pricing.coupon.couponId }, data: { timesUsed: { increment: 1 } } });
    }

    return { order, intent };
  });

  await notify({
    event: "order.created",
    channel: "email",
    recipient: "admin@shopmesh.io",
    subject: `New order ${order.orderNumber} — ${store.name}`,
  });
  await logActivity({
    actorType: "shopper",
    action: "order.created",
    entityType: "order",
    entityId: order.id,
    meta: { orderNumber: order.orderNumber, storeSlug: store.slug, totalMinor: order.totalMinor },
  });

  return ok(
    {
      orderNumber: order.orderNumber,
      orderPaymentRef: intent.providerRef,
      totalMinor: order.totalMinor,
      redirectUrl: intent.redirectUrl,
      status: order.status,
    },
    { status: 201 }
  );
});
