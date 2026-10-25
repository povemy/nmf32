import { db } from "@/lib/db";
import { handle, ok, ApiError, nextOrderNumber, notify, logActivity } from "@/lib/api";
import { requireShopper } from "@/lib/auth";
import { computeGroupPricing, assertShippingAvailable } from "../pricing";
import { computeOrderCommissions } from "@/lib/commission";
import { randomToken } from "@/lib/password";
import { toJson } from "@/lib/json";
import { findCartForShopper } from "../../cart/cart";
import { buildVoucherOutcomes, applyVoucherOutcomesToGroups, type VoucherEntryInput } from "@/lib/vouchers";
import { withCheckoutAdmission } from "@/lib/checkout-gate";

export const dynamic = "force-dynamic";

const KNOWN_PROVIDERS = ["fpx_toyyibpay", "fpx_curlec", "tng", "grabpay", "card_stripe"];

// POST /api/checkout/create — header Idempotency-Key REQUIRED.
// OPTION B (one licensed-PSP charge per checkout; no platform custody): the
// buyer pays ONCE even when the cart spans N sellers. Server recomputes ALL
// money math, groups cart lines per seller, and creates ONE PaymentGroup + N
// per-seller Orders in a single transaction. Stock + salesCount move here (NOT
// in the webhook). Each order carries its own commission lines → ledger →
// seller wallet payout hold.
// Task 10-b claimable vouchers: body.vouchers = [{storeId, userVoucherId}] per
// payment group. Verdicts run per seller group (lib/vouchers); a valid discount
// voucher adds to the group discount (capped at the subtotal), freeshipping
// zeroes that group's parcel cost. Redemption — UserVoucher→USED (usedAt,
// usedOrderId) + Voucher.claimedCount+1 + Order.voucherId + discount applied —
// happens INSIDE the same transaction as the orders (atomic). Idempotent per
// order: the Idempotency-Key replay path above returns before any redemption,
// and the status-guarded updateMany prevents concurrent double-redemption.
// Redemption follows the existing coupon semantics: recorded at order CREATE,
// not at payment.
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

  // F2 REMEDIATION — bounded admission control. Everything below (pricing
  // reads + the create transaction) runs under a process-level semaphore:
  // excess arrivals WAIT (bounded FIFO, queue time measured separately) and,
  // when the wait budget is exhausted, receive a CLEAN retryable
  // `503 CHECKOUT_BUSY` + `Retry-After` instead of a raw 500. The gate sits
  // AFTER the idempotency replays (key replays never consume admission
  // slots) and BEFORE any write (a busy rejection leaves the cart untouched).
  // The buyer retries with the SAME Idempotency-Key, so a post-busy retry
  // converges on this checkout instead of duplicating it.
  const runCheckout = async () => {

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

  // Claimable vouchers per seller group — hard mode: any unusable selection
  // fails the checkout with 409 so the buyer can re-quote (never silently
  // drop a voucher). One voucher per seller group (first entry wins).
  const voucherEntriesRaw = Array.isArray(body.vouchers)
    ? (body.vouchers as VoucherEntryInput[]).filter((e) => e && typeof e === "object")
    : [];
  const seenStores = new Set<string>();
  const voucherEntries = voucherEntriesRaw.filter((e) => {
    const k = String(e?.storeId ?? "");
    if (!k || seenStores.has(k)) return false;
    seenStores.add(k);
    return true;
  });
  const voucherOutcomes =
    voucherEntries.length > 0
      ? await buildVoucherOutcomes({
          entries: voucherEntries,
          shopperId: me.id,
          groups: pricing.groups.map((g) => ({ storeId: g.storeId, subtotalMinor: g.subtotalMinor })),
          addressState: addr.state,
          hard: true,
        })
      : [];
  const outcomeByStore = new Map(voucherOutcomes.map((o) => [o.storeId, o]));
  const { groups: adjustedGroups, totals: adjustedTotals } = applyVoucherOutcomesToGroups(pricing.groups, voucherOutcomes);

  // Commission preview per seller group (percent + fixed fee parts per line).
  // Computed on the VOUCHER-ADJUSTED totals so the discount reaches the ledger.
  // A live store always has an owner — the ?? "" is a defensive fallback that
  // resolves to default commission settings instead of throwing.
  const groupCommissions = await Promise.all(
    adjustedGroups.map((g) =>
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
    // Friendly fast-fail re-validation inside the transaction (stock snapshot;
    // the AUTHORITATIVE race-proof guard is the conditional decrement below).
    for (const line of pricing.items) {
      const v = await tx.productVariant.findUnique({ where: { id: line.variantId } });
      if (!v || !v.isActive || v.stock < line.qty) {
        throw new ApiError(409, "OUT_OF_STOCK", `Insufficient stock for "${line.title}"${line.variantLabel ? ` (${line.variantLabel})` : ""}`);
      }
      if (line.qty < Math.max(1, v.moq)) {
        throw new ApiError(409, "MOQ_NOT_MET", `Seller minimum for "${line.title}" is ${Math.max(1, v.moq)}`);
      }
    }

    // Voucher rows for the redeemed selection (userVoucherId → voucherId/quota).
    const redeemedIds = voucherOutcomes.map((o) => o.userVoucherId);
    const uvRows =
      redeemedIds.length > 0
        ? await tx.userVoucher.findMany({
            where: { id: { in: redeemedIds }, userId: me.id },
            select: { id: true, voucherId: true, voucher: { select: { id: true, quota: true } } },
          })
        : [];
    const uvById = new Map(uvRows.map((r) => [r.id, r]));

    const paymentGroup = await tx.paymentGroup.create({
      data: {
        ref: providerRef,
        shopperId: me.id,
        provider,
        status: "requires_payment",
        currency: "MYR",
        subtotalMinor: adjustedTotals.subtotalMinor,
        discountMinor: adjustedTotals.discountMinor,
        shippingMinor: adjustedTotals.shippingMinor,
        totalMinor: adjustedTotals.totalMinor,
        idemKey,
        redirectUrl: `/pay/${providerRef}`,
        expiresAt,
      },
    });

    for (let gi = 0; gi < adjustedGroups.length; gi++) {
      const g = adjustedGroups[gi];
      const comm = groupCommissions[gi];
      const orderNumber = orderNumbers[gi];
      const voucherOutcome = outcomeByStore.get(g.storeId);
      const uvRow = voucherOutcome ? uvById.get(voucherOutcome.userVoucherId) : undefined;

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
          voucherId: uvRow?.voucher.id ?? null,
          shippingAddressJson,
          customerNote: body.customerNote != null ? String(body.customerNote) : null,
          paymentProvider: provider,
          cartToken,
          idemKey: `${idemKey}:${g.storeId}`,
          paymentGroupId: paymentGroup.id,
        },
      });

      // Atomic voucher redemption — status-guarded so a concurrent checkout
      // with the same voucher can never double-redeem; quota-guarded so the
      // redeemable pool cannot be exceeded.
      if (voucherOutcome && uvRow) {
        const redeemed = await tx.userVoucher.updateMany({
          where: { id: voucherOutcome.userVoucherId, userId: me.id, status: "AVAILABLE" },
          data: { status: "USED", usedAt: now, usedOrderId: order.id },
        });
        if (redeemed.count === 0) {
          throw new ApiError(409, "VOUCHER_ALREADY_USED", "One of your selected vouchers has just been used — please review your voucher selection");
        }
        const quotaGuard = await tx.voucher.updateMany({
          where: {
            id: uvRow.voucher.id,
            OR: [{ quota: null }, { claimedCount: { lt: uvRow.voucher.quota ?? Number.MAX_SAFE_INTEGER } }],
          },
          data: { claimedCount: { increment: 1 } },
        });
        if (quotaGuard.count === 0) {
          throw new ApiError(409, "QUOTA_EXHAUSTED", "One of your selected vouchers has just run out — please review your voucher selection");
        }
      }

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
      // LAUNCH-RUSH OVERSELL GUARD: the decrement is CONDITIONAL (UPDATE …
      // WHERE stock >= qty). Under concurrent checkouts — think an influencer
      // drop where hundreds of buyers hit Pay at once — the read above cannot
      // be trusted (two transactions both see 1 left); Postgres evaluates the
      // row-locked condition atomically, so EXACTLY ONE of the racing
      // transactions matches. The loser gets count=0 → 409 → the WHOLE
      // transaction (orders, items, vouchers, ledger) rolls back and the buyer
      // is asked to adjust, while the winner takes the goods. Stock can never
      // go negative, no reservation tables, no extra services — one UPDATE per
      // line, the cheapest possible correctness at any concurrency.
      for (const line of g.lines) {
        const moved = await tx.productVariant.updateMany({
          where: { id: line.variantId, isActive: true, stock: { gte: line.qty } },
          data: { stock: { decrement: line.qty } },
        });
        if (moved.count === 0) {
          throw new ApiError(409, "OUT_OF_STOCK", `Insufficient stock for "${line.title}"${line.variantLabel ? ` (${line.variantLabel})` : ""}`);
        }
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
  }, { timeout: 15_000 }); // bounded >5s default: measured P2028 under rush (dev.log)

  // Notifications + audit (one per seller order, plus admin roll-up).
  const orders = await db.order.findMany({ where: { paymentGroupId: group.id }, include: { store: true } });
  for (const o of orders) {
    const vo = outcomeByStore.get(o.storeId);
    await notify({
      event: "order.created",
      channel: "email",
      recipient: "admin@nomofee.io",
      subject: `New order ${o.orderNumber} — ${o.store.name}`,
    });
    await logActivity({
      actorType: "shopper",
      action: "order.created",
      entityType: "order",
      entityId: o.id,
      meta: {
        orderNumber: o.orderNumber,
        storeSlug: o.store.slug,
        totalMinor: o.totalMinor,
        paymentGroupRef: group.ref,
        voucher: vo
          ? { code: vo.code, kind: vo.kind, discountMinor: vo.discountMinor, freeShipping: vo.freeShipping, fsPriceAdjustMinor: vo.fsPriceAdjustMinor }
          : undefined,
      },
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
      vouchersApplied: voucherOutcomes.map((o) => ({
        storeId: o.storeId,
        code: o.code,
        title: o.title,
        kind: o.kind,
        discountMinor: o.discountMinor,
        freeShipping: o.freeShipping,
        fsPriceAdjustMinor: o.fsPriceAdjustMinor,
      })),
    },
    { status: 201 }
  );
  }; // end runCheckout (under admission control)

  const { result, queueMs } = await withCheckoutAdmission(runCheckout);
  // Queue-time telemetry, separate from processing time (F2/C4).
  try {
    result.headers.set("X-Checkout-Queue-Ms", String(queueMs));
  } catch {
    /* header surface only */
  }
  return result;
});
