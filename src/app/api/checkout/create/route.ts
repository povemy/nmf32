import { db } from "@/lib/db";
import { handle, ok, ApiError, nextOrderNumber, notify, logActivity } from "@/lib/api";
import { computePricing } from "../pricing";
import { computeOrderCommissions } from "@/lib/commission";
import { randomToken } from "@/lib/password";
import { toJson } from "@/lib/json";

export const dynamic = "force-dynamic";

const KNOWN_PROVIDERS = ["fpx_toyyibpay", "fpx_curlec", "tng", "grabpay", "card_stripe"];

// POST /api/checkout/create — header Idempotency-Key REQUIRED.
// Server recomputes ALL money math; stock + salesCount updated here (NOT in webhook).
export const POST = handle(async (req: Request) => {
  const idemKey = req.headers.get("Idempotency-Key")?.trim();
  if (!idemKey) {
    throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required");
  }

  // Idempotent replay: same key → return the original order.
  const existing = await db.order.findUnique({
    where: { idemKey },
    include: { paymentIntents: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (existing) {
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

  const customer = (body.customer ?? {}) as Record<string, unknown>;
  const customerName = String(customer.name ?? "").trim();
  const customerEmail = String(customer.email ?? "").trim().toLowerCase();
  const customerPhone = customer.phone != null ? String(customer.phone).trim() : null;
  if (!customerName) throw new ApiError(400, "VALIDATION", "customer.name is required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) throw new ApiError(400, "VALIDATION", "customer.email is invalid");

  const provider = String(body.provider ?? "fpx_toyyibpay");
  if (!KNOWN_PROVIDERS.includes(provider)) {
    throw new ApiError(400, "INVALID_PROVIDER", `provider must be one of: ${KNOWN_PROVIDERS.join(", ")}`);
  }

  const shippingAddress = body.shippingAddress ?? {};
  const shippingAddressJson = typeof shippingAddress === "string" ? toJson({ address: shippingAddress }) : toJson(shippingAddress);

  // Recompute totals EXACTLY like quote — never trust client numbers.
  const pricing = await computePricing({
    storeId: store.id,
    items: (body.items ?? []) as { variantId: string; qty: number }[],
    couponCode: body.couponCode != null ? String(body.couponCode) : null,
    shippingRateId: body.shippingRateId != null ? String(body.shippingRateId) : null,
  });

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
