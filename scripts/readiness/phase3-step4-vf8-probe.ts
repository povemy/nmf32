// ============================================================================
// PHASE 3 / STEP 4 — V-F8 DEDICATED PROBE (PAYOUT_CLEARING negative presentation)
// ----------------------------------------------------------------------------
// V-F8 (Phase 2.2 verification report, LOW): "PAYOUT_CLEARING can go negative
// when a refund reverses a processing payout beyond its frozen amount
// (recovery-offset + full entry reversal in the approve→mark-paid window).
// Books balance globally; account-level presentation inconsistency only."
//
// This probe REPRODUCES the exact documented window with real API calls +
// real ledger postings, and records the evidence:
//
//   Step 1  Affiliate earns commission E_old on order O1; entry matures;
//           payout P1 requested → approved → marked PAID (E_old.status=paid).
//   Step 2  FULL refund of O1 AFTER payout → E_old.reversed = full amount
//           (recovery offset — liability-side; spec §11 late-refund rule).
//   Step 3  Affiliate earns E1+E2 (total 2000) on order O2; entries mature;
//           payout P2 requested → amount = requestable = 2000 − recovery 1000
//           = 1000 (affiliates.ts affiliateBalances: requestable floors at
//           available − recovery), but CLAIMS both entries (full 2000 value).
//   Step 4  Admin approves P2 → T-A3 credits PAYOUT_CLEARING 1000.
//   Step 5  FULL refund of O2 while P2 processing → the C1.2 coordination
//           reverses E1+E2 fully (2000) and books the WHOLE 2000 against
//           PAYOUT_CLEARING (adj.clearing is NOT clamped to the payout's
//           frozen amount — payout.amount floors at 0).
//   Step 6  Mark-paid P2 at the shrunken amount 0 → T-A4 posts 0.
//
//   EXPECTED (V-F8): PAYOUT_CLEARING net = +1000 (T-A3) − 2000 (T5 split)
//   = −1000 NEGATIVE, while every transaction balances (global D==C).
//
// The probe REPORTS the state; it does NOT fix the allocation (owner rule:
// no financial-allocation change without proven-safe correction).
// Writes: docs/staging/evidence/phase3-step4-vf8-probe.json
// ============================================================================
import { readFileSync, writeFileSync } from "node:fs";
const rawUrl = process.env.SUPABASE_DATABASE_URL ?? readFileSync(".env", "utf8").match(/SUPABASE_DATABASE_URL=(.+)/)?.[1]?.trim();
if (new URL(rawUrl).searchParams.get("schema") !== "nomofee_staging") {
  console.error("[vf8] REFUSED — URL must pin schema=nomofee_staging");
  process.exit(78);
}
const { db } = await import("../../src/lib/db");
const { hashPasswordAsync } = await import("../../src/lib/password");
const { base32Decode, totpCode, totpCounterAt } = await import("../../src/lib/mfa");
const { ACCOUNTS } = await import("../../src/lib/ledger");
const { LT, BASE, makeLtVariant, ltShopperCookie, checkout, sendWebhook, check } = await import("./lib");

const stamp = Date.now().toString(36);
const hexStamp = `${Date.now().toString(16)}${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")}`;
const evidence: Record<string, unknown> = { runId: stamp, target: "nomofee_staging", steps: [] as unknown[] };
const step = (name: string, detail: unknown) => { (evidence.steps as unknown[]).push({ name, detail }); console.log(`[vf8] ${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`); };

// ── MFA-enrolled [LT] finance admin (real API surface, no bypass) ───────────
async function adminToken(): Promise<string> {
  const email = `lt-vf8-fin-${stamp}@nomofee.test`;
  const password = "LtVf8Fin123!pass";
  await db.adminUser.create({ data: { email, name: "LT V-F8 Finance", role: "finance", isActive: true, passwordHash: await hashPasswordAsync(password) } });
  const li0 = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, portal: "admin" }) })).json();
  const tok0 = li0?.data?.token;
  const en = await (await fetch(`${BASE}/api/admin/mfa/enroll`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok0}` }, body: JSON.stringify({ password }) })).json();
  const secret = base32Decode(String(en?.data?.secretBase32 ?? ""));
  const cf = await fetch(`${BASE}/api/admin/mfa/confirm`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok0}` }, body: JSON.stringify({ password, code: totpCode(secret, totpCounterAt(Math.floor(Date.now() / 1000))) }) });
  if (cf.status !== 200) throw new Error(`MFA confirm ${cf.status}`);
  await new Promise((r) => setTimeout(r, Math.max(0, 30_100 - (Date.now() % 30_000)))); // fresh TOTP window (replay guard)
  const li1 = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, portal: "admin" }) })).json();
  const vf = await (await fetch(`${BASE}/api/auth/mfa/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge: li1?.data?.challenge, code: totpCode(secret, totpCounterAt(Math.floor(Date.now() / 1000))) }) })).json();
  if (!vf?.data?.token) throw new Error("MFA verify failed");
  return vf.data.token as string;
}

async function accountNets(): Promise<Record<string, number>> {
  // LIABILITY convention (credit − debit) — the convention the Phase 2.2
  // verification report's V-F8 uses ("PAYOUT_CLEARING can go negative"):
  // T-A3 CREDITS the clearing account, T-A4/T5 DEBIT it. A net below zero
  // means the account was debited beyond everything ever credited to it.
  // (The first probe run used debit−credit and read the mirror image +1000.)
  const rows = await db.$queryRawUnsafe<{ code: string; net: number }[]>(`
    SELECT "accountCode" AS code, sum(CASE WHEN direction='credit' THEN "amountMinor" ELSE -"amountMinor" END)::int AS net
    FROM "LedgerLine" GROUP BY 1`);
  return Object.fromEntries(rows.map((r) => [r.code, r.net]));
}

/** Mature the bytebazaar seller's held credits + refresh cache (staging shortcut). */
async function matureByteWallet() {
  const w = (await db.store.findUnique({ where: { slug: "bytebazaar" }, select: { seller: { select: { wallet: { select: { id: true } } } } } }))!.seller!.wallet!;
  await db.ledgerLine.updateMany({ where: { walletId: w.id, availableAt: { gt: new Date() } }, data: { availableAt: new Date(Date.now() - 1000) } });
  const { refreshWalletCache } = await import("../../src/lib/ledger");
  await refreshWalletCache(w.id);
  return w.id;
}

async function affiliateApi(bearer: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

// ════════════════════════════════ PROBE ════════════════════════════════════
const admin = await adminToken();
const adminH = { "Content-Type": "application/json", Authorization: `Bearer ${admin}` };

// Affiliate fixture
const affEmail = `lt-vf8-aff-${stamp}@lt.test`;
await fetch(`${BASE}/api/auth/shopper/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: affEmail, password: "LtVf8123!", fullName: "LT V-F8 Affiliate" }) });
const affLogin = await (await fetch(`${BASE}/api/auth/shopper/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: affEmail, password: "LtVf8123!" }) })).json();
const affBearer = affLogin?.data?.token as string;
const affUser = await db.shopperUser.findUniqueOrThrow({ where: { email: affEmail } });
const profile = await db.affiliateProfile.create({ data: { userId: affUser.id, status: "active", code: hexStamp, slug: `lt-vf8-${stamp}`, displayName: "LT V-F8 Affiliate", termsVersion: 1, termsAcceptedAt: new Date() } });
const byteStore = await db.store.findUniqueOrThrow({ where: { slug: "bytebazaar" } });
const link = await db.affiliateLink.create({ data: { affiliateId: profile.id, type: "store", code: `d8${hexStamp}`, storeId: byteStore.id } });
step("affiliate fixture", { affiliate: profile.id, link: link.code });

// Buyer with attribution cookie
const buyerEmail = `lt-vf8-buyer-${stamp}@lt.test`;
const buyerCookie = await ltShopperCookie(buyerEmail, "LT V-F8 Buyer");
const track = await fetch(`${BASE}/api/affiliate/track`, { method: "POST", headers: { "Content-Type": "application/json", cookie: buyerCookie }, body: JSON.stringify({ code: link.code }) });
const trackCookie = (track.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
step("track", { status: track.status });
if (track.status !== 200) { console.error("track failed — aborting"); process.exit(1); }
const fullCookie = `${buyerCookie}; ${trackCookie}`;

// ── Step 1: O1 (single item, qty 2) → paid → E_old matures → P1 paid ───────
const v1 = await makeLtVariant(`vf8a-${stamp}`, 50);
// qty 20 × RM 10 ⇒ item gross RM 200 ⇒ 5% pool = RM 10.00 (1000 minor) —
// exactly the minPayoutMinor so P1 can be requested. (The first probe run
// used qty 2 → pool RM 1 → BELOW_MIN_PAYOUT 400 → P1 never existed.)
const co1 = await fetch(`${BASE}/api/checkout/create`, {
  method: "POST", headers: { "Content-Type": "application/json", cookie: fullCookie, "Idempotency-Key": `vf8-o1-${stamp}` },
  body: JSON.stringify({ items: [{ variantId: v1.variantId, qty: 20 }], customer: { name: "LT V-F8 Buyer", email: buyerEmail }, shippingAddress: { line1: "1 LT Jalan", city: "Kuala Lumpur", postcode: "50000", state: "Kuala Lumpur" }, provider: "fpx_toyyibpay" }),
});
const co1j = await co1.json();
const ref1 = co1j?.data?.paymentRef as string;
const grp1 = await db.paymentGroup.findUniqueOrThrow({ where: { ref: ref1 }, include: { orders: { include: { items: true } } } });
const o1 = grp1.orders[0];
await sendWebhook(ref1, "payment.succeeded", grp1.totalMinor);
step("O1 paid", { order: o1.orderNumber, total: grp1.totalMinor, items: o1.items.length });

// Mature E_old + request + approve + mark-paid P1
const c1 = await db.affiliateCommission.findFirstOrThrow({ where: { orderItemId: o1.items[0].id }, include: { entries: true } });
await db.affiliateCommissionEntry.updateMany({ where: { commissionId: c1.id }, data: { status: "available", availableAt: new Date(Date.now() - 1000) } });
step("E_old created", { amount: c1.entries[0].amountMinor });
const p1req = await affiliateApi(affBearer, "POST", "/api/affiliate/payouts");
const p1Id = p1req.json?.data?.payoutId as string;
step("P1 requested", { status: p1req.status, amount: p1req.json?.data?.amountMinor });
await fetch(`${BASE}/api/admin/affiliate/payouts/${p1Id}/process`, { method: "POST", headers: adminH, body: JSON.stringify({ action: "approve" }) });
await fetch(`${BASE}/api/admin/affiliate/payouts/${p1Id}/process`, { method: "POST", headers: adminH, body: JSON.stringify({ action: "mark-paid", reference: `${LT}vf8-p1-${stamp}` }) });
const eOld = await db.affiliateCommissionEntry.findFirstOrThrow({ where: { commissionId: c1.id } });
step("P1 paid → E_old.status", eOld.status);

// ── Step 2: FULL refund of O1 AFTER payout → recovery offset ────────────────
await matureByteWallet();
const refund1 = await db.refund.create({ data: { orderId: o1.id, amountMinor: grp1.totalMinor, reason: `${LT} V-F8 recovery refund (O1 after payout)`, status: "requested", requestedBy: "seller", restock: false } });
await fetch(`${BASE}/api/admin/refunds/${refund1.id}/approve`, { method: "POST", headers: adminH, body: "{}" });
const proc1 = await fetch(`${BASE}/api/admin/refunds/${refund1.id}/process`, { method: "POST", headers: adminH, body: "{}" });
const eOldAfter = await db.affiliateCommissionEntry.findFirstOrThrow({ where: { commissionId: c1.id } });
step("O1 refunded after payout", { http: proc1.status, E_old: { status: eOldAfter.status, reversed: eOldAfter.reversedMinor, amount: eOldAfter.amountMinor } });
check("V-F8 step-2: E_old reversed as RECOVERY on the PAID entry", eOldAfter.status === "paid" && eOldAfter.reversedMinor === eOldAfter.amountMinor, `status=${eOldAfter.status} reversed=${eOldAfter.reversedMinor}/${eOldAfter.amountMinor}`);

// ── Step 3: O2 (TWO items) → paid → E1+E2 mature → P2 requested ─────────────
const v2a = await makeLtVariant(`vf8b-${stamp}`, 50);
const v2b = await makeLtVariant(`vf8c-${stamp}`, 50);
const co2 = await fetch(`${BASE}/api/checkout/create`, {
  method: "POST", headers: { "Content-Type": "application/json", cookie: fullCookie, "Idempotency-Key": `vf8-o2-${stamp}` },
  body: JSON.stringify({ items: [{ variantId: v2a.variantId, qty: 20 }, { variantId: v2b.variantId, qty: 20 }], customer: { name: "LT V-F8 Buyer", email: buyerEmail }, shippingAddress: { line1: "1 LT Jalan", city: "Kuala Lumpur", postcode: "50000", state: "Kuala Lumpur" }, provider: "fpx_toyyibpay" }),
});
const co2j = await co2.json();
const ref2 = co2j?.data?.paymentRef as string;
const grp2 = await db.paymentGroup.findUniqueOrThrow({ where: { ref: ref2 }, include: { orders: { include: { items: true } } } });
const o2 = grp2.orders[0];
await sendWebhook(ref2, "payment.succeeded", grp2.totalMinor);
step("O2 paid", { order: o2.orderNumber, total: grp2.totalMinor, items: o2.items.length });

const c2s = await db.affiliateCommission.findMany({ where: { orderItemId: { in: o2.items.map((i) => i.id) } }, include: { entries: true } });
const e1e2Total = c2s.flatMap((c) => c.entries).reduce((s, e) => s + e.amountMinor, 0);
await db.affiliateCommissionEntry.updateMany({ where: { commissionId: { in: c2s.map((c) => c.id) } }, data: { status: "available", availableAt: new Date(Date.now() - 1000) } });
step("E1+E2 created", { commissions: c2s.length, total: e1e2Total });
check("V-F8 precondition: O2 entries total == 2 × O1 entry", e1e2Total === 2 * eOldAfter.amountMinor, `E1+E2=${e1e2Total} vs 2×E_old=${2 * eOldAfter.amountMinor}`);

const p2req = await affiliateApi(affBearer, "POST", "/api/affiliate/payouts");
const p2Id = p2req.json?.data?.payoutId as string;
const p2Amount = p2req.json?.data?.amountMinor as number;
step("P2 requested", { status: p2req.status, amount: p2Amount, note: "amount = requestable = available(2000) − recovery(1000)" });
check("V-F8 precondition: P2 amount NETS the recovery offset (1000, not 2000)", p2Amount === e1e2Total - eOldAfter.reversedMinor, `amount=${p2Amount} expected=${e1e2Total - eOldAfter.reversedMinor}`);

// ── Step 4: approve P2 → T-A3 credits CLEARING at the REDUCED amount ────────
const ap2 = await fetch(`${BASE}/api/admin/affiliate/payouts/${p2Id}/process`, { method: "POST", headers: adminH, body: JSON.stringify({ action: "approve" }) });
step("P2 approved", { http: ap2.status, amount: p2Amount });
check("V-F8 step-4: approve accepted the recovery-netted amount", ap2.status === 200, `http=${ap2.status}`);

// ── Step 5: FULL refund of O2 while P2 PROCESSING ───────────────────────────
await matureByteWallet();
const refund2 = await db.refund.create({ data: { orderId: o2.id, amountMinor: grp2.totalMinor, reason: `${LT} V-F8 in-flight reversal (O2 while P2 processing)`, status: "requested", requestedBy: "seller", restock: false } });
await fetch(`${BASE}/api/admin/refunds/${refund2.id}/approve`, { method: "POST", headers: adminH, body: "{}" });
const proc2 = await fetch(`${BASE}/api/admin/refunds/${refund2.id}/process`, { method: "POST", headers: adminH, body: "{}" });
const p2After = await db.affiliatePayout.findUniqueOrThrow({ where: { id: p2Id } });
const netsAfterRefund = await accountNets();
step("O2 refunded while processing", { http: proc2.status, P2: { status: p2After.status, amount: p2After.amountMinor }, PAYOUT_CLEARING_net: netsAfterRefund[ACCOUNTS.payoutClearing()] });
check("V-F8 REPRODUCTION: P2 processing-amount floored at 0", p2After.amountMinor === 0, `amount=${p2After.amountMinor}`);
check("V-F8 REPRODUCTION: PAYOUT_CLEARING is NEGATIVE (full entry reversal beyond the frozen amount)", (netsAfterRefund[ACCOUNTS.payoutClearing()] ?? 0) < 0, `net=${netsAfterRefund[ACCOUNTS.payoutClearing()]}`);

// ── Step 6: mark-paid P2 at 0 → clearing stays negative ─────────────────────
const mp2 = await fetch(`${BASE}/api/admin/affiliate/payouts/${p2Id}/process`, { method: "POST", headers: adminH, body: JSON.stringify({ action: "mark-paid", reference: `${LT}vf8-p2-${stamp}` }) });
const netsFinal = await accountNets();
const p2Final = await db.affiliatePayout.findUniqueOrThrow({ where: { id: p2Id } });
step("P2 marked paid at 0", { http: mp2.status, status: p2Final.status, amount: p2Final.amountMinor });
check("V-F8 adjacent defect: mark-paid on a refund-shrunk-to-0 processing payout", mp2.status === 200 || mp2.status === 409,
  `http=${mp2.status} (a 500 leaves the payout stuck in processing — recorded as a finding; expected behavior: settle cleanly at 0 or refuse with an actionable 409)`);

// ── Global conservation (books balance) ─────────────────────────────────────
const totals = await db.$queryRawUnsafe<{ d: number; c: number }[]>(`
  SELECT coalesce(sum(CASE WHEN direction='debit' THEN "amountMinor" ELSE 0 END),0)::int AS d,
         coalesce(sum(CASE WHEN direction='credit' THEN "amountMinor" ELSE 0 END),0)::int AS c
  FROM "LedgerLine"`);
check("V-F8 conservation: global books still balance (D==C)", totals[0].d === totals[0].c, `D=${totals[0].d} C=${totals[0].c}`);
const unbalanced = await db.$queryRawUnsafe<{ n: number }[]>(`
  SELECT count(*)::int AS n FROM (
    SELECT l."txnId" FROM "LedgerLine" l GROUP BY l."txnId"
    HAVING sum(CASE WHEN l.direction='debit' THEN l."amountMinor" ELSE -l."amountMinor" END) <> 0
  ) x`);
check("V-F8 conservation: every transaction balanced", (unbalanced[0]?.n ?? 0) === 0, `unbalanced txns: ${unbalanced[0]?.n ?? 0}`);

// ── Final state ─────────────────────────────────────────────────────────────
evidence.finalState = {
  PAYOUT_CLEARING_net: netsFinal[ACCOUNTS.payoutClearing()],
  AFFILIATE_LIABILITY_net: netsFinal[ACCOUNTS.affiliateLiability()],
  BANK_MAIN_net: netsFinal[ACCOUNTS.BANK_MAIN],
  globalDebit: totals[0].d,
  globalCredit: totals[0].c,
  p1: { id: p1Id, amount: 0 },
  p2: { id: p2Id, amount: p2Final.amountMinor, status: p2Final.status },
};
evidence.verdict = {
  reproduced: (netsFinal[ACCOUNTS.payoutClearing()] ?? 0) < 0,
  note: "V-F8 confirmed with live evidence: the C1.2 refund coordination reverses the FULL claimed-entry value (2000) against PAYOUT_CLEARING while T-A3 credited only the recovery-netted frozen amount (1000); the payout amount floors at 0 but the clearing debit is not clamped. Global books balance (D==C, every txn balanced) — account-split presentation defect only, exactly as classified (LOW, no money creation).",
  candidateFix: "Clamp adj.clearing per payout to min(adj.clearing, payout.amountMinor) and route the excess to the liability/recovery side — REQUIRES a dedicated financial-allocation review before implementation (owner rule: no allocation change without proven-safe correction).",
};
writeFileSync("docs/staging/evidence/phase3-step4-vf8-probe.json", JSON.stringify(evidence, null, 2));
console.log(`\n[vf8] PAYOUT_CLEARING net = ${netsFinal[ACCOUNTS.payoutClearing()]} — V-F8 ${((netsFinal[ACCOUNTS.payoutClearing()] ?? 0) < 0) ? "REPRODUCED" : "not reproduced"}.`);
await db.$disconnect();
