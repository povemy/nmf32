import { db } from "@/lib/db";
import { handle, ok, ApiError, nextOrderNumber, notify, logActivity } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { computeGroupPricing, assertShippingAvailable } from "../pricing";
import { computeOrderCommissions } from "@/lib/commission";
import { randomToken } from "@/lib/password";
import { toJson } from "@/lib/json";
import { findCartForShopper } from "../../cart/cart";

export const dynamic = "force-dynamic";

const KNOWN_PROVIDERS = ["fpx_toyyibpay", "fpx_curlec", "tng", "grabpay", "card_stripe"];

// POST /api/checkout/create — header Idempotency-Key REQUIRED.
// OPTION A (platform collect-then-disburse): the buyer pays ONCE even when the
// cart spans N sellers. Server recomputes ALL money math, groups cart lines per
// seller, and creates ONE PaymentGroup + N per-seller Orders in a single
// transaction. Stock + salesCount move here (NOT in the webhook). Each order
// carries its own commission lines → ledger → seller wallet payout hold, so the
// disbursement half of Option A reuses the existing payout pipeline.
export const POST = handle(async (req: Request) => {
  const idemKey = req.headers.get("Idempotency-Key")?.trim();
  if (!idemKey) {
    throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required");
  }

  // Checkout is account-only: orders are tied to the signed-in shopper.
  const me = await requireShopper();

  // Idempotent replay #1 — a previous multi-seller checkout with this key.
  const existingGroup = await db.paymentGroup.findUnique({
    where: { idemKey },
    include: { orders: { orderBy: { createdAt: "asc" } } },
  });
  if (existingGroup) {
    if (existingGroup.shopperId !== me.id) throw new ApiError(403, "FORBIDDEN", "This checkout session belongs to a different account");
    return ok({
      orderNumber: existingGroup.orders[0]?.orderNumber ?? "",
      orderNumbers: existingGroup.orders.map((o) => o.orderNumber),
      orderPaymentRef: existingGroup.ref,
      paymentRef: existingGroup.ref,
      totalMinor: existingGroup.totalMinor,
      status: existingGroup.orders[0]?.status ?? "payment_pending",
      duplicate: true,
    });
  }

  // Idempotent replay #2 — legacy single-order checkout with this key.
  const existing = await db.order.findUnique({
    where: { idemKey },
    include: { paymentIntents: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (existing) {
    if (existing.shopperId !== me.id) throw new ApiError(403, "FORBIDDEN", "This checkout session belongs to a different account");
    return ok({
      orderNumber: existing.orderNumber,
      orderNumbers: [existing.orderNumber],
      orderPaymentRef: existing.paymentIntents[0]?.providerRef ?? null,
      paymentRef: existing.paymentIntents[0]?.providerRef ?? null,
      totalMinor: existing.totalMinor,
      status: existing.status,
      duplicate: true,
    });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

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
  const pricing = await computeGroupPricing({
    items: (body.items ?? []) as { variantId: string; qty: number }[],
    couponCode: body.couponCode != null ? String(body.couponCode) : null,
    shippingRateId: body.shippingRateId != null ? String(body.shippingRateId) : null,
    state: addr.state,
  });

  // Destination-aware delivery rule, enforced server-side (applies to every parcel).
  assertShippingAvailable(pricing.shippingRateId, addr.state);

  // Commission preview per seller group (percent + fixed fee parts per line).
  // A live store always has an owner — the ?? "" is a defensive fallback that
  // resolves to default commission settings instead of throwing.
  const groupCommissions = await Promise.all(
    pricing.groups.map((g) =>
      computeOrderCommissions({
        sellerId: g.sellerId ?? "",
        items: g.lines.map((l) => ({
          productId: l.productId,
          categoryId: l.categoryId,
          title: l.title,
          variantLabel: l.variantLabel,
          unitPriceMinor: l.unitPriceMinor,
          qty: l.qty,
        })),
        orderDiscountMinor: g.discountMinor,
        shippingMinorTotal: g.shippingMinor,
      })
    )
  );

  const providerRef = `ref_${randomToken(8)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);

  // The orders record the shopper's cart token so the webhook can clear the
  // purchased items from the account cart once payment is verified.
  const shopperCart = await findCartForShopper(me.id);
  const cartToken = shopperCart?.token ?? null;

  const orderNumbers = await Promise.all(pricing.groups.map(() => nextOrderNumber()));

  const group = await db.$transaction(async (tx) => {
    // Re-validate stock inside the transaction (guards concurrent checkouts).
    for (const line of pricing.items) {
      const v = await tx.productVariant.findUnique({ where: { id: line.variantId } });
      if (!v || !v.isActive || v.stock < line.qty) {
        throw new ApiError(409, "OUT_OF_STOCK", `Insufficient stock for "${line.title}"${line.variantLabel ? ` (${line.variantLabel})` : ""}`);
      }
    }

    const paymentGroup = await tx.paymentGroup.create({
      data: {
        ref: providerRef,
        shopperId: me.id,
        provider,
        status: "requires_payment",
        currency: "MYR",
        subtotalMinor: pricing.subtotalMinor,
        discountMinor: pricing.discountMinor,
        shippingMinor: pricing.shippingMinor,
        totalMinor: pricing.totalMinor,
        idemKey,
        redirectUrl: `/pay/${providerRef}`,
        expiresAt,
      },
    });

    for (let gi = 0; gi < pricing.groups.length; gi++) {
      const g = pricing.groups[gi];
      const comm = groupCommissions[gi];
      const orderNumber = orderNumbers[gi];

      const order = await tx.order.create({
        data: {
          storeId: g.storeId,
          orderNumber,
          customerName,
          customerEmail,
          customerPhone,
          shopperId: me.id,
          status: "payment_pending",
          channel: "storefront",
          currency: g.currency,
          subtotalMinor: g.subtotalMinor,
          discountMinor: g.discountMinor,
          shippingMinor: g.shippingMinor,
          totalMinor: g.totalMinor,
          couponCode: g.coupon.valid ? g.coupon.code : null,
          shippingAddressJson,
          customerNote: body.customerNote != null ? String(body.customerNote) : null,
          paymentProvider: provider,
          cartToken,
          idemKey: `${idemKey}:${g.storeId}`,
          paymentGroupId: paymentGroup.id,
        },
      });

      await tx.orderItem.createMany({
        data: g.lines.map((l, i) => {
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
      for (const line of g.lines) {
        await tx.productVariant.update({ where: { id: line.variantId }, data: { stock: { decrement: line.qty } } });
        await tx.inventoryLog.create({
          data: { variantId: line.variantId, delta: -line.qty, reason: `order:${orderNumber}`, refId: order.id },
        });
        if (line.productId) {
          await tx.product.update({ where: { id: line.productId }, data: { salesCount: { increment: line.qty } } });
        }
      }

      await tx.orderStatusHistory.create({
        data: { orderId: order.id, fromStatus: null, toStatus: "payment_pending", actor: "shopper", note: `Checkout via ${provider} (payment group ${providerRef})` },
      });

      if (g.coupon.valid && g.coupon.couponId) {
        await tx.couponRedemption.create({
          data: {
            couponId: g.coupon.couponId,
            orderId: order.id,
            customerEmail,
            discountMinor: g.discountMinor,
          },
        });
        await tx.coupon.update({ where: { id: g.coupon.couponId }, data: { timesUsed: { increment: 1 } } });
      }
    }

    return paymentGroup;
  });

  // Notifications + audit (one per seller order, plus admin roll-up).
  const orders = await db.order.findMany({ where: { paymentGroupId: group.id }, include: { store: true } });
  for (const o of orders) {
    await notify({
      event: "order.created",
      channel: "email",
      recipient: "admin@shopmesh.io",
      subject: `New order ${o.orderNumber} — ${o.store.name}`,
    });
    await logActivity({
      actorType: "shopper",
      action: "order.created",
      entityType: "order",
      entityId: o.id,
      meta: { orderNumber: o.orderNumber, storeSlug: o.store.slug, totalMinor: o.totalMinor, paymentGroupRef: group.ref },
    });
  }

  return ok(
    {
      orderNumber: orders[0]?.orderNumber ?? "",
      orderNumbers: orders.map((o) => o.orderNumber),
      orderPaymentRef: group.ref,
      paymentRef: group.ref,
      totalMinor: group.totalMinor,
      redirectUrl: group.redirectUrl,
      status: orders[0]?.status ?? "payment_pending",
    },
    { status: 201 }
  );
});
