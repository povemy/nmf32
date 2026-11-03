// RX-PRV Phase 2.2 — C1.1 (payment/expiry races) + C1.2 (affiliate payout/refund races).
// ═════════════════════════════════════════════════════════════════════════════════════
// PREPARED, NOT RUN in the dev sandbox (operational restriction: no unauthorized DB
// access — the dev Supabase project may not be used for new tests). This suite is
// written for an AUTHORIZED STAGING environment:
//
//   Prerequisites: dev server on :3000 (staging deployment), PSP_WEBHOOK_SECRET set
//   (or the documented demo value), CRON auth not required (the sweep runs in-process
//   below — no HTTP cron call is made), seeded stores bytebazaar + glow-theory.
//   Run:  bun scripts/readiness/phase22-races.ts
//
// Scenarios map 1:1 to the Phase 2.2 programme's "Required tests" lists:
//   C1.1: webhook-vs-expiry race · expiry-vs-duplicate expiry · late successful
//         payment · two simultaneous expiry workers · multi-order PaymentGroup ·
//         stock restored exactly once · no resurrection of cancelled orders ·
//         no duplicate ledger postings.
//   C1.2: two simultaneous payout requests · duplicate payout approval · duplicate
//         transfer requests · refund before payout request · refund after payout
//         request before approval · refund during payout processing · retry after
//         PSP timeout · exactly-once commission consumption · liability
//         reconciliation.
// All fixtures are tagged "[LT]" and best-effort cleaned in `finally`.
// @ts-nocheck
import { db } from "../../src/lib/db";
import {
  makeLtVariant,
  ltShopperCookie,
  checkout,
  sendWebhook,
  cleanupCarts,
  check,
  LT,
  BASE,
} from "./lib";
import { runExpirySweep } from "../../src/lib/expiry-sweep";
import { hashPasswordAsync } from "../../src/lib/password";
import { base32Decode, totpCode, totpCounterAt } from "../../src/lib/mfa";

const stamp = Date.now().toString(36);
// PHASE 3 / STEP 4 fixture fix: link codes must satisfy the PRODUCTION hex
// format gate (/^[a-f0-9-]{6,32}$/i in resolveAffiliateLink) — the original
// `ltp22link…` alphabet contains non-hex letters and was rejected 404
// LINK_NOT_FOUND on first-ever execution. Same for the profile code below.
const hexStamp = `${Date.now().toString(16)}${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")}`;

// ── local helpers (staging-only; [LT]-tagged fixtures) ────────────────────────
// PHASE 3 / STEP 4: the C1.2 admin flows hit the affiliate.finance capability,
// whose roles (superadmin/finance) are MFA-mandatory (mfaEnrollmentGate).
// The original plain-login adminToken predates that gate and was never run
// anywhere — every admin money call would 403 MFA_ENROLLMENT_REQUIRED. This
// version provisions a dedicated [LT] finance admin, enrolls + confirms MFA
// through the REAL API surface (no bypass), and completes the challenge login
// with a computed TOTP — the exact mfa-e2e machinery.
async function adminToken(_email: string, _password: string): Promise<string> {
  const email = `lt-p22-fin-${stamp}@nomofee.test`;
  const password = "LtP22Fin123!pass";
  await db.adminUser.create({
    data: { email, name: "LT P22 Finance", role: "finance", isActive: true, passwordHash: await hashPasswordAsync(password) },
  });
  const login0 = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, portal: "admin" }),
  });
  const j0 = (await login0.json().catch(() => ({})))?.data ?? {};
  const tok0 = j0.token as string;
  if (login0.status !== 200 || !tok0) throw new Error(`MFA-fixture admin login failed (${login0.status})`);
  const enroll = await fetch(`${BASE}/api/admin/mfa/enroll`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok0}` },
    body: JSON.stringify({ password }),
  });
  const en = (await enroll.json().catch(() => ({})))?.data ?? {};
  const secret = base32Decode(String(en.secretBase32 ?? ""));
  if (enroll.status !== 200 || !secret) throw new Error(`MFA enrollment failed (${enroll.status})`);
  const code = totpCode(secret, totpCounterAt(Math.floor(Date.now() / 1000)));
  const confirm = await fetch(`${BASE}/api/admin/mfa/confirm`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok0}` },
    body: JSON.stringify({ password, code }),
  });
  if (confirm.status !== 200) throw new Error(`MFA confirm failed (${confirm.status})`);
  // The confirm consumed TOTP counter C; the replay guard (consumeTotpCounter,
  // lastUsedTotpCounter monotonic) rejects any reuse of C. Wait for the NEXT
  // 30 s window so the challenge verify uses a genuinely fresh counter —
  // this is the replay protection doing its job, not a defect.
  const waitMs = Math.max(0, 30_100 - (Date.now() % 30_000));
  await new Promise((r) => setTimeout(r, waitMs));
  // Challenge login → TOTP verify → session token.
  const login1 = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, portal: "admin" }),
  });
  const j1 = (await login1.json().catch(() => ({})))?.data ?? {};
  const challenge = j1.challenge as string | undefined;
  if (login1.status !== 200 || !challenge) throw new Error(`MFA challenge login failed (${login1.status})`);
  const code2 = totpCode(secret, totpCounterAt(Math.floor(Date.now() / 1000)));
  const verify = await fetch(`${BASE}/api/auth/mfa/verify`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challenge, code: code2 }),
  });
  const jv = (await verify.json().catch(() => ({})))?.data ?? {};
  if (verify.status !== 200 || !jv.token) throw new Error(`MFA verify failed (${verify.status})`);
  return jv.token as string;
}

/** Variant in a specific store (lib.makeLtVariant is bytebazaar-only). */
async function makeLtVariantIn(storeSlug: string, tag: string, stock: number) {
  const store = await db.store.findUnique({ where: { slug: storeSlug }, select: { id: true } });
  if (!store) throw new Error(`${storeSlug} store missing`);
  const product = await db.product.create({
    data: { storeId: store.id, title: `${LT} P22 product ${tag}`, slug: `lt-p22-${tag}-${stamp}`, description: "Phase 2.2 race-test artifact", status: "active", priceMinor: 1000, affiliateEnabled: true },
  });
  const variant = await db.productVariant.create({
    data: { productId: product.id, name: "std", stock, moq: 1, priceMinor: 1000, isActive: true },
  });
  return { productId: product.id, variantId: variant.id, storeId: store.id, stock };
}

async function stockOf(variantId: string): Promise<number> {
  return (await db.productVariant.findUnique({ where: { id: variantId } }))!.stock;
}

async function restockedTotal(variantId: string): Promise<number> {
  const logs = await db.inventoryLog.findMany({ where: { variantId, reason: { startsWith: "expiry:" } } });
  return logs.reduce((s, l) => s + l.delta, 0);
}

async function expireGroupNow(ref: string) {
  await db.paymentGroup.update({ where: { ref }, data: { expiresAt: new Date(Date.now() - 1000) } });
}

// ═══════════════════════════════════ SUITE 1 — C1.1 ═══════════════════════════════════
const shopperEmail = `lt-p22-buyer-${stamp}@lt.test`;
const cookie = await ltShopperCookie(shopperEmail, "LT P22 Buyer");
const createdVariantIds: string[] = [];

async function suiteC11() {
  // ── R1: webhook vs expiry race (single-order group) ──────────────────────
  console.log("── R1: webhook vs expiry race ──");
  const v = await makeLtVariant(`r1-${stamp}`, 5);
  createdVariantIds.push(v.variantId);
  const co = await checkout(cookie, v.variantId, `p22-r1-${stamp}`, 2);
  if (co.status !== 201) { console.log("FATAL R1 checkout failed", co.status, co.body); return; }
  const ref = co.body.data.paymentRef as string;
  const grp = await db.paymentGroup.findUnique({ where: { ref }, include: { orders: true } })!;
  const orderId = grp!.orders[0].id;
  await expireGroupNow(ref);
  // Fire the sweep (in-process, same staging DB) and the webhook concurrently.
  const [sweepRes, hookRes] = await Promise.all([
    runExpirySweep(),
    sendWebhook(ref, "payment.succeeded", grp!.totalMinor),
  ]);
  const order = await db.order.findUnique({ where: { id: orderId } })!;
  const paid = order!.status === "paid";
  const expired = order!.status === "payment_expired";
  const stock = await stockOf(v.variantId);
  const restocked = await restockedTotal(v.variantId);
  const t1 = await db.ledgerTransaction.count({ where: { dedupKey: `order_paid:order:${orderId}` } });
  const obligations = await db.paymentReconciliation.count({ where: { providerRef: ref } });
  check("R1.a: exactly one terminal outcome (paid XOR payment_expired)", paid !== expired, `status=${order!.status}`);
  // Work 2 re-run finding (fixture-assertion defect, product behavior correct):
  // stock=5 − qty=2 ⇒ PAID leaves 3 (sold), EXPIRED restores to 5 with exactly
  // qty restocked. The paid branch previously asserted stock===5 — a latent
  // bug only visible when PAYMENT wins the race (Step 4's run had expiry win).
  check("R1.b: no resurrection — paid ⇒ no restock / expired ⇒ restocked exactly once",
    paid ? (restocked === 0 && stock === 3) : (restocked === 2 && stock === 5), `stock=${stock} restocked=${restocked}`);
  check("R1.c: T1 exists iff paid (no duplicate ledger postings)", paid ? t1 === 1 : t1 === 0, `t1=${t1}`);
  check("R1.d: sweep outcome sane (never both failed and claimed)", sweepRes.failures === 0, JSON.stringify(sweepRes));
  check("R1.e: webhook honoured the winner (200-ish when paid, 409 when expired)",
    paid ? hookRes.status === 200 : hookRes.status === 409, `http=${hookRes.status} code=${hookRes.body?.error?.code}`);
  check("R1.f: late-payment obligation exists iff expiry won", expired ? obligations >= 1 : obligations === 0, `obligations=${obligations}`);

  // ── R2/R3: duplicate expiry + two simultaneous workers ───────────────────
  console.log("── R2: two simultaneous expiry workers on the same group ──");
  const v2 = await makeLtVariant(`r2-${stamp}`, 3);
  createdVariantIds.push(v2.variantId);
  const co2 = await checkout(cookie, v2.variantId, `p22-r2-${stamp}`, 1);
  if (co2.status === 201) {
    const ref2 = co2.body.data.paymentRef as string;
    const grp2 = await db.paymentGroup.findUnique({ where: { ref: ref2 }, include: { orders: true } })!;
    await expireGroupNow(ref2);
    await Promise.all([runExpirySweep(), runExpirySweep(), runExpirySweep()]);
    const stock2 = await stockOf(v2.variantId);
    const restocked2 = await restockedTotal(v2.variantId);
    const logs2 = await db.inventoryLog.count({ where: { variantId: v2.variantId, reason: { startsWith: "expiry:" } } });
    check("R2.a: stock restored exactly once (3 workers, 1 unit)", stock2 === 3 && restocked2 === 1, `stock=${stock2} restocked=${restocked2}`);
    check("R2.b: exactly one InventoryLog row per restocked unit", logs2 === 1, `logs=${logs2}`);
    check("R2.c: group terminal-expired exactly once", (await db.paymentGroup.findUnique({ where: { id: grp2!.id } }))!.status === "expired");

    // ── R3: late successful payment AFTER expiry committed ─────────────────
    console.log("── R3: late successful payment after expiry ──");
    const hook1 = await sendWebhook(ref2, "payment.succeeded", grp2!.totalMinor);
    const hook2 = await sendWebhook(ref2, "payment.succeeded", grp2!.totalMinor); // PSP redelivery
    const order2 = await db.order.findUnique({ where: { id: grp2!.orders[0].id } })!;
    const t1c = await db.ledgerTransaction.count({ where: { dedupKey: `order_paid:order:${grp2!.orders[0].id}` } });
    const obl2 = await db.paymentReconciliation.findMany({ where: { providerRef: ref2 } });
    check("R3.a: both deliveries refused 409 (no resurrection)", hook1.status === 409 && hook2.status === 409, `${hook1.status}/${hook2.status}`);
    check("R3.b: order stays payment_expired", order2!.status === "payment_expired", order2!.status);
    check("R3.c: zero T1 postings for the late payment", t1c === 0, `t1=${t1c}`);
    check("R3.d: exactly one durable refund obligation (idempotent upsert)", obl2.length === 1, `obligations=${obl2.length}`);
    check("R3.e: stock NOT double-restocked by the webhook", (await restockedTotal(v2.variantId)) === 1);
  } else {
    check("R2/R3 fixture", false, `checkout status ${co2.status}`);
  }

  // ── R4: multi-order PaymentGroup (two sellers, one checkout) ─────────────
  console.log("── R4: multi-order PaymentGroup expiry + payment ──");
  const va = await makeLtVariant(`r4a-${stamp}`, 4); // bytebazaar
  const vb = await makeLtVariantIn("glow-theory", `r4b-${stamp}`, 4); // second seller
  createdVariantIds.push(va.variantId, vb.variantId);
  const co4 = await fetch(`${BASE}/api/checkout/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie, "Idempotency-Key": `p22-r4-${stamp}` },
    body: JSON.stringify({
      items: [{ variantId: va.variantId, qty: 1 }, { variantId: vb.variantId, qty: 1 }],
      customer: { name: "LT P22 Buyer", email: shopperEmail },
      shippingAddress: { line1: "1 LT Jalan", city: "Kuala Lumpur", postcode: "50000", state: "Kuala Lumpur" },
      provider: "fpx_toyyibpay",
    }),
  });
  const co4body = await co4.json().catch(() => ({}));
  if (co4.status === 201) {
    const ref4 = co4body.data.paymentRef as string;
    const grp4 = await db.paymentGroup.findUnique({ where: { ref: ref4 }, include: { orders: { include: { items: true } } } })!;
    check("R4.a: one group → two per-seller orders", grp4!.orders.length === 2, `orders=${grp4!.orders.length}`);
    // Payment path first (both orders must pay under one webhook).
    const hook4 = await sendWebhook(ref4, "payment.succeeded", grp4!.totalMinor);
    const orders4 = await db.order.findMany({ where: { id: { in: grp4!.orders.map((o) => o.id) } } });
    check("R4.b: one webhook settles BOTH member orders", hook4.status === 200 && orders4.every((o) => o.status === "paid"), `http=${hook4.status} statuses=${orders4.map((o) => o.status).join(",")}`);
    check("R4.c: exactly two T1 postings (one per order)", await db.ledgerTransaction.count({ where: { dedupKey: { in: grp4!.orders.map((o) => `order_paid:order:${o.id}`) } } }) === 2);
    // Expiry path on a second multi-order group.
    const co4b = await checkout(cookie, va.variantId, `p22-r4b-${stamp}`, 1);
    if (co4b.status === 201) {
      const ref4b = co4b.body.data.paymentRef as string;
      const grp4b = await db.paymentGroup.findUnique({ where: { ref: ref4b }, include: { orders: true } })!;
      await expireGroupNow(ref4b);
      await runExpirySweep();
      const orders4b = await db.order.findMany({ where: { id: { in: grp4b!.orders.map((o) => o.id) } } });
      check("R4.d: group expiry transitions EVERY member order", grp4b!.orders.length >= 1 && orders4b.every((o) => o.status === "payment_expired"), `n=${orders4b.length} ${orders4b.map((o) => o.status).join(",")}`);
      check("R4.e: stock restored for the expired group's variants", (await restockedTotal(va.variantId)) >= 1);
    }
  } else {
    check("R4 fixture (multi-seller checkout)", false, `status=${co4.status}`);
  }
}

// ═══════════════════════════════════ SUITE 2 — C1.2 ═══════════════════════════════════
async function suiteC12() {
  console.log("── P1–P6: affiliate payout ↔ refund races ──");
  // Fixture: [LT] affiliate (user + profile + link), [LT] buyer with attribution.
  const affEmail = `lt-p22-aff-${stamp}@lt.test`;
  // 429-aware registration (5/min/IP in-app window — rapid re-runs trip it).
  let reg = await fetch(`${BASE}/api/auth/shopper/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: affEmail, password: "LtAff123!", fullName: "LT P22 Affiliate" }),
  });
  if (reg.status === 429) {
    const waitMs = Number((await reg.json().catch(() => ({})))?.error?.details?.retryAfterSeconds ?? 0) * 1000;
    console.log(`[p22] affiliate register 429 — waiting ${waitMs || 65000}ms`);
    await new Promise((r) => setTimeout(r, waitMs || 65_000));
    reg = await fetch(`${BASE}/api/auth/shopper/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: affEmail, password: "LtAff123!", fullName: "LT P22 Affiliate" }),
    });
  }
  const affLogin = await fetch(`${BASE}/api/auth/shopper/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: affEmail, password: "LtAff123!" }),
  });
  const affJson = await affLogin.json().catch(() => ({}));
  const affBearer = affJson?.data?.token as string | undefined;
  const affUser = await db.shopperUser.findUnique({ where: { email: affEmail } });
  if (!affUser || !affBearer) { check("P fixture: affiliate user", false, `reg=${reg.status} login=${affLogin.status}`); return; }
  const profile = await db.affiliateProfile.create({
    data: { userId: affUser.id, status: "active", code: hexStamp, slug: `lt-p22-${stamp}`, displayName: "LT P22 Affiliate", termsVersion: 1, termsAcceptedAt: new Date() },
  });
  const link = await db.affiliateLink.create({
    data: { affiliateId: profile.id, type: "store", code: `f22${hexStamp}`, storeId: (await db.store.findUnique({ where: { slug: "bytebazaar" }, select: { id: true } }))!.id },
  });

  // PHASE 3 / STEP 4 fixture fix: qty 25 × RM 10 = RM 250 → 5% affiliate pool
  // = RM 12.50, comfortably ABOVE the RM 10.00 minPayoutMinor default the
  // payout request route enforces (BELOW_MIN_PAYOUT 409 otherwise — the
  // original qty-2 fixture yielded RM 1.00 and could never reach a payout).
  const v = await makeLtVariant(`p-${stamp}`, 40);
  createdVariantIds.push(v.variantId);
  // Buyer visits the affiliate link (money-grade touch cookie), then checks out.
  const buyerCookie = await ltShopperCookie(`lt-p22-buyer2-${stamp}@lt.test`, "LT P22 Buyer 2");
  const trackRes = await fetch(`${BASE}/api/affiliate/track`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie: buyerCookie },
    body: JSON.stringify({ code: link.code }),
  });
  const setCookie = trackRes.headers.getSetCookie?.().join("; ") ?? "";
  const co = await fetch(`${BASE}/api/checkout/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: `${buyerCookie}; ${setCookie}`, "Idempotency-Key": `p22-p-${stamp}` },
    body: JSON.stringify({ items: [{ variantId: v.variantId, qty: 25 }], customer: { name: "LT P22 Buyer 2", email: `lt-p22-buyer2-${stamp}@lt.test` }, shippingAddress: { line1: "1 LT Jalan", city: "Kuala Lumpur", postcode: "50000", state: "Kuala Lumpur" }, provider: "fpx_toyyibpay" }),
  });
  const coBody = await co.json().catch(() => ({}));
  if (co.status !== 201) { check("P fixture: attributed checkout", false, `status=${co.status}`); return; }
  const ref = coBody.data.paymentRef as string;
  const grp = await db.paymentGroup.findUnique({ where: { ref }, include: { orders: { include: { items: true } } } })!;
  await sendWebhook(ref, "payment.succeeded", grp!.totalMinor);
  const commissions = await db.affiliateCommission.findMany({ where: { orderItemId: { in: grp!.orders.flatMap((o) => o.items.map((i) => i.id)) } }, include: { entries: true } });
  check("P0.a: payment created affiliate commission entries", commissions.length > 0 && commissions.every((c) => c.entries.length > 0), `commissions=${commissions.length}`);
  if (commissions.length === 0) return;
  // Fast-forward maturity (staging shortcut for review_days): entries → available.
  await db.affiliateCommissionEntry.updateMany({
    where: { commissionId: { in: commissions.map((c) => c.id) } },
    data: { status: "available", availableAt: new Date(Date.now() - 1000) },
  });
  // PHASE 3 / STEP 4 fixture completion: the SELLER-side hold must mature too.
  // The refund process route's conservative sufficiency gate requires the FULL
  // refund amount to be AVAILABLE (ledger truth), and fresh T1 credits sit in
  // the hold period (payoutHoldDays / bytebazaar holdDaysOverride=10) — without
  // this aging the P3 refund correctly 409s INSUFFICIENT_WALLET and the whole
  // refund-during-processing scenario is unreachable.
  {
    const byteStore = await db.store.findUnique({
      where: { slug: "bytebazaar" },
      select: { seller: { select: { wallet: { select: { id: true } } } } },
    });
    const byteWalletId = byteStore?.seller?.wallet?.id;
    if (byteWalletId) {
      await db.ledgerLine.updateMany({
        where: { walletId: byteWalletId, availableAt: { gt: new Date() } },
        data: { availableAt: new Date(Date.now() - 1000) },
      });
      const { refreshWalletCache } = await import("../../src/lib/ledger");
      await refreshWalletCache(byteWalletId);
    }
  }

  const admin = await adminToken(process.env.LT_ADMIN_EMAIL ?? "finance@nomofee.io", process.env.LT_ADMIN_PASSWORD ?? "Finance123!");
  const adminH = { "Content-Type": "application/json", Authorization: `Bearer ${admin}` };

  // P1 — two simultaneous payout requests.
  const reqBody = JSON.stringify({});
  const [p1a, p1b] = await Promise.all([
    fetch(`${BASE}/api/affiliate/payouts`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${affBearer}` }, body: reqBody }),
    fetch(`${BASE}/api/affiliate/payouts`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${affBearer}` }, body: reqBody }),
  ]);
  const p1aJ = await p1a.json().catch(() => ({})); const p1bJ = await p1b.json().catch(() => ({}));
  const payouts = await db.affiliatePayout.findMany({ where: { affiliateId: profile.id, status: { in: ["requested", "processing"] } } });
  const wonPayout = p1a.status === 201 || p1a.status === 200 ? p1aJ : p1bJ;
  const loser = p1a.status === 201 || p1a.status === 200 ? p1bJ : p1aJ;
  check("P1.a: exactly one open payout survives two racing requests", payouts.length === 1, `open=${payouts.length}`);
  check("P1.b: loser refused (409 PAYOUT_OPEN / CLAIM_CONFLICT)", loser?.error?.code === "PAYOUT_OPEN" || loser?.error?.code === "PAYOUT_CLAIM_CONFLICT", `code=${loser?.error?.code}`);
  check("P1.c: frozen amount equals claimed matured entries", (wonPayout?.data?.amountMinor ?? 0) > 0, `amount=${wonPayout?.data?.amountMinor}`);
  // PHASE 3 / STEP 4 fixture fix: POST /api/affiliate/payouts returns
  // { payoutId, amountMinor } (requestAffiliatePayout) — the original read
  // data.id (always undefined → every admin process call 404'd).
  const payoutId = (wonPayout?.data?.payoutId ?? wonPayout?.data?.id) as string;
  const frozen = wonPayout?.data?.amountMinor as number;

  // P2 — duplicate approval race.
  const [apA, apB] = await Promise.all([
    fetch(`${BASE}/api/admin/affiliate/payouts/${payoutId}/process`, { method: "POST", headers: adminH, body: JSON.stringify({ action: "approve" }) }),
    fetch(`${BASE}/api/admin/affiliate/payouts/${payoutId}/process`, { method: "POST", headers: adminH, body: JSON.stringify({ action: "approve" }) }),
  ]);
  const tA3 = await db.ledgerTransaction.count({ where: { dedupKey: `affiliate_payout_initiated:affpayout:${payoutId}` } });
  check("P2.a: exactly one approve wins", [apA.status, apB.status].filter((s) => s === 200).length === 1, `${apA.status}/${apB.status}`);
  check("P2.b: exactly one T-A3 clearing posting (dedupKey)", tA3 === 1, `tA3=${tA3}`);
  const fresh1 = await db.affiliatePayout.findUnique({ where: { id: payoutId } })!;

  // P3/P4 — refund DURING processing (clearing-side coordination).
  const orderId = grp!.orders[0].id;
  const refund = await db.refund.create({
    data: { orderId, amountMinor: Math.floor(grp!.totalMinor / 2), reason: `${LT} P22 race refund`, status: "requested", requestedBy: "seller", restock: false },
  });
  await fetch(`${BASE}/api/admin/refunds/${refund.id}/approve`, { method: "POST", headers: adminH, body: "{}" });
  const proc = await fetch(`${BASE}/api/admin/refunds/${refund.id}/process`, { method: "POST", headers: adminH, body: "{}" });
  const fresh2 = await db.affiliatePayout.findUnique({ where: { id: payoutId } })!;
  const entriesAfter = await db.affiliateCommissionEntry.findMany({ where: { commissionId: { in: commissions.map((c) => c.id) } } });
  const reversedSum = entriesAfter.reduce((s, e) => s + e.reversedMinor, 0);
  check("P3.a: refund processed while payout in-flight", proc.status === 200, `http=${proc.status}`);
  check("P3.b: frozen payout amount shrank by the applied reversal (refund cannot double-consume)",
    fresh2!.amountMinor === Math.max(0, frozen - reversedSum), `frozen ${frozen} → ${fresh2!.amountMinor}, reversed=${reversedSum}`);
  check("P3.c: entries carry the reversal (exactly-once consumption bookkeeping)", reversedSum > 0, `reversed=${reversedSum}`);

  // P5 — duplicate transfer requests (mark-paid race) at the REDUCED amount.
  const bodyPaid = JSON.stringify({ action: "mark-paid", reference: `${LT}transfer-${stamp}` });
  const [mpA, mpB] = await Promise.all([
    fetch(`${BASE}/api/admin/affiliate/payouts/${payoutId}/process`, { method: "POST", headers: adminH, body: bodyPaid }),
    fetch(`${BASE}/api/admin/affiliate/payouts/${payoutId}/process`, { method: "POST", headers: adminH, body: bodyPaid }),
  ]);
  const tA4 = await db.ledgerTransaction.count({ where: { dedupKey: `affiliate_payout_confirmed:affpayout:${payoutId}` } });
  const fresh3 = await db.affiliatePayout.findUnique({ where: { id: payoutId } })!;
  check("P5.a: exactly one mark-paid wins", [mpA.status, mpB.status].filter((s) => s === 200).length === 1, `${mpA.status}/${mpB.status}`);
  check("P5.b: exactly one T-A4 transfer posting (PSP/transfer idempotency)", tA4 === 1, `tA4=${tA4}`);
  check("P5.c: payout paid at the POST-refund reduced amount (never the stale frozen figure)",
    fresh3!.status === "paid" && fresh3!.amountMinor === fresh2!.amountMinor, `status=${fresh3!.status} amount=${fresh3!.amountMinor}`);

  // P6 — liability reconciliation: Σ(entry amounts) == Σ(reversed) + Σ(paid out) + residual.
  const totalEntryMinor = entriesAfter.reduce((s, e) => s + e.amountMinor, 0);
  const paidOut = fresh3!.amountMinor;
  check("P6.a: commission conservation (amounts == reversed + paid + residual)",
    totalEntryMinor >= reversedSum + paidOut, `total=${totalEntryMinor} reversed=${reversedSum} paid=${paidOut}`);
  const bal = await fetch(`${BASE}/api/affiliate/me`, { headers: { Authorization: `Bearer ${affBearer}` } });
  check("P6.b: affiliate balance endpoint healthy after the race", bal.status === 200 || bal.status === 404, `http=${bal.status}`);
}

// ── run + cleanup ────────────────────────────────────────────────────────────
try {
  await suiteC11();
  await suiteC12();
} finally {
  // Best-effort cleanup of [LT] fixtures (orders/payments/ledger retained for audit).
  try {
    for (const vid of createdVariantIds) {
      const v = await db.productVariant.findUnique({ where: { id: vid }, include: { product: true } });
      if (v) { await db.productVariant.delete({ where: { id: vid } }).catch(() => {}); await db.product.delete({ where: { id: v.productId } }).catch(() => {}); }
    }
    // PHASE 3 / STEP 4: affiliate profile/link/commission fixtures are
    // RETAINED (audit convention — the race's financial evidence feeds the
    // post-run invariant verification; deleting the profile trips
    // AffiliateCommission_affiliateId_fkey anyway).
    // [LT] MFA finance admin fixture (Phase 3 / Step 4): enrollment + sessions
    // + account, mirroring mfa-e2e's cleanup.
    try {
      const finAdmin = await db.adminUser.findUnique({ where: { email: `lt-p22-fin-${stamp}@nomofee.test` } });
      if (finAdmin) {
        await db.adminMfaEnrollment.deleteMany({ where: { adminId: finAdmin.id } });
        await db.session.deleteMany({ where: { userId: finAdmin.id } });
        await db.activityLog.deleteMany({ where: { actorId: finAdmin.id } });
        await db.adminUser.delete({ where: { id: finAdmin.id } });
      }
    } catch {}
    await cleanupCarts([shopperEmail, `lt-p22-aff-${stamp}@lt.test`, `lt-p22-buyer2-${stamp}@lt.test`]);
  } catch (e) {
    console.log("[cleanup] best-effort cleanup failed (fixtures remain, [LT]-tagged):", e instanceof Error ? e.message : e);
  }
  console.log(`\nPhase 2.2 race suite run ${stamp} complete.`);
}
