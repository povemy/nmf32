// ============================================================================
// FIN-4 VERIFICATION GATE — financial-system hardening (non-destructive).
// Run:  bun scripts/verify-finance-hardening.ts     (or: bun run verify:finance)
// Exit 0 = all sections pass, exit 1 = any failure. Requires the dev server
// on 127.0.0.1:3000 (same convention as scripts/verify-commerce.ts).
//
// Probes (REAL API calls + read-only DB counts — no ledger edits/deletes):
//   A  Payment webhook idempotency — checkout → /simulate ×2 → no double
//      posting; raw signed webhook replay → duplicate:true, counts identical.
//   B  Payout lifecycle — request → concurrent double-approve (one 200 + one
//      409, T3 exactly once) → payout-simulate (T4 once, payout.paid
//      notifications exactly 2) → replay is a no-op (payoutConflict).
//   C  Refund guards — full refund happy path (T5 once, replay 409), over-refund
//      requests blocked 409 (status guard on residue + true cumulative-amount cap),
//      process replay 409, and the insufficient-wallet path (409
//      INSUFFICIENT_WALLET, no T5).
//   D  Reconciliation — payout sync truthful (T3/T4/cacheMatches); sweep ×2 is
//      idempotent (2nd run alerts nothing new, invariants PASS).
//   E  Rate limiting — 12-burst on /simulate → at least one 429.
//   F  Invariants — spawn scripts/verify-ledger.ts + scripts/finance-preflight.ts.
//
// RESIDUE POLICY: this run creates real rows (audited, balanced). It REUSES
// leftover probe residue where possible (NM-100036 unpaid checkout → pay via
// simulate → refund; NM-100037 partially_refunded for the over-cap probe)
// instead of minting fresh ones, and prints every reuse + creation.
// A seller wallet top-up via the audited admin adjust API (T6) happens ONLY if
// no seller holds enough available balance — printed with amounts + reason.
// ============================================================================
import { createHmac } from "crypto";
import { db } from "../src/lib/db";

const BASE = "http://127.0.0.1:3000";
// Mirrors process.ts exactly (same fallback the dev server uses).
const WEBHOOK_SECRET = process.env.PSP_WEBHOOK_SECRET ?? "sm_webhook_secret_demo";
const RUN = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

let failures = 0;

function check(name: string, cond: boolean, detail = "") {
  const line = `${cond ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`;
  console.log(line);
  if (!cond) failures++;
  return cond;
}

function section(title: string) {
  console.log(`\n--- ${title} ---`);
}

type Json = { data?: Record<string, unknown> | unknown[]; error?: { code?: string; message?: string }; [k: string]: unknown };

async function api(
  method: "GET" | "POST",
  path: string,
  opts: { token?: string; cookie?: string; body?: unknown; idemKey?: string } = {}
): Promise<{ status: number; json: Json }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.idemKey) headers["Idempotency-Key"] = opts.idemKey;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    let json: Json = {};
    try {
      json = (await res.json()) as Json;
    } catch {
      /* empty body */
    }
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: { error: { code: "FETCH_ERROR", message: String(e) } } };
  }
}

const errCode = (j: Json) => (j.error as { code?: string } | undefined)?.code ?? "";
const errMsg = (j: Json) => (j.error as { message?: string } | undefined)?.message ?? "";

const txnCount = () => db.ledgerTransaction.count();
const lineCount = () => db.ledgerLine.count();
const dedupCount = (key: string) => db.ledgerTransaction.count({ where: { dedupKey: key } });

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
async function loginShopper(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/shopper/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "qa.shopper@nomofee.test", password: "Shopper123!" }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (res.status !== 200 || !cookie) throw new Error(`shopper login failed: ${res.status}`);
  return cookie;
}

async function login(portal: "admin" | "seller", email: string, password: string): Promise<string> {
  const { status, json } = await api("POST", "/api/auth/login", { body: { email, password, portal } });
  const token = (json.data as { token?: string } | undefined)?.token;
  if (status !== 200 || !token) throw new Error(`${portal} login failed: ${status} ${errMsg(json)}`);
  return token;
}

async function createCheckout(cookie: string, variantId: string): Promise<string> {
  const { status, json } = await api("POST", "/api/checkout/create", {
    cookie,
    idemKey: `fin4-${RUN}-${crypto.randomUUID()}`,
    body: {
      items: [{ variantId, qty: 1 }],
      customer: { name: "QA Shopper", email: "qa.shopper@nomofee.test" },
      shippingAddress: { line1: "1 Test Jalan", city: "Kuala Lumpur", postcode: "50000", state: "Kuala Lumpur", country: "MY", phone: "0100000000" },
      provider: "fpx_toyyibpay",
    },
  });
  const d = (json.data ?? {}) as { paymentRef?: string; ref?: string; redirectUrl?: string };
  const ref = d.paymentRef ?? d.ref ?? d.redirectUrl?.split("/").pop() ?? "";
  if ((status !== 200 && status !== 201) || !ref) throw new Error(`checkout create failed: ${status} ${JSON.stringify(json).slice(0, 200)}`);
  return ref;
}

async function simulate(ref: string): Promise<{ status: number; json: Json }> {
  return api("POST", `/api/checkout/payments/${encodeURIComponent(ref)}/simulate`, { body: { result: "succeeded" } });
}

function signedWebhookBody(providerRef: string, eventType: string, amountMinor: number) {
  const ts = Date.now();
  const sig = createHmac("sha256", WEBHOOK_SECRET).update(`${providerRef}.${eventType}.${amountMinor}.${ts}`).digest("hex");
  return { providerRef, eventType, amountMinor, ts, sig };
}

// ===========================================================================
// SECTION A — Payment webhook idempotency (no double posting on duplicate)
// ===========================================================================
async function sectionA(): Promise<{ ref: string } | null> {
  section("A — Payment webhook idempotency");
  try {
    const cookie = await loginShopper();
    const variant = await db.productVariant.findFirst({
      where: { product: { store: { slug: "bytebazaar" }, status: "active" }, stock: { gt: 0 } },
      select: { id: true },
    });
    if (!variant) throw new Error("no buyable bytebazaar variant");
    const ref = await createCheckout(cookie, variant.id);
    console.log(`  checkout ref=${ref}`);

    const t0 = await txnCount(); // BEFORE the first delivery
    const l0 = await lineCount();

    const p1 = await simulate(ref);
    check("A1 first /simulate 200", p1.status === 200, `status=${p1.status}`);

    const group = await db.paymentGroup.findUnique({
      where: { ref },
      include: { orders: { select: { orderNumber: true, status: true, totalMinor: true } } },
    });
    check("A2 order(s) paid after 1st delivery", !!group && group.orders.every((o) => o.status === "paid"), group?.orders.map((o) => `${o.orderNumber}:${o.status}`).join(","));
    const amountMinor = group?.totalMinor ?? 0;

    // Baseline AFTER the first (legitimate) delivery — the exactly-once test is
    // that everything after it moves NOTHING.
    const tBase = await txnCount();
    const lBase = await lineCount();
    const firstMove = tBase === t0 + 1 && lBase === l0 + 3; // single T1 = 1 txn / 3 lines
    check("A2b first delivery posted exactly one T1 (1 txn / 3 lines)", firstMove, `txns ${t0}→${tBase}, lines ${l0}→${lBase}`);

    const p2 = await simulate(ref);
    check("A3 second /simulate 200 (replay-safe, response shape preserved)", p2.status === 200, `status=${p2.status}`);
    // NOTE: /simulate intentionally does not surface the processor's duplicate
    // flag (its response shape feeds the checkout UI) — the duplicate:true
    // assertion is made on the raw webhook route below, which returns it.

    const t1 = await txnCount();
    const l1 = await lineCount();
    check("A4 ledger unchanged after duplicate /simulate", t1 === tBase && l1 === lBase, `txns ${tBase}→${t1}, lines ${lBase}→${l1}`);

    // Exact duplicate webhook DELIVERY (same signed event, resent) → duplicate:true
    const replay = await api("POST", "/api/webhooks/payments/mock", {
      body: signedWebhookBody(ref, "payment.succeeded", amountMinor),
    });
    const dup = (replay.json.data as { duplicate?: boolean } | undefined)?.duplicate;
    check("A5 duplicate webhook delivery → duplicate=true", replay.status === 200 && dup === true, `status=${replay.status} duplicate=${String(dup)}`);

    const t2 = await txnCount();
    const l2 = await lineCount();
    check("A6 ledger unchanged after duplicate webhook delivery", t2 === tBase && l2 === lBase, `txns ${tBase}→${t2}, lines ${lBase}→${l2}`);
    return { ref };
  } catch (e) {
    check("A section completed", false, String(e));
    return null;
  }
}

// ===========================================================================
// SECTION B — Payout lifecycle (request → approve → payout-simulate → replay)
// ===========================================================================
async function sectionB(): Promise<{ payoutId: string; referenceNo: string } | null> {
  section("B — Payout lifecycle (atomic claim, exactly-once T4, notify dedup)");
  try {
    const adminToken = await login("admin", "admin@nomofee.io", "Admin123!");
    const sellerToken = await login("seller", "lumina@nomofee.io", "Seller123!");

    const seller = await db.seller.findUnique({ where: { email: "lumina@nomofee.io" }, select: { id: true } });
    if (!seller) throw new Error("seller lumina@nomofee.io not found");
    const wallet = await db.wallet.findUnique({ where: { sellerId: seller.id } });
    if (!wallet) throw new Error("Sofia wallet not found");

    // Ensure available ≥ payout (100000) + Section-C refund headroom (6600) + slack.
    const target = 116600;
    if (wallet.availableMinor < target) {
      const delta = target - wallet.availableMinor;
      const adj = await api("POST", `/api/admin/wallets/${wallet.id}/adjust`, {
        token: adminToken,
        body: {
          amountMinor: delta,
          direction: "credit",
          reason: `FIN-4 gate: audited T6 top-up for payout lifecycle probe + refund headroom (before available=${wallet.availableMinor}, target=${target})`,
        },
      });
      check(
        "B0 wallet top-up via audited admin adjust (T6)",
        adj.status === 200,
        `credited ${delta} minor → available ${wallet.availableMinor}→${((adj.json.data as { after?: { availableMinor?: number } } | undefined)?.after?.availableMinor ?? "?")}`
      );
    } else {
      console.log(`  B0 wallet already funded: available=${wallet.availableMinor} (no adjust needed)`);
    }

    const AMOUNT = 100000;
    const req = await api("POST", "/api/store/payouts", { token: sellerToken, body: { amountMinor: AMOUNT } });
    const payout = (req.json.data as { payout?: { id: string; referenceNo: string; status: string } } | undefined)?.payout;
    check("B1 seller payout request created", req.status === 200 && !!payout, `status=${req.status} ref=${payout?.referenceNo ?? "?"} amount=${AMOUNT}`);
    if (!payout) throw new Error("payout request failed");

    // Concurrent double-approve — the FIN-2a atomic-claim race, replayed live.
    const [ap1, ap2] = await Promise.all([
      api("POST", `/api/admin/payouts/${payout.id}/approve`, { token: adminToken }),
      api("POST", `/api/admin/payouts/${payout.id}/approve`, { token: adminToken }),
    ]);
    const statuses = [ap1.status, ap2.status].sort((a, b) => a - b);
    check("B2 concurrent double-approve → exactly one 200 + one 409", statuses[0] === 200 && statuses[1] === 409, `statuses=${statuses.join("/")}, loser code=${errCode(ap1.status === 409 ? ap1.json : ap2.json)}`);

    const t3 = await dedupCount(`payout_initiated:payout:${payout.id}`);
    check("B3 T3 (payout_initiated) exactly once", t3 === 1, `dedupKey count=${t3}`);

    const sim1 = await api("POST", "/api/webhooks/payments/payout-simulate", { token: adminToken, body: { referenceNo: payout.referenceNo } });
    const sim1Data = (sim1.json.data ?? {}) as { payoutStatus?: string; duplicate?: boolean };
    check("B4 payout-simulate → payout paid", sim1.status === 200 && sim1Data.payoutStatus === "paid", `status=${sim1.status} payoutStatus=${sim1Data.payoutStatus}`);

    const t4 = await dedupCount(`payout_confirmed:payout:${payout.id}`);
    check("B5 T4 (payout_confirmed) exactly once", t4 === 1, `dedupKey count=${t4}`);

    const notifs = await db.notificationLog.findMany({ where: { event: "payout.paid", dedupKey: `payout.paid:${payout.id}` }, select: { channel: true } });
    check(
      "B6 payout.paid notifications exactly 2 (email+inapp)",
      notifs.length === 2 && new Set(notifs.map((n) => n.channel)).size === 2,
      `rows=${notifs.length} channels=[${notifs.map((n) => n.channel).join(",")}]`
    );

    const sim2 = await api("POST", "/api/webhooks/payments/payout-simulate", { token: adminToken, body: { referenceNo: payout.referenceNo } });
    const sim2Data = (sim2.json.data ?? {}) as { payoutStatus?: string; payoutConflict?: boolean; duplicate?: boolean };
    const replayNoOp = sim2.status === 200 && (sim2Data.payoutConflict === true || sim2Data.duplicate === true);
    check("B7 payout-simulate replay → no-op (payoutConflict/duplicate)", replayNoOp, `status=${sim2.status} payoutConflict=${String(sim2Data.payoutConflict)} duplicate=${String(sim2Data.duplicate)}`);

    const t4b = await dedupCount(`payout_confirmed:payout:${payout.id}`);
    const notifsB = await db.notificationLog.count({ where: { event: "payout.paid", dedupKey: `payout.paid:${payout.id}` } });
    check("B8 replay moved nothing (T4 + notifications unchanged)", t4b === 1 && notifsB === 2, `T4=${t4b}, notifications=${notifsB}`);

    return { payoutId: payout.id, referenceNo: payout.referenceNo };
  } catch (e) {
    check("B section completed", false, String(e));
    return null;
  }
}

// ===========================================================================
// SECTION C — Refund guards (happy path T5 once; over-refund 409; replay 409;
//              insufficient wallet 409 with no T5)
// ===========================================================================
async function sectionC(adminToken: string): Promise<void> {
  section("C — Refund guards (reuse residue where possible)");
  try {
    // ---- Reused residue first: NM-100036 (unpaid FIN-3-a checkout, ZERO
    // refunds) → complete the payment via /simulate, then refund it fully. If a
    // previous run already consumed it, fall back to a fresh checkout for the
    // same seller (lumina-living) and say so.
    let grp = await db.paymentGroup.findFirst({
      where: { orders: { some: { orderNumber: "NM-100036" } } },
      include: { orders: { select: { id: true, orderNumber: true, status: true, totalMinor: true, storeId: true } } },
    });
    let order = grp?.orders[0];
    const reused = !!(grp && order && order.status === "payment_pending" && (await db.refund.count({ where: { orderId: order.id } })) === 0);
    if (reused && grp) {
      console.log(`  reused residue: ${order!.orderNumber} (was ${order!.status}) via ref=${grp.ref}`);
    } else {
      const luminaVariant = await db.productVariant.findFirst({
        where: { product: { store: { slug: "lumina-living" }, status: "active" }, stock: { gt: 0 } },
        select: { id: true },
      });
      if (!luminaVariant) throw new Error("no buyable lumina-living variant");
      const cookie0 = await loginShopper();
      const ref0 = await createCheckout(cookie0, luminaVariant.id);
      grp = await db.paymentGroup.findUnique({ where: { ref: ref0 }, include: { orders: { select: { id: true, orderNumber: true, status: true, totalMinor: true, storeId: true } } } });
      order = grp?.orders[0];
      if (!grp || !order) throw new Error("fresh checkout for refund happy path failed");
      console.log(`  NM-100036 residue not reusable this run — created fresh checkout ${order.orderNumber} via ref=${grp.ref}`);
    }
    if (!grp || !order) throw new Error("refund happy-path order unavailable");
    const pay = await simulate(grp.ref);
    check("C1 order paid via /simulate", pay.status === 200, `status=${pay.status} order=${order!.orderNumber}`);

    const sellerToken = await login("seller", "lumina@nomofee.io", "Seller123!");
    const rr = await api("POST", `/api/store/orders/${order.orderNumber}/refund-request`, {
      token: sellerToken,
      body: { amountMinor: order.totalMinor, reason: "FIN-4 gate: full refund happy path" },
    });
    const refund = (rr.json.data as { id?: string } | undefined)?.id;
    check("C2 seller refund-request (full amount) 201", (rr.status === 200 || rr.status === 201) && !!refund, `status=${rr.status} refund=${refund ?? "?"}`);
    if (!refund) throw new Error("refund request failed");

    const ap1 = await api("POST", `/api/admin/refunds/${refund}/approve`, { token: adminToken });
    const ap2 = await api("POST", `/api/admin/refunds/${refund}/approve`, { token: adminToken });
    check("C3 approve 200 + replay approve 409", ap1.status === 200 && ap2.status === 409, `statuses=${ap1.status}/${ap2.status} code=${errCode(ap2.json)}`);

    const pr = await api("POST", `/api/admin/refunds/${refund}/process`, { token: adminToken });
    check("C4 process 200 (T5 posted)", pr.status === 200, `status=${pr.status} code=${errCode(pr.json)} ${errMsg(pr.json).slice(0, 80)}`);
    const t5 = await dedupCount(`refund:refund:${refund}`);
    check("C5 T5 (refund) exactly once", t5 === 1, `dedupKey count=${t5}`);

    // Second refund beyond what remains — the request-time cap must refuse.
    const rr2 = await api("POST", `/api/store/orders/${order.orderNumber}/refund-request`, {
      token: sellerToken,
      body: { amountMinor: order.totalMinor, reason: "FIN-4 gate: over-refund attempt" },
    });
    check("C6 second refund-request blocked 409", rr2.status === 409, `status=${rr2.status} code=${errCode(rr2.json)}`);

    // Reused residue: NM-100037 (partially_refunded, 3300/6600 already
    // refunded) — a further request must be refused 409 with no new row (this
    // hits the refundable-STATUS guard: partially_refunded is not refundable).
    const o37 = await db.order.findFirst({
      where: { orderNumber: "NM-100037" },
      select: { id: true, totalMinor: true, refunds: { select: { id: true } } },
    });
    if (o37) {
      const beforeRows = o37.refunds.length;
      const rr3 = await api("POST", "/api/store/orders/NM-100037/refund-request", {
        token: sellerToken,
        body: { amountMinor: o37.totalMinor, reason: "FIN-4 gate: over-cap attempt on partially refunded order" },
      });
      const afterRows = await db.refund.count({ where: { orderId: o37.id } });
      check("C7 further refund-request on partially_refunded NM-100037 → 409 (status guard), no new row", rr3.status === 409 && afterRows === beforeRows, `status=${rr3.status} code=${errCode(rr3.json)} rows ${beforeRows}→${afterRows}`);
    }

    // Baseline AFTER the first (legitimate) process — the replay must move nothing.
    const tBase = await txnCount();
    const lBase = await lineCount();

    const pr2 = await api("POST", `/api/admin/refunds/${refund}/process`, { token: adminToken });
    const t1 = await txnCount();
    const l1 = await lineCount();
    check("C8 process replay → 409, ledger byte-identical", pr2.status === 409 && t1 === tBase && l1 === lBase, `status=${pr2.status} code=${errCode(pr2.json)} txns ${tBase}→${t1}, lines ${lBase}→${l1}`);

    // ---- Insufficient wallet: zero-available seller (byte@nomofee.io) — fresh
    // order (no reusable residue exists for this seller) → full refund request →
    // approve → process must 409 INSUFFICIENT_WALLET with NO T5 and no status flip.
    //
    // PHASE 2 / F2: the zero-balance precondition is now made DETERMINISTIC.
    // Previous runs minted paid bytebazaar orders whose seller credits
    // accumulated in the wallet, so the hardcoded "seed leaves it at 0"
    // assumption drifted (observed: available=92802 → C10/C11/C12 failed on
    // precondition, not on guards). Now: after the fresh order is paid, ANY
    // residual available balance is reserved via an audited payout
    // (request + admin approve moves available → reserved), leaving available=0
    // for the probe; afterwards the payout is FAILED (T4f) to release the
    // reservation back — the wallet ends where it started, every movement
    // balanced and audited.
    const byteSeller = await db.seller.findUnique({ where: { email: "byte@nomofee.io" }, select: { id: true } });
    const byteWallet0 = byteSeller ? await db.wallet.findUnique({ where: { sellerId: byteSeller.id } }) : null;
    if (!byteSeller || !byteWallet0) throw new Error("byte seller/wallet not found");
    const variant = await db.productVariant.findFirst({
      where: { product: { store: { slug: "bytebazaar" }, status: "active" }, stock: { gt: 0 } },
      select: { id: true },
    });
    if (!variant) throw new Error("no buyable bytebazaar variant");
    const cookie = await loginShopper();
    const ref2 = await createCheckout(cookie, variant.id);
    const pay2 = await simulate(ref2);
    const g2 = await db.paymentGroup.findUnique({ where: { ref: ref2 }, include: { orders: { select: { id: true, orderNumber: true, status: true, totalMinor: true } } } });
    check("C9 fresh zero-balance-seller order paid", pay2.status === 200 && !!g2 && g2.orders.every((o) => o.status === "paid"), `ref=${ref2} orders=${g2?.orders.map((o) => o.status).join(",")}`);
    const o2 = g2!.orders[0];

    const byteToken = await login("seller", "byte@nomofee.io", "Seller123!");

    // Deterministic drain: reserve the ENTIRE post-payment available balance.
    const payoutMinRow = await db.setting.findUnique({ where: { key: "payout.min_minor" } });
    const payoutMin = Number((payoutMinRow ? JSON.parse(payoutMinRow.valueJson) : 0) ?? 0) || 0;
    const byteWalletNow = (await db.wallet.findUnique({ where: { sellerId: byteSeller.id } }))!;
    let drainPayoutId: string | null = null;
    if (byteWalletNow.availableMinor > 0 && byteWalletNow.availableMinor >= payoutMin) {
      const drainReq = await api("POST", "/api/store/payouts", {
        token: byteToken,
        body: { amountMinor: byteWalletNow.availableMinor, note: "FIN-4 gate: deterministic wallet drain for the insufficient-wallet probe (reserved in full; released via T4f after the probe)" },
      });
      const drainPayout = (drainReq.json.data as { payout?: { id: string; referenceNo: string } } | undefined)?.payout;
      const drainApprove = drainPayout ? await api("POST", `/api/admin/payouts/${drainPayout.id}/approve`, { token: adminToken }) : null;
      if (drainPayout && drainApprove?.status === 200) {
        drainPayoutId = drainPayout.id;
        console.log(`  drain: reserved ${byteWalletNow.availableMinor} minor via payout ${drainPayout.referenceNo} (approve 200) — available is now 0`);
      } else {
        console.log(`  note: wallet drain skipped (request=${drainReq.status} approve=${drainApprove?.status ?? "-"}) — relying on available < refund debit`);
      }
    } else if (byteWalletNow.availableMinor > 0) {
      console.log(`  note: byte wallet available=${byteWalletNow.availableMinor} < payout minimum ${payoutMin} — no drain possible; probe relies on available < refund debit`);
    }

    const rr4 = await api("POST", `/api/store/orders/${o2.orderNumber}/refund-request`, {
      token: byteToken,
      body: { amountMinor: o2.totalMinor, reason: "FIN-4 gate: insufficient-wallet path" },
    });
    const refund2 = (rr4.json.data as { id?: string } | undefined)?.id;
    if (!refund2) throw new Error(`refund request 2 failed: ${rr4.status} ${errMsg(rr4.json)}`);
    const ap3 = await api("POST", `/api/admin/refunds/${refund2}/approve`, { token: adminToken });
    const pr3 = await api("POST", `/api/admin/refunds/${refund2}/process`, { token: adminToken });
    const noT5 = (await dedupCount(`refund:refund:${refund2}`)) === 0;
    const stillApproved = (await db.refund.findUnique({ where: { id: refund2 }, select: { status: true } }))?.status;
    check(
      "C10 process with empty wallet → 409 INSUFFICIENT_WALLET",
      ap3.status === 200 && pr3.status === 409 && errCode(pr3.json) === "INSUFFICIENT_WALLET",
      `approve=${ap3.status} process=${pr3.status} code=${errCode(pr3.json)} msg="${errMsg(pr3.json).slice(0, 90)}"`
    );
    check("C11 no T5 posted, refund status unchanged (approved)", noT5 && stillApproved === "approved", `T5count=0:${noT5} status=${stillApproved}`);

    // True cumulative-AMOUNT cap: this order is still "paid" with an approved
    // (unprocessed) refund outstanding — alreadyRequested covers the whole
    // total, so ANY further request must hit 409 INVALID_AMOUNT (not the status
    // guard) with no new refund row. Reuses the order this section just paid.
    const beforeRows2 = await db.refund.count({ where: { orderId: o2.id } });
    const rr5 = await api("POST", `/api/store/orders/${o2.orderNumber}/refund-request`, {
      token: byteToken,
      body: { amountMinor: o2.totalMinor, reason: "FIN-4 gate: cumulative amount-cap attempt" },
    });
    const afterRows2 = await db.refund.count({ where: { orderId: o2.id } });
    check(
      "C12 cumulative amount-cap → 409 INVALID_AMOUNT, no new refund row",
      rr5.status === 409 && errCode(rr5.json) === "INVALID_AMOUNT" && afterRows2 === beforeRows2,
      `status=${rr5.status} code=${errCode(rr5.json)} rows ${beforeRows2}→${afterRows2}`
    );

    // PHASE 2 / F2 cleanup: release the deterministic drain's reservation back
    // to available via the audited T4f path (admin mark-failed) so the wallet
    // ends where it started and the NEXT run's precondition is reproducible.
    if (drainPayoutId) {
      const fail = await api("POST", `/api/admin/payouts/${drainPayoutId}/fail`, { token: adminToken, body: { reason: "FIN-4 gate: release deterministic drain reservation (T4f) — probe complete" } });
      const released = (await db.wallet.findUnique({ where: { sellerId: byteSeller.id } }))?.availableMinor;
      console.log(`  drain release: fail=${fail.status} → available=${released} (T4f audited)`);
    }
  } catch (e) {
    check("C section completed", false, String(e));
  }
}

// ===========================================================================
// SECTION D — Reconciliation (sync truthful; sweep idempotent)
// ===========================================================================
async function sectionD(adminToken: string, payoutId: string | null): Promise<void> {
  section("D — Reconciliation (sync + idempotent sweep)");
  try {
    if (payoutId) {
      const sync = await api("POST", `/api/admin/payouts/${payoutId}/sync`, { token: adminToken });
      const s = (sync.json.data ?? {}) as { expectedTxns?: { T3?: boolean; T4?: boolean }; cacheMatches?: boolean; status?: string };
      check(
        "D1 payout sync truthful (T3:true, T4:true, cacheMatches:true)",
        sync.status === 200 && s.expectedTxns?.T3 === true && s.expectedTxns?.T4 === true && s.cacheMatches === true,
        `status=${sync.status} expectedTxns=${JSON.stringify(s.expectedTxns)} cacheMatches=${String(s.cacheMatches)} payoutStatus=${s.status}`
      );
    } else {
      check("D1 payout sync (skipped — Section B failed)", false, "no paid payout id");
    }

    type Sweep = { status: number; json: Json };
    const sweep = (): Promise<Sweep> => api("POST", "/api/admin/payouts/sweep", { token: adminToken });
    const stuckIds = (r: Sweep) => ((r.json.data as { stuck?: Array<{ payoutId: string; alerted?: boolean }> } | undefined)?.stuck ?? []);
    const invOk = (r: Sweep) => ((r.json.data as { invariants?: { ok?: boolean } } | undefined)?.invariants?.ok === true);

    const s1 = await sweep();
    const inv1 = invOk(s1);
    const ids1 = new Set(stuckIds(s1).map((x) => x.payoutId));
    const new1 = stuckIds(s1).filter((x) => x.alerted).length;
    check("D2 sweep run 1 invariants PASS", s1.status === 200 && inv1, `status=${s1.status} stuckScanned=${ids1.size} newlyAlerted=${new1}`);

    const s2 = await sweep();
    const ids2 = stuckIds(s2).map((x) => x.payoutId);
    const new2 = stuckIds(s2).filter((x) => x.alerted).length;
    const subset = ids2.every((id) => ids1.has(id));
    check("D3 sweep run 2 idempotent (no NEW stuck alerts, invariants PASS)", s2.status === 200 && invOk(s2) && new2 === 0 && subset, `newlyAlerted=${new2} stuckSubset=${subset} invOk=${String(invOk(s2))}`);
  } catch (e) {
    check("D section completed", false, String(e));
  }
}

// ===========================================================================
// SECTION E — Rate limiting (429 under burst)
// ===========================================================================
async function sectionE(ref: string | null): Promise<void> {
  section("E — Rate limiting (12-burst on /simulate)");
  try {
    if (!ref) throw new Error("no checkout ref from Section A");
    let count429 = 0;
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await simulate(ref);
      statuses.push(r.status);
      if (r.status === 429) count429++;
    }
    check("E1 burst of 12 /simulate → at least one 429", count429 >= 1, `statuses=${statuses.join(",")} → ${count429}× 429`);
  } catch (e) {
    check("E section completed", false, String(e));
  }
}

// ===========================================================================
// SECTION F — Invariants (verify-ledger + finance-preflight gates)
// ===========================================================================
async function sectionF(): Promise<void> {
  section("F — Invariants (spawn verify-ledger + finance-preflight)");
  try {
    const run = (script: string) => {
      const p = Bun.spawnSync({ cmd: ["bun", script], cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
      return { code: p.exitCode, out: `${p.stdout.toString()}${p.stderr.toString()}`.trim().split("\n") };
    };
    const ledger = run("scripts/verify-ledger.ts");
    console.log(`  verify-ledger exit=${ledger.code} | ${ledger.out.slice(-2).join(" | ")}`);
    check("F1 verify-ledger gate PASS", ledger.code === 0, `exit=${ledger.code}`);

    const pre = run("scripts/finance-preflight.ts");
    console.log(`  finance-preflight exit=${pre.code} | ${pre.out.slice(-2).join(" | ")}`);
    check("F2 finance-preflight gate PASS", pre.code === 0, `exit=${pre.code}`);
  } catch (e) {
    check("F section completed", false, String(e));
  }
}

// ===========================================================================
console.log(`FIN-4 VERIFICATION GATE — ${new Date().toISOString()} (run ${RUN})`);
const adminToken = await login("admin", "admin@nomofee.io", "Admin123!");
console.log("admin session OK (superadmin)");

const a = await sectionA();
const b = await sectionB();
await sectionC(adminToken);
await sectionD(adminToken, b?.payoutId ?? null);
await sectionE(a?.ref ?? null);
await sectionF();

const txns = await txnCount();
const lines = await lineCount();
console.log(`\nledger after run: ${txns} txns / ${lines} lines (all movements above are balanced, real-API residue)`);
console.log(failures === 0 ? "FIN-4-GATE: ALL PASS" : `FIN-4-GATE: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
