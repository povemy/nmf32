import { db } from "@/lib/db";
import { handle, ok, ApiError, nextOrderNumber, notify, logActivity } from "@/lib/api";
import { bustPublicProductCache } from "@/lib/public-cache";
import { requireShopper } from "@/lib/auth";
import { computeGroupPricing, assertShippingAvailable } from "../pricing";
import { computeOrderCommissions, loadRateContext } from "@/lib/commission";
import { randomToken } from "@/lib/password";
import { toJson } from "@/lib/json";
import { buildVoucherOutcomes, applyVoucherOutcomesToGroups, type VoucherEntryInput } from "@/lib/vouchers";
import { withCheckoutAdmission, checkoutGateStats } from "@/lib/checkout-gate";
import { startCheckoutTiming, type CheckoutTimingRecord } from "@/lib/checkout-timing";
import { KNOWN_PAYMENT_METHODS } from "@/lib/payment-methods";
import { resolveAttribution } from "@/lib/analytics/attribution";
import { resolveAffiliateAttributionForCart } from "@/lib/affiliate-attribution";
import { getAffiliateSettings } from "@/lib/affiliate";

export const dynamic = "force-dynamic";

// F-14: single source of truth — the buyer-facing method list lives in
// lib/payment-methods.ts and is shared with the shopper checkout UI, so the
// server-accepted set and the buyer-selectable set can never drift again.

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
//
// PHASE 2 / A2 — checkout round-trip diet (NO change to transaction
// correctness; every financial/inventory guard is untouched):
//   • idempotency replays run in ONE parallel batch (were 2 sequential reads)
//   • commission context is loaded ONCE for ALL seller groups via the batched
//     loadRateContext (was (5+2·D) sequential queries per LINE per group)
//   • affiliate settings are fetched once and shared with the attribution
//     resolver (was a duplicate setting.findMany)
//   • the cart is read token-only (was a full deep include of every cart line)
//   • in-tx fast-fail re-validation is ONE findMany (was per-line findUnique)
//   • inventory logs are one createMany per seller group (was per-line create)
//   • salesCount increments are aggregated per distinct product
//   • the post-commit orders re-read is GONE — the summary is returned from
//     inside the transaction (strictly more consistent), and notify/logActivity
//     fan out in parallel
// The AUTHORITATIVE oversell guard stays EXACTLY where it was: the conditional
// `updateMany … WHERE stock >= qty` decrement, per line, inside the tx.
export const POST = handle(async (req: Request) => {
  const idemKey = req.headers.get("Idempotency-Key")?.trim();
  if (!idemKey) {
    throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required");
  }

  // PHASE 2 / A2: latency-anatomy instrumentation (src/lib/checkout-timing.ts)
  // — one stdout JSON line per checkout when CHECKOUT_TIMING=1, zero overhead
  // otherwise. Emitted on success AND error paths (status 0 = error path). The
  // success emit is DEFERRED until the admission gate returns so the measured
  // queue wait (gateWaitMs) is included.
  const timing = startCheckoutTiming(idemKey);
  // Holder object dodges TS's closure-assignment narrowing (pendingEmit is set
  // inside runCheckout, consumed after withCheckoutAdmission).
  const emitHolder: { pending: { status: number; extra: Partial<CheckoutTimingRecord> } | null } = { pending: null };
  // checkoutGateStats() → the timing record's field names (gateActive/gateQueued).
  const gateStats = (): Pick<CheckoutTimingRecord, "gateActive" | "gateQueued"> => {
    const s = checkoutGateStats();
    return { gateActive: s.inflight, gateQueued: s.waiting };
  };

  try {
    // Checkout is account-only: orders are tied to the signed-in shopper.
    const me = await requireShopper();
    timing.mark("auth");

    // Idempotent replays — both unique-key lookups, fetched in ONE parallel
    // batch (replays never consume admission slots, unchanged).
    const [existingGroup, existing] = await Promise.all([
      db.paymentGroup.findUnique({
        where: { idemKey },
        include: { orders: { orderBy: { createdAt: "asc" } } },
      }),
      db.order.findUnique({
        where: { idemKey },
        include: { paymentIntents: { orderBy: { createdAt: "desc" }, take: 1 } },
      }),
    ]);
    timing.mark("idem");

    if (existingGroup) {
      if (existingGroup.shopperId !== me.id) throw new ApiError(403, "FORBIDDEN", "This checkout session belongs to a different account");
      timing.emit(200, { gateWaitMs: 0, ...gateStats() });
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
    if (existing) {
      if (existing.shopperId !== me.id) throw new ApiError(403, "FORBIDDEN", "This checkout session belongs to a different account");
      timing.emit(200, { gateWaitMs: 0, ...gateStats() });
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
      if (!KNOWN_PAYMENT_METHODS.includes(provider)) {
        throw new ApiError(400, "INVALID_PROVIDER", `provider must be one of: ${KNOWN_PAYMENT_METHODS.join(", ")}`);
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
      timing.mark("body");

      // One clock for the whole checkout: commission context, order timestamps,
      // voucher redemption stamps and the expiry window all read the SAME
      // `now` (previously each helper minted its own — ms-level drift between
      // groups; a single snapshot is strictly more deterministic).
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);

      // Recompute totals EXACTLY like quote — never trust client numbers.
      const pricing = await computeGroupPricing({
        items: (body.items ?? []) as { variantId: string; qty: number }[],
        couponCode: body.couponCode != null ? String(body.couponCode) : null,
        shippingRateId: body.shippingRateId != null ? String(body.shippingRateId) : null,
        state: addr.state,
      });

      // Destination-aware delivery rule, enforced server-side (applies to every parcel).
      assertShippingAvailable(pricing.shippingRateId, addr.state);
      timing.mark("pricing");

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
      timing.mark("voucher");

      // AFFILIATE (Hub): money-grade per-item attribution is resolved server-side
      // FIRST (last eligible click per product from the visitor-cookie touch
      // table, 30-day window, self-purchases excluded, enrollment re-checked),
      // then fed into the commission computation so the seller-funded affiliate
      // pool is carved from seller proceeds in the SAME snapshot math. The client
      // never supplies affiliate ids.
      //
      // POST-IMPLEMENTATION AUDIT (P3): freeze the sponsor-override policy TOGETHER
      // with the attribution snapshot so the compensation arrangement of THIS order
      // is fully determined at checkout. Later affiliate.sponsor_enabled changes
      // affect new orders only — the payment webhook posts from this frozen value
      // (OrderItem.affiliateSponsorEnabled), never from the live setting.
      //
      // PHASE 2 / A2: settings are fetched ONCE here and passed into the
      // attribution resolver (previously resolveAffiliateAttributionForCart
      // re-read them internally — a duplicate setting.findMany per checkout).
      const affiliateSettings = await getAffiliateSettings();
      const affiliateMap = await resolveAffiliateAttributionForCart({
        shopperId: me.id,
        lines: pricing.groups.flatMap((g) => g.lines.map((l) => ({ variantId: l.variantId, productId: l.productId, storeId: g.storeId }))),
        preloadedSettings: affiliateSettings,
      }).catch(() => new Map<string, { affiliateId: string; sponsorId: string | null; linkId: string; rateBps: number; poolBaseMinor: number }>());

      // Commission preview per seller group (percent + fixed fee parts per line).
      // Computed on the VOUCHER-ADJUSTED totals so the discount reaches the ledger.
      // A live store always has an owner — the ?? "" is a defensive fallback that
      // resolves to default commission settings instead of throwing.
      //
      // PHASE 2 / A2: ONE batched rate context for EVERY seller group (fixed ~6
      // round-trips, item-count independent) shared across the per-group
      // computeOrderCommissions calls — previously each group resolved rates
      // line-by-line with (5+2·D) sequential queries per line. Parity with the
      // sequential resolver is byte-proven by scripts/test-commission-parity.ts.
      const commissionCtx = await loadRateContext({
        sellerIds: adjustedGroups.map((g) => g.sellerId ?? "").filter(Boolean),
        productIds: adjustedGroups.flatMap((g) => g.lines.map((l) => l.productId ?? "")).filter(Boolean),
        categoryIds: adjustedGroups.flatMap((g) => g.lines.map((l) => l.categoryId ?? "")).filter(Boolean),
        now,
      });
      const groupCommissions = await Promise.all(
        adjustedGroups.map((g) =>
          computeOrderCommissions(
            {
              sellerId: g.sellerId ?? "",
              items: g.lines.map((l) => ({
                productId: l.productId,
                categoryId: l.categoryId,
                title: l.title,
                variantLabel: l.variantLabel,
                unitPriceMinor: l.unitPriceMinor,
                qty: l.qty,
                affiliate: affiliateMap.get(l.variantId) ?? null,
              })),
              orderDiscountMinor: g.discountMinor,
              shippingMinorTotal: g.shippingMinor,
              now,
            },
            commissionCtx
          )
        )
      );
      timing.mark("commission");

      const providerRef = `ref_${randomToken(8)}`;

      // The orders record the shopper's cart token so the webhook can clear the
      // purchased items from the account cart once payment is verified.
      // PHASE 2 / A2: token-only read (the previous deep include dragged every
      // cart line's variant→product→store graph over the wire for one string).
      const shopperCart = await db.cart.findUnique({ where: { shopperId: me.id }, select: { token: true } });
      const cartToken = shopperCart?.token ?? null;
      timing.mark("cart");

      // Marketing Intelligence — resolve the shopper's validated attribution
      // (last-touch cookie) BEFORE the transaction so it can be frozen onto every
      // order as constant snapshot columns (same pattern as the country snapshot).
      // Best-effort by design: an unreadable/absent cookie simply means untagged.
      const attribution = await resolveAttribution().catch(() => null);

      const orderNumbers = await Promise.all(pricing.groups.map(() => nextOrderNumber()));
      timing.mark("counter");

      // --- Transaction anatomy marks (see src/lib/checkout-timing.ts) ---------
      let txAcquireMs = 0;
      let txStatements = 0;
      const txCallAt = performance.now();

      // Per-order summary collected INSIDE the transaction (replaces the
      // post-commit orders re-read — the data is exactly what this request
      // wrote, with no re-read window).
      const orderSummaries: { id: string; orderNumber: string; storeId: string; storeSlug: string; storeName: string; totalMinor: number }[] = [];

      const group = await db.$transaction(async (tx) => {
        txAcquireMs = performance.now() - txCallAt; // callback entry = connection acquired (the P2028 window)

        // Friendly fast-fail re-validation inside the transaction (stock snapshot;
        // the AUTHORITATIVE race-proof guard is the conditional decrement below).
        // PHASE 2 / A2: one findMany for every line (was per-line findUnique).
        const variantIds = pricing.items.map((l) => l.variantId);
        const variantRows = await tx.productVariant.findMany({
          where: { id: { in: variantIds } },
          select: { id: true, isActive: true, stock: true, moq: true },
        });
        txStatements++;
        const variantById = new Map(variantRows.map((v) => [v.id, v]));
        for (const line of pricing.items) {
          const v = variantById.get(line.variantId);
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
        if (uvRows.length > 0) txStatements++;
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
        txStatements++;

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
              // Seller Insights — destination-country snapshot. This route itself
              // enforces the Malaysian 5-digit postcode + MY state rules above, so
              // "MY" is recorded from the VERIFIED input at order time (frozen like
              // shippingAddressJson; never derived from the customer's later profile).
              shippingCountryCode: "MY",
              shippingCountrySource: "checkout",
              // Marketing Intelligence — attribution snapshot frozen at checkout
              // creation from the shopper's validated attribution cookie
              // (last-touch; null = untagged). Constant columns exactly like the
              // country snapshot above — never recomputed, never backfilled.
              attrCampaignId: attribution?.campaignId ?? null,
              attrSource: attribution?.utmSource ?? null,
              attrMedium: attribution?.utmMedium ?? null,
              attrCampaign: attribution?.utmCampaign ?? null,
              attrTerm: attribution?.utmTerm ?? null,
              attrContent: attribution?.utmContent ?? null,
              customerNote: body.customerNote != null ? String(body.customerNote) : null,
              paymentProvider: provider,
              cartToken,
              idemKey: `${idemKey}:${g.storeId}`,
              paymentGroupId: paymentGroup.id,
            },
          });
          txStatements++;
          orderSummaries.push({ id: order.id, orderNumber, storeId: g.storeId, storeSlug: g.storeSlug, storeName: g.storeName, totalMinor: g.totalMinor });

          // Atomic voucher redemption — status-guarded so a concurrent checkout
          // with the same voucher can never double-redeem; quota-guarded so the
          // redeemable pool cannot be exceeded.
          if (voucherOutcome && uvRow) {
            const redeemed = await tx.userVoucher.updateMany({
              where: { id: voucherOutcome.userVoucherId, userId: me.id, status: "AVAILABLE" },
              data: { status: "USED", usedAt: now, usedOrderId: order.id },
            });
            txStatements++;
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
            txStatements++;
            if (quotaGuard.count === 0) {
              throw new ApiError(409, "QUOTA_EXHAUSTED", "One of your selected vouchers has just run out — please review your voucher selection");
            }
          }

          await tx.orderItem.createMany({
            data: g.lines.map((l, i) => {
              const c = comm.items[i];
              const aff = affiliateMap.get(l.variantId) ?? null;
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
                // AFFILIATE snapshot — frozen here, never recomputed (identical
                // contract to the commission columns above). Zero/nullable when
                // the line has no valid affiliate attribution. Includes the
                // sponsor-override POLICY freeze (P3) so posting is deterministic.
                affiliateDirectId: aff?.affiliateId ?? null,
                affiliateSponsorId: aff?.sponsorId ?? null,
                affiliateLinkId: aff?.linkId ?? null,
                affiliateRateBps: aff?.rateBps ?? null,
                affiliatePoolMinor: c.affiliatePoolMinor,
                affiliateSponsorEnabled: aff ? affiliateSettings.sponsorEnabled : null,
              };
            }),
          });
          txStatements++;

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
          // (PHASE 2 / A2: still one conditional UPDATE PER LINE — this is the
          // correctness core and is deliberately NOT batched. The inventory LOGS
          // and the salesCount increments below are the parts that safely batch.)
          for (const line of g.lines) {
            const moved = await tx.productVariant.updateMany({
              where: { id: line.variantId, isActive: true, stock: { gte: line.qty } },
              data: { stock: { decrement: line.qty } },
            });
            txStatements++;
            if (moved.count === 0) {
              throw new ApiError(409, "OUT_OF_STOCK", `Insufficient stock for "${line.title}"${line.variantLabel ? ` (${line.variantLabel})` : ""}`);
            }
          }

          // Inventory audit trail — one createMany per seller group (was one
          // create per line). Same rows, same reason/refId shape.
          await tx.inventoryLog.createMany({
            data: g.lines.map((line) => ({
              variantId: line.variantId,
              delta: -line.qty,
              reason: `order:${orderNumber}`,
              refId: order.id,
            })),
          });
          txStatements++;

          // Sales counters — aggregated per DISTINCT product (two variants of
          // one product now cost one UPDATE instead of two; the final value is
          // identical because increment(a)+increment(b) === increment(a+b)).
          const qtyByProduct = new Map<string, number>();
          for (const line of g.lines) {
            if (line.productId) qtyByProduct.set(line.productId, (qtyByProduct.get(line.productId) ?? 0) + line.qty);
          }
          for (const [productId, qty] of qtyByProduct) {
            await tx.product.update({ where: { id: productId }, data: { salesCount: { increment: qty } } });
            txStatements++;
          }

          await tx.orderStatusHistory.create({
            data: { orderId: order.id, fromStatus: null, toStatus: "payment_pending", actor: "shopper", note: `Checkout via ${provider} (payment group ${providerRef})` },
          });
          txStatements++;

          if (g.coupon.valid && g.coupon.couponId) {
            await tx.couponRedemption.create({
              data: {
                couponId: g.coupon.couponId,
                orderId: order.id,
                customerEmail,
                discountMinor: g.discountMinor,
              },
            });
            txStatements++;
            await tx.coupon.update({ where: { id: g.coupon.couponId }, data: { timesUsed: { increment: 1 } } });
            txStatements++;
          }
        }

        return paymentGroup;
      }, { timeout: 15_000 }); // bounded >5s default: measured P2028 under rush (dev.log)

      // Notifications + audit (one per seller order, plus admin roll-up).
      // PHASE 2 / A2: independent writes fan out in parallel (were sequential
      // per order); the data comes from the in-tx summary (no re-read).
      await Promise.all(
        orderSummaries.map((o) => {
          const vo = outcomeByStore.get(o.storeId);
          return Promise.all([
            notify({
              event: "order.created",
              channel: "email",
              recipient: "admin@nomofee.io",
              subject: `New order ${o.orderNumber} — ${o.storeName}`,
            }),
            logActivity({
              actorType: "shopper",
              action: "order.created",
              entityType: "order",
              entityId: o.id,
              meta: {
                orderNumber: o.orderNumber,
                storeSlug: o.storeSlug,
                totalMinor: o.totalMinor,
                paymentGroupRef: group.ref,
                voucher: vo
                  ? { code: vo.code, kind: vo.kind, discountMinor: vo.discountMinor, freeShipping: vo.freeShipping, fsPriceAdjustMinor: vo.fsPriceAdjustMinor }
                  : undefined,
              },
            }),
          ]);
        })
      );
      timing.mark("postTx");

      // PHASE 2.1 (§9-A): the transaction deducted stock (CAS per line) and
      // bumped salesCount — cached public product/market data is now stale.
      // Bust the products tag so the NEXT public read serves live stock (the
      // 30–45 s TTL remains the safety net for any path that bypasses this).
      // Checkout itself NEVER reads this cache — its authoritative checks are
      // transactional and untouched.
      bustPublicProductCache();

      const response = ok(
        {
          orderNumber: orderSummaries[0]?.orderNumber ?? "",
          orderNumbers: orderSummaries.map((o) => o.orderNumber),
          orderPaymentRef: group.ref,
          paymentRef: group.ref,
          totalMinor: group.totalMinor,
          redirectUrl: group.redirectUrl,
          status: "payment_pending",
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

      // txExec = statements + commit (total minus the acquire window). The emit
      // itself is deferred past the admission gate so the measured queue wait
      // rides along (see pendingEmit consumption below).
      const txTotalMs = performance.now() - txCallAt;
      emitHolder.pending = {
        status: 201,
        extra: {
          txAcquireMs: Math.round(txAcquireMs * 10) / 10,
          txExecMs: Math.round((txTotalMs - txAcquireMs) * 10) / 10,
          txStatements,
        },
      };
      return response;
    }; // end runCheckout (under admission control)

    const { result, queueMs } = await withCheckoutAdmission(runCheckout);
    const pendingEmit = emitHolder.pending;
    if (pendingEmit) {
      timing.emit(pendingEmit.status, { ...pendingEmit.extra, gateWaitMs: queueMs, ...gateStats() });
    }
    // Queue-time telemetry, separate from processing time (F2/C4).
    try {
      result.headers.set("X-Checkout-Queue-Ms", String(queueMs));
    } catch {
      /* header surface only */
    }
    return result;
  } catch (e) {
    // Error path anatomy (status 0 — the HTTP status is only known to handle()).
    timing.emit(0, { gateWaitMs: 0, ...gateStats() });
    throw e;
  }
});
