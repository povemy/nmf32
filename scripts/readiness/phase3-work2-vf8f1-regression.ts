// ============================================================================
// PHASE 3 / WORK 2 — V-F8 / F-1 CORRECTION REGRESSION SUITE
// (affiliate payout × refund accounting — 12 lifecycle scenarios + invariants)
// ----------------------------------------------------------------------------
// Validates docs/finance/vf8-f1-correction-design.md against the REAL staging
// app + database (mock PSP track). Every scenario uses fresh [LT-W2] fixtures;
// nothing bypasses OTP/auth controls (admin drives the real MFA challenge
// dance; refunds ride the real conditional-claim process route).
//
// Scenarios (work order §D):
//   S1  Refund BEFORE payout request.
//   S2  Refund AFTER request, BEFORE approval.
//   S3  Refund AFTER approval, BEFORE mark-paid (partial, clearing-side).
//   S4  FULL refund reduces a processing payout to ZERO (F-1 core).
//   S5  Partial refunds reducing the payout amount.
//   S6  Multiple refunds against entries linked to ONE payout.
//   S7  CONCURRENT refund + mark-paid.
//   S8  CONCURRENT refund + approval.
//   S9  Repeated payout processing / retry / duplicate-open requests.
//   S10 Late recovery offsets from already-paid commissions (V-F8 core).
//   S11 Payout failure + retry/recovery (full lifecycle).
//   S12 Duplicate refund delivery during the same lifecycle.
//
// Independent DB verification (post-suite, raw SQL):
//   V.a every ledger txn balanced; V.b global D==C; V.c no zero-value txn;
//   V.d PAYOUT_CLEARING run-delta == 0 (every fixture payout terminal &
//       netted; never driven negative by the run); V.e no fixture payout
//       stuck in requested/processing; V.f no entry paid twice / reversed
//       twice (reversedMinor ≤ amountMinor; paid ⇒ payoutId set);
//   V.g wallet caches == ledger truth; V.h terminal postings == payout row
//       amounts (auto-released ⇒ none); V.i BANK_MAIN run-delta == Σ paid.
//
// Writes: docs/staging/evidence/phase3-work2-vf8f1-regression.json
// Run:    LT_BASE=http://127.0.0.1:3100 SUPABASE_DATABASE_URL='<staging pin>' \
//           bun scripts/readiness/phase3-work2-vf8f1-regression.ts
// ============================================================================
import { readFileSync, writeFileSync } from "node:fs";
const rawUrl = process.env.SUPABASE_DATABASE_URL ?? readFileSync(".env", "utf8").match(/SUPABASE_DATABASE_URL=(.+)/)?.[1]?.trim();
if (new URL(rawUrl).searchParams.get("schema") !== "nomofee_staging") {
  console.error("[w2] REFUSED — URL must pin schema=nomofee_staging");
  process.exit(78);
}
const { db } = await import("../../src/lib/db");
const { hashPasswordAsync } = await import("../../src/lib/password");
const { base32Decode, totpCode, totpCounterAt } = await import("../../src/lib/mfa");
const { ACCOUNTS, runLedgerInvariants } = await import("../../src/lib/ledger");
const { LT, BASE, makeLtVariant, ltShopperCookie, sendWebhook, check, summary, exitCode, sleep } = await import("./lib");

const stamp = Date.now().toString(36);
const hexStamp = `${Date.now().toString(16)}${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")}`;
const TAG = `${LT}W2`;
const evidence: Record<string, unknown> = { runId: stamp, target: "nomofee_staging", scenarios: [] as unknown[] };
const scenario = (name: string, detail: unknown) => { (evidence.scenarios as unknown[]).push({ name, detail }); console.log(`\n══ ${name} ══`); };

// ── fetch wrapper: uniform 429 pacing (rate limits are product controls —   ──
// ── waited out, never weakened; mirrors the Step 4 F-7 discipline)          ──
async function pFetch(path: string, init?: RequestInit): Promise<{ status: number; json: any }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${BASE}${path}`, init);
    if (r.status === 429 && attempt < 3) {
      const body = await r.json().catch(() => ({}));
      const waitMs = Number(body?.error?.details?.retryAfterSeconds ?? 0) * 1000;
      console.log(`[pacing] 429 on ${path} — waiting ${waitMs || 61000}ms`);
      await sleep(waitMs || 61_000);
      continue;
    }
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }
  throw new Error(`pFetch exhausted retries: ${path}`);
}

// ── MFA-enrolled [LT-W2] finance admin (real login + TOTP dance) ────────────
async function adminToken(): Promise<string> {
  const email = `lt-w2-fin-${stamp}@nomofee.test`;
  const password = "LtW2Fin123!pass";
  await db.adminUser.create({ data: { email, name: "LT W2 Finance", role: "finance", isActive: true, passwordHash: await hashPasswordAsync(password) } });
  const li0 = (await pFetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, portal: "admin" }) })).json;
  const tok0 = li0?.data?.token;
  const en = (await pFetch("/api/admin/mfa/enroll", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok0}` }, body: JSON.stringify({ password }) })).json;
  const secret = base32Decode(String(en?.data?.secretBase32 ?? ""));
  const cf = await fetch(`${BASE}/api/admin/mfa/confirm`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok0}` }, body: JSON.stringify({ password, code: totpCode(secret, totpCounterAt(Math.floor(Date.now() / 1000))) }) });
  if (cf.status !== 200) throw new Error(`MFA confirm ${cf.status}`);
  await sleep(Math.max(0, 30_100 - (Date.now() % 30_000))); // fresh TOTP window (replay guard)
  const li1 = (await pFetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, portal: "admin" }) })).json;
  const vf = (await pFetch("/api/auth/mfa/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge: li1?.data?.challenge, code: totpCode(secret, totpCounterAt(Math.floor(Date.now() / 1000))) }) })).json;
  if (!vf?.data?.token) throw new Error("MFA verify failed");
  return vf.data.token as string;
}
const admin = await adminToken();
const adminH = { "Content-Type": "application/json", Authorization: `Bearer ${admin}` };

// ── fixture helpers ──────────────────────────────────────────────────────────
const byteStore = await db.store.findUniqueOrThrow({ where: { slug: "bytebazaar" } });
async function byteWalletMature(): Promise<string> {
  const w = (await db.store.findUnique({ where: { slug: "bytebazaar" }, select: { seller: { select: { wallet: { select: { id: true } } } } } }))!.seller!.wallet!;
  await db.ledgerLine.updateMany({ where: { walletId: w.id, availableAt: { gt: new Date() } }, data: { availableAt: new Date(Date.now() - 1000) } });
  const { refreshWalletCache } = await import("../../src/lib/ledger");
  await refreshWalletCache(w.id);
  return w.id;
}
async function newAffiliate(): Promise<{ affiliateId: string; bearer: string; linkCode: string }> {
  const email = `lt-w2-aff-${stamp}-${Math.floor(Math.random() * 1e9).toString(36)}@lt.test`;
  await pFetch("/api/auth/shopper/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "LtW2Aff123!", fullName: "LT W2 Affiliate" }) });
  const li = (await pFetch("/api/auth/shopper/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "LtW2Aff123!" }) })).json;
  const bearer = li?.data?.token as string;
  const u = await db.shopperUser.findUniqueOrThrow({ where: { email } });
  // NOTE: affiliate link codes must satisfy /^[a-f0-9-]{6,32}$/i (hex-only,
  // affiliate-attribution.ts) — the random suffixes below are hex too.
  const profile = await db.affiliateProfile.create({ data: { userId: u.id, status: "active", code: `${hexStamp}${Math.floor(Math.random() * 0xfffff).toString(16)}`, slug: `lt-w2-${stamp}-${Math.floor(Math.random() * 1e9).toString(36)}`, displayName: "LT W2 Affiliate", termsVersion: 1, termsAcceptedAt: new Date() } });
  const link = await db.affiliateLink.create({ data: { affiliateId: profile.id, type: "store", code: `d2${hexStamp}${Math.floor(Math.random() * 0xfffff).toString(16)}`, storeId: byteStore.id } });
  return { affiliateId: profile.id, bearer, linkCode: link.code };
}
async function attributedBuyerCookie(linkCode: string): Promise<string> {
  const buyerEmail = `lt-w2-buy-${stamp}-${Math.floor(Math.random() * 1e9).toString(36)}@lt.test`;
  const buyerCookie = await ltShopperCookie(buyerEmail, "LT W2 Buyer");
  const track = await fetch(`${BASE}/api/affiliate/track`, { method: "POST", headers: { "Content-Type": "application/json", cookie: buyerCookie }, body: JSON.stringify({ code: linkCode }) });
  if (track.status !== 200) throw new Error(`track ${track.status}`);
  const trackCookie = (track.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return `${buyerCookie}; ${trackCookie}`;
}
async function placeOrder(cookie: string, items: { variantId: string; qty: number }[]): Promise<{ orderId: string; orderNumber: string; totalMinor: number }> {
  const idem = `w2-o-${stamp}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const co = await fetch(`${BASE}/api/checkout/create`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie, "Idempotency-Key": idem },
    body: JSON.stringify({ items, customer: { name: "LT W2 Buyer", email: "lt-w2-buyer@lt.test" }, shippingAddress: { line1: "1 LT Jalan", city: "Kuala Lumpur", postcode: "50000", state: "Kuala Lumpur" }, provider: "fpx_toyyibpay" }),
  });
  const coj = await co.json().catch(() => ({}));
  if (co.status !== 201) throw new Error(`checkout ${co.status}: ${JSON.stringify(coj).slice(0, 200)}`);
  const ref = coj?.data?.paymentRef as string;
  const grp = await db.paymentGroup.findUniqueOrThrow({ where: { ref }, include: { orders: { include: { items: true } } } });
  const wh = await sendWebhook(ref, "payment.succeeded", grp.totalMinor);
  if (wh.status !== 200) throw new Error(`webhook ${wh.status}`);
  const order = grp.orders[0];
  return { orderId: order.id, orderNumber: order.orderNumber, totalMinor: grp.totalMinor };
}
async function matureEntries(orderId: string): Promise<{ ids: string[]; totalMinor: number }> {
  const items = await db.orderItem.findMany({ where: { orderId }, select: { id: true } });
  const cs = await db.affiliateCommission.findMany({ where: { orderItemId: { in: items.map((i) => i.id) } }, include: { entries: true } });
  const ids = cs.flatMap((c) => c.entries.map((e) => e.id));
  const totalMinor = cs.flatMap((c) => c.entries).reduce((s, e) => s + e.amountMinor, 0);
  if (ids.length) await db.affiliateCommissionEntry.updateMany({ where: { id: { in: ids } }, data: { status: "available", availableAt: new Date(Date.now() - 1000) } });
  return { ids, totalMinor };
}
async function entryReversal(entryIds: string[]): Promise<number> {
  return (await db.affiliateCommissionEntry.aggregate({ where: { id: { in: entryIds } }, _sum: { reversedMinor: true } }))._sum.reversedMinor ?? 0;
}
async function requestPayout(bearer: string): Promise<{ status: number; payoutId?: string; amountMinor?: number; code?: string }> {
  const r = await pFetch("/api/affiliate/payouts", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` } });
  return { status: r.status, payoutId: r.json?.data?.payoutId, amountMinor: r.json?.data?.amountMinor, code: r.json?.error?.code };
}
async function processPayout(id: string, action: string, extra: Record<string, unknown> = {}): Promise<{ status: number; json: any }> {
  return pFetch(`/api/admin/affiliate/payouts/${id}/process`, { method: "POST", headers: adminH, body: JSON.stringify({ action, ...extra }) });
}
async function refund(orderId: string, amountMinor: number, reason: string): Promise<{ status: number; refundId: string }> {
  await byteWalletMature();
  const row = await db.refund.create({ data: { orderId, amountMinor, reason: `${TAG} ${reason}`, status: "requested", requestedBy: "seller", restock: false } });
  await pFetch(`/api/admin/refunds/${row.id}/approve`, { method: "POST", headers: adminH, body: "{}" });
  const p = await pFetch(`/api/admin/refunds/${row.id}/process`, { method: "POST", headers: adminH, body: "{}" });
  return { status: p.status, refundId: row.id };
}
async function accountNets(): Promise<Record<string, number>> {
  const rows = await db.$queryRawUnsafe<{ code: string; net: number }[]>(`
    SELECT "accountCode" AS code, sum(CASE WHEN direction='credit' THEN "amountMinor" ELSE -"amountMinor" END)::int AS net
    FROM "LedgerLine" GROUP BY 1`);
  return Object.fromEntries(rows.map((r) => [r.code, r.net]));
}
async function payoutTxnAmounts(payoutId: string): Promise<{ a3?: number; a4?: number; a4f?: number }> {
  // $queryRaw (tagged template) parameterizes ${payoutId}; the Unsafe variant
  // interpolates it raw/unquoted, which Postgres parses as a column reference.
  const rows = await db.$queryRaw<{ txnType: string; amt: number }[]>`
    SELECT t."txnType" AS "txnType", sum(l."amountMinor")::int AS amt
    FROM "LedgerTransaction" t JOIN "LedgerLine" l ON l."txnId" = t.id
    WHERE t."refType" = 'affiliate_payout' AND t."refId" = ${payoutId} AND l.direction = 'debit'
    GROUP BY 1`;
  const out: { a3?: number; a4?: number; a4f?: number } = {};
  for (const r of rows) {
    if (r.txnType === "affiliate_payout_initiated") out.a3 = r.amt;
    if (r.txnType === "affiliate_payout_confirmed") out.a4 = r.amt;
    if (r.txnType === "affiliate_payout_failed") out.a4f = r.amt;
  }
  return out;
}

// baseline account nets (run-delta conservation)
const netsStart = await accountNets();
const bankStart = netsStart[ACCOUNTS.BANK_MAIN] ?? 0;
const clearingStart = netsStart[ACCOUNTS.payoutClearing()] ?? 0;
const liabilityStart = netsStart[ACCOUNTS.affiliateLiability()] ?? 0;
const fixturePayoutIds: string[] = [];
const bankPaidTotal = { total: 0 };
console.log(`[w2] baselines — clearing=${clearingStart} liability=${liabilityStart} bank=${bankStart}`);

// ══════════════════════════════ SCENARIOS ══════════════════════════════════

// ── S1: refund BEFORE payout request ────────────────────────────────────────
{
  scenario("S1 — refund before payout request", {});
  const aff = await newAffiliate();
  const cookie = await attributedBuyerCookie(aff.linkCode);
  const v = await makeLtVariant(`w2s1-${stamp}`, 100);
  const o = await placeOrder(cookie, [{ variantId: v.variantId, qty: 20 }]);
  const matured = await matureEntries(o.orderId);
  const full = await refund(o.orderId, o.totalMinor, "S1 full refund pre-request");
  check("S1: refund processed 200", full.status === 200, `http=${full.status}`);
  const entries = await db.affiliateCommissionEntry.findMany({ where: { id: { in: matured.ids } } });
  check("S1: entries fully reversed (status=reversed)", entries.every((e) => e.status === "reversed" && e.reversedMinor === e.amountMinor), JSON.stringify(entries.map((e) => `${e.status}:${e.reversedMinor}/${e.amountMinor}`)));
  const req = await requestPayout(aff.bearer);
  check("S1: payout request refused (nothing requestable)", req.status === 400 && req.code === "BELOW_MIN_PAYOUT", `http=${req.status} code=${req.code}`);
  const nets = await accountNets();
  check("S1: clearing untouched by the un-requested flow", (nets[ACCOUNTS.payoutClearing()] ?? 0) === clearingStart, `clearing=${nets[ACCOUNTS.payoutClearing()]}`);
  scenario("S1", { result: "entries reversed; request refused BELOW_MIN_PAYOUT; clearing untouched" });
}

// ── S2: refund AFTER request, BEFORE approval ───────────────────────────────
{
  scenario("S2 — refund after request, before approval", {});
  const aff = await newAffiliate();
  const cookie = await attributedBuyerCookie(aff.linkCode);
  const v = await makeLtVariant(`w2s2-${stamp}`, 100);
  const o = await placeOrder(cookie, [{ variantId: v.variantId, qty: 40 }]); // pool 2000
  const matured = await matureEntries(o.orderId);
  const req = await requestPayout(aff.bearer);
  check("S2: payout requested at full pool", req.status === 201 && req.amountMinor === matured.totalMinor, `http=${req.status} amount=${req.amountMinor} pool=${matured.totalMinor}`);
  fixturePayoutIds.push(req.payoutId!);
  const half = Math.floor(o.totalMinor / 2);
  const r1 = await refund(o.orderId, half, "S2 half refund pre-approval");
  check("S2: partial refund processed", r1.status === 200, `http=${r1.status}`);
  const rev = await entryReversal(matured.ids);
  const p = await db.affiliatePayout.findUniqueOrThrow({ where: { id: req.payoutId! } });
  check("S2: requested payout auto-shrunk to pool − entry reversal", p.amountMinor === matured.totalMinor - rev, `amount=${p.amountMinor} expected=${matured.totalMinor - rev} (reversal ${rev})`);
  check("S2: payout still requested (auto-release only at 0)", p.status === "requested", `status=${p.status}`);
  const ap = await processPayout(req.payoutId!, "approve");
  const mp = await processPayout(req.payoutId!, "mark-paid", { reference: `${TAG}-s2-${stamp}` });
  check("S2: approve + mark-paid at the SHRUNK amount", ap.status === 200 && mp.status === 200 && mp.json?.data?.amountMinor === p.amountMinor, `approve=${ap.status} mark-paid=${mp.status} amount=${mp.json?.data?.amountMinor}`);
  const tx = await payoutTxnAmounts(req.payoutId!);
  check("S2: T-A3 == T-A4 == shrunk amount (clearing nets 0)", tx.a3 === p.amountMinor && tx.a4 === p.amountMinor, `a3=${tx.a3} a4=${tx.a4} amount=${p.amountMinor}`);
  bankPaidTotal.total += p.amountMinor;
  scenario("S2", { result: `shrunk ${matured.totalMinor}→${p.amountMinor}; T-A3==T-A4==${p.amountMinor}` });
}

// ── S3: refund AFTER approval, BEFORE mark-paid (partial, clearing-side) ────
{
  scenario("S3 — refund after approval, before mark-paid", {});
  const aff = await newAffiliate();
  const cookie = await attributedBuyerCookie(aff.linkCode);
  const v = await makeLtVariant(`w2s3-${stamp}`, 100);
  const o = await placeOrder(cookie, [{ variantId: v.variantId, qty: 40 }]); // pool 2000
  const matured = await matureEntries(o.orderId);
  const req = await requestPayout(aff.bearer);
  fixturePayoutIds.push(req.payoutId!);
  const ap = await processPayout(req.payoutId!, "approve");
  check("S3: approved at full amount", ap.status === 200 && ap.json?.data?.amountMinor === matured.totalMinor, `http=${ap.status} amount=${ap.json?.data?.amountMinor}`);
  const quarter = Math.floor(o.totalMinor / 4);
  const r1 = await refund(o.orderId, quarter, "S3 quarter refund while processing");
  check("S3: refund processed while processing", r1.status === 200, `http=${r1.status}`);
  const rev = await entryReversal(matured.ids);
  const p = await db.affiliatePayout.findUniqueOrThrow({ where: { id: req.payoutId! } });
  check("S3: processing payout shrunk by the entry-level reversal (X == R ≤ remaining)", p.amountMinor === matured.totalMinor - rev, `amount=${p.amountMinor} expected=${matured.totalMinor - rev} (reversal ${rev})`);
  const mp = await processPayout(req.payoutId!, "mark-paid", { reference: `${TAG}-s3-${stamp}` });
  check("S3: mark-paid at the reduced amount", mp.status === 200 && mp.json?.data?.amountMinor === p.amountMinor, `http=${mp.status} amount=${mp.json?.data?.amountMinor}`);
  const tx = await payoutTxnAmounts(req.payoutId!);
  check("S3: T-A3(full) − T5clearing(rev) − T-A4(shrunk) ⇒ clearing scope nets 0", tx.a3 === matured.totalMinor && tx.a4 === p.amountMinor, `a3=${tx.a3} a4=${tx.a4} T5-clearing=${rev} ⇒ scope ${tx.a3! - tx.a4! - rev}`);
  bankPaidTotal.total += p.amountMinor;
  scenario("S3", { result: `T-A3=${tx.a3}, T5-clearing=${rev}, T-A4=${tx.a4} ⇒ clearing scope 0` });
}

// ── S4: FULL refund reduces a processing payout to ZERO (F-1 core) ─────────
{
  scenario("S4 — full refund consumes a processing payout to zero", {});
  const aff = await newAffiliate();
  const cookie = await attributedBuyerCookie(aff.linkCode);
  const v = await makeLtVariant(`w2s4-${stamp}`, 100);
  const o = await placeOrder(cookie, [{ variantId: v.variantId, qty: 40 }]);
  const matured = await matureEntries(o.orderId);
  const req = await requestPayout(aff.bearer);
  fixturePayoutIds.push(req.payoutId!);
  await processPayout(req.payoutId!, "approve");
  const full = await refund(o.orderId, o.totalMinor, "S4 full refund while processing");
  check("S4: full refund processed", full.status === 200, `http=${full.status}`);
  const p = await db.affiliatePayout.findUniqueOrThrow({ where: { id: req.payoutId! } });
  check("S4: payout auto-released (failed, amount 0) — NOT stuck processing", p.status === "failed" && p.amountMinor === 0, `status=${p.status} amount=${p.amountMinor} failReason=${p.failReason}`);
  check("S4: auto-release reason recorded", (p.failReason ?? "").startsWith("Auto-released:"), p.failReason ?? "");
  const tx = await payoutTxnAmounts(req.payoutId!);
  check("S4: T-A3 posted, NO T-A4/T-A4f (zero-value skipped)", tx.a3 === matured.totalMinor && tx.a4 === undefined && tx.a4f === undefined, `a3=${tx.a3} a4=${tx.a4} a4f=${tx.a4f}`);
  const nets = await accountNets();
  check("S4: PAYOUT_CLEARING not driven negative by the run so far", (nets[ACCOUNTS.payoutClearing()] ?? 0) >= clearingStart, `clearing=${nets[ACCOUNTS.payoutClearing()]} (start ${clearingStart})`);
  const reopen = await requestPayout(aff.bearer);
  check("S4: affiliate can re-request (nothing left ⇒ BELOW_MIN_PAYOUT)", reopen.status === 400 && reopen.code === "BELOW_MIN_PAYOUT", `http=${reopen.status} code=${reopen.code}`);
  scenario("S4", { result: "auto-released failed@0; no zero-value posting; clearing never negative; nothing stuck" });
}

// ── S5: partial refund reducing the payout amount ───────────────────────────
{
  scenario("S5 — partial refund reduces payout amount", {});
  const aff = await newAffiliate();
  const cookie = await attributedBuyerCookie(aff.linkCode);
  const v = await makeLtVariant(`w2s5-${stamp}`, 100);
  const o = await placeOrder(cookie, [{ variantId: v.variantId, qty: 40 }]);
  const matured = await matureEntries(o.orderId);
  const req = await requestPayout(aff.bearer);
  fixturePayoutIds.push(req.payoutId!);
  await processPayout(req.payoutId!, "approve");
  const partial = Math.floor(o.totalMinor * 0.3);
  const r1 = await refund(o.orderId, partial, "S5 30% refund while processing");
  check("S5: partial refund processed", r1.status === 200, `http=${r1.status}`);
  const rev = await entryReversal(matured.ids);
  const p = await db.affiliatePayout.findUniqueOrThrow({ where: { id: req.payoutId! } });
  check("S5: payout shrunk exactly by the entry-level reversal", p.amountMinor === matured.totalMinor - rev, `amount=${p.amountMinor} expected=${matured.totalMinor - rev} (reversal ${rev})`);
  const mp = await processPayout(req.payoutId!, "mark-paid", { reference: `${TAG}-s5-${stamp}` });
  check("S5: mark-paid at reduced amount", mp.status === 200 && mp.json?.data?.amountMinor === p.amountMinor, `http=${mp.status}`);
  const tx = await payoutTxnAmounts(req.payoutId!);
  check("S5: clearing scope nets 0 (a3 == a4 + T5-clearing)", tx.a3 === tx.a4! + rev, `a3=${tx.a3} a4=${tx.a4} T5clearing=${rev}`);
  bankPaidTotal.total += p.amountMinor;
  scenario("S5", { result: `reversal ${rev} shrinks payout to ${p.amountMinor}; clearing nets 0` });
}

// ── S6: MULTIPLE refunds against entries linked to ONE payout ───────────────
{
  scenario("S6 — multiple refunds, one payout", {});
  const aff = await newAffiliate();
  const cookie = await attributedBuyerCookie(aff.linkCode);
  const v = await makeLtVariant(`w2s6-${stamp}`, 100);
  const o = await placeOrder(cookie, [{ variantId: v.variantId, qty: 40 }]);
  const matured = await matureEntries(o.orderId);
  const req = await requestPayout(aff.bearer);
  fixturePayoutIds.push(req.payoutId!);
  await processPayout(req.payoutId!, "approve");
  const r1 = await refund(o.orderId, Math.floor(o.totalMinor * 0.2), "S6 refund 1/3 while processing");
  const r2 = await refund(o.orderId, Math.floor(o.totalMinor * 0.3), "S6 refund 2/3 while processing");
  check("S6: first two partial refunds processed", r1.status === 200 && r2.status === 200, `r1=${r1.status} r2=${r2.status}`);
  let p = await db.affiliatePayout.findUniqueOrThrow({ where: { id: req.payoutId! } });
  const revAfter2 = await entryReversal(matured.ids);
  check("S6: payout shrunk by the CUMULATIVE reversal after two refunds", p.amountMinor === matured.totalMinor - revAfter2, `amount=${p.amountMinor} expected=${matured.totalMinor - revAfter2} (reversed ${revAfter2})`);
  const remainder = o.totalMinor - Math.floor(o.totalMinor * 0.2) - Math.floor(o.totalMinor * 0.3) - 1;
  const r3 = await refund(o.orderId, remainder, "S6 refund 3/3 (remainder−1, still partial)");
  check("S6: third refund processed", r3.status === 200, `http=${r3.status}`);
  p = await db.affiliatePayout.findUniqueOrThrow({ where: { id: req.payoutId! } });
  const revAfter3 = await entryReversal(matured.ids);
  check("S6: cumulative reversal stays within the pool", revAfter3 <= matured.totalMinor, `reversed=${revAfter3}/${matured.totalMinor}`);
  const t5s = await db.ledgerTransaction.count({ where: { txnType: "refund", dedupKey: { in: [r1.refundId, r2.refundId, r3.refundId].map((id) => `refund:refund:${id}`) } } });
  check("S6: exactly one T5 per refund row (3 rows ⇒ 3 txns)", t5s === 3, `t5s=${t5s}`);
  const mp = await processPayout(req.payoutId!, "mark-paid", { reference: `${TAG}-s6-${stamp}` });
  check("S6: payout terminaled at the converged amount", mp.status === 200 && mp.json?.data?.amountMinor === p.amountMinor, `http=${mp.status} amount=${mp.json?.data?.amountMinor} (status ${p.status})`);
  bankPaidTotal.total += p.amountMinor;
  scenario("S6", { result: `3 sequential refunds; cumulative reversal ${revAfter3}/${matured.totalMinor}; paid@${p.amountMinor}` });
}

// ── S7: CONCURRENT refund + mark-paid ───────────────────────────────────────
{
  scenario("S7 — concurrent refund + mark-paid", {});
  const aff = await newAffiliate();
  const cookie = await attributedBuyerCookie(aff.linkCode);
  const v = await makeLtVariant(`w2s7-${stamp}`, 100);
  const o = await placeOrder(cookie, [{ variantId: v.variantId, qty: 40 }]);
  const matured = await matureEntries(o.orderId);
  const req = await requestPayout(aff.bearer);
  fixturePayoutIds.push(req.payoutId!);
  await processPayout(req.payoutId!, "approve");
  await byteWalletMature();
  const row = await db.refund.create({ data: { orderId: o.orderId, amountMinor: o.totalMinor, reason: `${TAG} S7 concurrent full refund`, status: "requested", requestedBy: "seller", restock: false } });
  await pFetch(`/api/admin/refunds/${row.id}/approve`, { method: "POST", headers: adminH, body: "{}" });
  const [refundP, markPaidP] = await Promise.all([
    pFetch(`/api/admin/refunds/${row.id}/process`, { method: "POST", headers: adminH, body: "{}" }),
    processPayout(req.payoutId!, "mark-paid", { reference: `${TAG}-s7-${stamp}` }),
  ]);
  check("S7: both concurrent calls returned definitive outcomes (no 500)", ![refundP.status, markPaidP.status].includes(500), `refund=${refundP.status} mark-paid=${markPaidP.status}`);
  const p = await db.affiliatePayout.findUniqueOrThrow({ where: { id: req.payoutId! } });
  check("S7: payout reached a TERMINAL state (exactly one winner)", ["paid", "failed"].includes(p.status), `status=${p.status}`);
  const tx = await payoutTxnAmounts(req.payoutId!);
  const reversal = await entryReversal(matured.ids);
  if (p.status === "paid") {
    // mark-paid won: entries were paid at payout time; the refund became a
    // recovery offset (liability-side) — T-A4 == amount, no clearing split.
    check("S7(paid): T-A3 == T-A4 (paid-payout refund is recovery, liability-side)", tx.a3 === matured.totalMinor && tx.a4 === matured.totalMinor, `a3=${tx.a3} a4=${tx.a4}`);
    bankPaidTotal.total += p.amountMinor;
  } else {
    // refund won: auto-release path — no T-A4, clearing netted by T5 lines.
    check("S7(failed): auto-released at 0 with no T-A4", p.amountMinor === 0 && tx.a4 === undefined, `amount=${p.amountMinor} a4=${tx.a4}`);
  }
  const nets = await accountNets();
  check("S7: clearing never negative across the race", (nets[ACCOUNTS.payoutClearing()] ?? 0) >= clearingStart, `clearing=${nets[ACCOUNTS.payoutClearing()]}`);
  scenario("S7", { result: `refund=${refundP.status} mark-paid=${markPaidP.status} → payout ${p.status}@${p.amountMinor}, reversal=${reversal}` });
}

// ── S8: CONCURRENT refund + approval ────────────────────────────────────────
{
  scenario("S8 — concurrent refund + approval", {});
  const aff = await newAffiliate();
  const cookie = await attributedBuyerCookie(aff.linkCode);
  const v = await makeLtVariant(`w2s8-${stamp}`, 100);
  const o = await placeOrder(cookie, [{ variantId: v.variantId, qty: 40 }]);
  const matured = await matureEntries(o.orderId);
  const req = await requestPayout(aff.bearer);
  fixturePayoutIds.push(req.payoutId!);
  await byteWalletMature();
  const half = Math.floor(o.totalMinor / 2);
  const row = await db.refund.create({ data: { orderId: o.orderId, amountMinor: half, reason: `${TAG} S8 concurrent half refund`, status: "requested", requestedBy: "seller", restock: false } });
  await pFetch(`/api/admin/refunds/${row.id}/approve`, { method: "POST", headers: adminH, body: "{}" });
  const [refundP, approveP] = await Promise.all([
    pFetch(`/api/admin/refunds/${row.id}/process`, { method: "POST", headers: adminH, body: "{}" }),
    processPayout(req.payoutId!, "approve"),
  ]);
  check("S8: both concurrent calls returned definitive outcomes (no 500)", ![refundP.status, approveP.status].includes(500), `refund=${refundP.status} approve=${approveP.status}`);
  let p = await db.affiliatePayout.findUniqueOrThrow({ where: { id: req.payoutId! } });
  const rev = await entryReversal(matured.ids);
  const expectedAmount = matured.totalMinor - rev;
  check("S8: payout amount == pool − reversal regardless of interleaving", p.amountMinor === expectedAmount, `amount=${p.amountMinor} expected=${expectedAmount} (reversal=${rev})`);
  if (p.status !== "processing") {
    const ap2 = await processPayout(req.payoutId!, "approve");
    check("S8: (approve retried) after the refund-committed-first path", ap2.status === 200, `http=${ap2.status}`);
    p = await db.affiliatePayout.findUniqueOrThrow({ where: { id: req.payoutId! } });
  }
  const mp = await processPayout(req.payoutId!, "mark-paid", { reference: `${TAG}-s8-${stamp}` });
  check("S8: mark-paid at the converged amount", mp.status === 200 && mp.json?.data?.amountMinor === p.amountMinor, `http=${mp.status} amount=${mp.json?.data?.amountMinor} (status ${p.status})`);
  bankPaidTotal.total += p.amountMinor;
  const nets = await accountNets();
  check("S8: clearing never negative across the race", (nets[ACCOUNTS.payoutClearing()] ?? 0) >= clearingStart, `clearing=${nets[ACCOUNTS.payoutClearing()]}`);
  scenario("S8", { result: `refund=${refundP.status} approve=${approveP.status} → ${p.status}@${p.amountMinor}` });
}

// ── S9: repeated processing / retries / duplicate-open requests ──────────────
{
  scenario("S9 — repeated processing and retry requests", {});
  const aff = await newAffiliate();
  const cookie = await attributedBuyerCookie(aff.linkCode);
  const v = await makeLtVariant(`w2s9-${stamp}`, 100);
  const o = await placeOrder(cookie, [{ variantId: v.variantId, qty: 40 }]);
  await matureEntries(o.orderId);
  const dupReq = await Promise.all([requestPayout(aff.bearer), requestPayout(aff.bearer)]);
  const wins = dupReq.filter((r) => r.status === 201);
  const conflicts = dupReq.filter((r) => r.status === 409);
  check("S9: duplicate concurrent payout requests → exactly one 201 + one 409 PAYOUT_OPEN", wins.length === 1 && conflicts.length === 1 && conflicts[0].code === "PAYOUT_OPEN", JSON.stringify(dupReq.map((r) => `${r.status}:${r.code}`)));
  const pid = wins[0].payoutId!;
  fixturePayoutIds.push(pid);
  const [ap1, ap2] = await Promise.all([processPayout(pid, "approve"), processPayout(pid, "approve")]);
  const approveWins = [ap1, ap2].filter((r) => r.status === 200).length;
  check("S9: duplicate approve → exactly one 200", approveWins === 1, `approve outcomes: ${ap1.status}/${ap2.status}`);
  const [mp1, mp2] = await Promise.all([processPayout(pid, "mark-paid", { reference: `${TAG}-s9-${stamp}` }), processPayout(pid, "mark-paid", { reference: `${TAG}-s9b-${stamp}` })]);
  const markWins = [mp1, mp2].filter((r) => r.status === 200).length;
  check("S9: duplicate mark-paid → exactly one 200 (no double T-A4)", markWins === 1, `mark-paid outcomes: ${mp1.status}/${mp2.status}`);
  const tx = await payoutTxnAmounts(pid);
  check("S9: exactly ONE T-A3 and ONE T-A4", tx.a3 !== undefined && tx.a4 !== undefined && tx.a3 === tx.a4, `a3=${tx.a3} a4=${tx.a4}`);
  bankPaidTotal.total += tx.a4 ?? 0;
  const reopen = await requestPayout(aff.bearer);
  check("S9: new request after terminal payout (nothing left ⇒ BELOW_MIN)", reopen.status === 400 && reopen.code === "BELOW_MIN_PAYOUT", `http=${reopen.status} code=${reopen.code}`);
  scenario("S9", { result: "one-open, one-approve, one-T-A4 under duplicate concurrent submits" });
}

// ── S10: late recovery offsets from already-paid commissions (V-F8 core) ────
{
  scenario("S10 — late recovery + overclaimed payout + full in-flight reversal (V-F8)", {});
  const aff = await newAffiliate();
  const cookie = await attributedBuyerCookie(aff.linkCode);
  const v1 = await makeLtVariant(`w2s10a-${stamp}`, 100);
  const o1 = await placeOrder(cookie, [{ variantId: v1.variantId, qty: 20 }]); // pool 1000
  const m1 = await matureEntries(o1.orderId);
  const p1 = await requestPayout(aff.bearer);
  check("S10: P1 requested at full pool", p1.status === 201 && p1.amountMinor === m1.totalMinor, `http=${p1.status} amount=${p1.amountMinor}`);
  fixturePayoutIds.push(p1.payoutId!);
  await processPayout(p1.payoutId!, "approve");
  await processPayout(p1.payoutId!, "mark-paid", { reference: `${TAG}-s10-p1-${stamp}` });
  bankPaidTotal.total += m1.totalMinor;
  // late full refund of O1 AFTER payout → recovery offset (liability side)
  const late = await refund(o1.orderId, o1.totalMinor, "S10 late refund after P1 paid (recovery)");
  check("S10: late refund processed", late.status === 200, `http=${late.status}`);
  const eOld = (await db.affiliateCommissionEntry.findMany({ where: { id: { in: m1.ids } } }))[0];
  check("S10: E_old stays paid as a RECOVERY offset", eOld.status === "paid" && eOld.reversedMinor === eOld.amountMinor, `${eOld.status}:${eOld.reversedMinor}/${eOld.amountMinor}`);
  // new earnings (2× the old pool) → P2 nets the recovery
  const v2 = await makeLtVariant(`w2s10b-${stamp}`, 100);
  const v3 = await makeLtVariant(`w2s10c-${stamp}`, 100);
  const o2 = await placeOrder(cookie, [{ variantId: v2.variantId, qty: 20 }, { variantId: v3.variantId, qty: 20 }]); // pool 2000
  const m2 = await matureEntries(o2.orderId);
  // V-F8 window baseline: BEFORE P2's request, so T-A3 and its T5 offset both
  // fall inside the measured delta (the pre-fix defect left clearing −1000).
  const netsWindow = await accountNets();
  const clearingWindowStart = netsWindow[ACCOUNTS.payoutClearing()] ?? 0;
  const p2 = await requestPayout(aff.bearer);
  check("S10: P2 amount NETS the recovery (claims 2× the amount — the withholding vehicle)", p2.status === 201 && p2.amountMinor === m2.totalMinor - eOld.reversedMinor, `http=${p2.status} amount=${p2.amountMinor} expected=${m2.totalMinor - eOld.reversedMinor}`);
  fixturePayoutIds.push(p2.payoutId!);
  const ap = await processPayout(p2.payoutId!, "approve");
  check("S10: P2 approved at the recovery-netted amount", ap.status === 200, `http=${ap.status}`);
  // FULL refund of O2 while P2 is processing — the V-F8 window
  const inflight = await refund(o2.orderId, o2.totalMinor, "S10 full refund while P2 processing (V-F8 window)");
  check("S10: in-flight full refund processed", inflight.status === 200, `http=${inflight.status}`);
  const p2row = await db.affiliatePayout.findUniqueOrThrow({ where: { id: p2.payoutId! } });
  check("S10: P2 auto-released (failed @ 0) — NOT stuck processing", p2row.status === "failed" && p2row.amountMinor === 0, `status=${p2row.status} amount=${p2row.amountMinor}`);
  const netsAfter = await accountNets();
  const clearingWindowDelta = (netsAfter[ACCOUNTS.payoutClearing()] ?? 0) - clearingWindowStart;
  check("S10: V-F8 FIXED — clearing delta across the whole window is ZERO (was −recovery pre-fix)", clearingWindowDelta === 0, `delta=${clearingWindowDelta}`);
  check("S10: clearing account NOT driven negative", (netsAfter[ACCOUNTS.payoutClearing()] ?? 0) >= clearingStart, `clearing=${netsAfter[ACCOUNTS.payoutClearing()]} (start ${clearingStart})`);
  const tx2 = await payoutTxnAmounts(p2.payoutId!);
  check("S10: P2 has T-A3 only (no zero-value T-A4/T-A4f)", tx2.a3 === p2.amountMinor && tx2.a4 === undefined && tx2.a4f === undefined, `a3=${tx2.a3} a4=${tx2.a4} a4f=${tx2.a4f}`);
  // the affiliate's recovery debt is enforced: everything reversed/paid, nothing requestable
  const reopen = await requestPayout(aff.bearer);
  check("S10: no further payout requestable (recovery + reversals consumed everything)", reopen.status === 400, `http=${reopen.status} code=${reopen.code}`);
  scenario("S10", { result: `V-F8 window executed: clearing delta ${clearingWindowDelta} (0 ⇒ FIXED); P2 auto-released@0; no stuck` });
}

// ── S11: payout failure + retry/recovery (full lifecycle) ───────────────────
{
  scenario("S11 — payout failure, release, re-request, full cycle", {});
  const aff = await newAffiliate();
  const cookie = await attributedBuyerCookie(aff.linkCode);
  const v = await makeLtVariant(`w2s11-${stamp}`, 100);
  const o = await placeOrder(cookie, [{ variantId: v.variantId, qty: 40 }]);
  const matured = await matureEntries(o.orderId);
  const p1 = await requestPayout(aff.bearer);
  fixturePayoutIds.push(p1.payoutId!);
  await processPayout(p1.payoutId!, "approve");
  const fail = await processPayout(p1.payoutId!, "fail", { reason: `${TAG} S11 simulated bank rejection` });
  check("S11: fail processed", fail.status === 200, `http=${fail.status}`);
  const tx1 = await payoutTxnAmounts(p1.payoutId!);
  check("S11: T-A3 == T-A4f (clearing returned to liability)", tx1.a3 === matured.totalMinor && tx1.a4f === matured.totalMinor && tx1.a4 === undefined, `a3=${tx1.a3} a4f=${tx1.a4f} a4=${tx1.a4}`);
  const released = await db.affiliateCommissionEntry.findMany({ where: { id: { in: matured.ids } }, select: { payoutId: true, status: true } });
  check("S11: entries released back to the pool", released.every((e) => e.payoutId === null && e.status === "available"), JSON.stringify(released.map((e) => `${e.status}:${e.payoutId}`)));
  const p2 = await requestPayout(aff.bearer);
  check("S11: re-request succeeds at the FULL amount", p2.status === 201 && p2.amountMinor === matured.totalMinor, `http=${p2.status} amount=${p2.amountMinor}`);
  fixturePayoutIds.push(p2.payoutId!);
  const partial = Math.floor(o.totalMinor / 4);
  const r1 = await refund(o.orderId, partial, "S11 partial refund during the retry cycle");
  check("S11: partial refund processed", r1.status === 200, `http=${r1.status}`);
  await processPayout(p2.payoutId!, "approve");
  const mp = await processPayout(p2.payoutId!, "mark-paid", { reference: `${TAG}-s11-p2-${stamp}` });
  check("S11: retry completes (approve + mark-paid)", mp.status === 200, `http=${mp.status}`);
  const p2row = await db.affiliatePayout.findUniqueOrThrow({ where: { id: p2.payoutId! } });
  const tx2 = await payoutTxnAmounts(p2.payoutId!);
  check("S11: retry T-A3 == T-A4 == final amount (clearing nets 0)", tx2.a3 === p2row.amountMinor && tx2.a4 === p2row.amountMinor, `a3=${tx2.a3} a4=${tx2.a4} amount=${p2row.amountMinor}`);
  bankPaidTotal.total += p2row.amountMinor;
  scenario("S11", { result: `fail→release→re-request→refund-shrink→paid@${p2row.amountMinor}` });
}

// ── S12: duplicate refund delivery during the same lifecycle ────────────────
{
  scenario("S12 — duplicate refund delivery", {});
  const aff = await newAffiliate();
  const cookie = await attributedBuyerCookie(aff.linkCode);
  const v = await makeLtVariant(`w2s12-${stamp}`, 100);
  const o = await placeOrder(cookie, [{ variantId: v.variantId, qty: 40 }]);
  const matured = await matureEntries(o.orderId);
  const req = await requestPayout(aff.bearer);
  fixturePayoutIds.push(req.payoutId!);
  await processPayout(req.payoutId!, "approve");
  const half = Math.floor(o.totalMinor / 2);
  const row = await db.refund.create({ data: { orderId: o.orderId, amountMinor: half, reason: `${TAG} S12 refund`, status: "requested", requestedBy: "seller", restock: false } });
  await pFetch(`/api/admin/refunds/${row.id}/approve`, { method: "POST", headers: adminH, body: "{}" });
  const first = await pFetch(`/api/admin/refunds/${row.id}/process`, { method: "POST", headers: adminH, body: "{}" });
  const dup = await pFetch(`/api/admin/refunds/${row.id}/process`, { method: "POST", headers: adminH, body: "{}" });
  check("S12: first process 200, duplicate 409 ALREADY_PROCESSED", first.status === 200 && dup.status === 409, `first=${first.status} dup=${dup.status}`);
  const rev = await entryReversal(matured.ids);
  const t5 = await db.ledgerTransaction.count({ where: { dedupKey: `refund:refund:${row.id}` } });
  check("S12: exactly one T5 for the refund row; reversal applied exactly once", t5 === 1, `t5s=${t5}; reversal=${rev}`);
  const p = await db.affiliatePayout.findUniqueOrThrow({ where: { id: req.payoutId! } });
  const mp = await processPayout(req.payoutId!, "mark-paid", { reference: `${TAG}-s12-${stamp}` });
  check("S12: payout still completes after the duplicate delivery", mp.status === 200 && mp.json?.data?.amountMinor === p.amountMinor, `http=${mp.status} amount=${mp.json?.data?.amountMinor}`);
  bankPaidTotal.total += p.amountMinor;
  scenario("S12", { result: "duplicate process → 409; one T5; reversal exactly-once" });
}

// ═════════════════════════ INVARIANT VERIFICATION ═══════════════════════════
console.log("\n══ INDEPENDENT DB INVARIANTS ══");
const netsEnd = await accountNets();
// V.a every txn balanced
const unbalanced = await db.$queryRawUnsafe<{ n: number }[]>(`
  SELECT count(*)::int AS n FROM (
    SELECT l."txnId" FROM "LedgerLine" l GROUP BY l."txnId"
    HAVING sum(CASE WHEN l.direction='debit' THEN l."amountMinor" ELSE -l."amountMinor" END) <> 0
  ) x`);
check("V.a: every ledger transaction balanced (independent SQL)", (unbalanced[0]?.n ?? 0) === 0, `unbalanced=${unbalanced[0]?.n ?? 0}`);
// V.b global D==C
const totals = await db.$queryRawUnsafe<{ d: number; c: number }[]>(`
  SELECT coalesce(sum(CASE WHEN direction='debit' THEN "amountMinor" ELSE 0 END),0)::int AS d,
         coalesce(sum(CASE WHEN direction='credit' THEN "amountMinor" ELSE 0 END),0)::int AS c
  FROM "LedgerLine"`);
check("V.b: global books balance (D==C)", totals[0].d === totals[0].c, `D=${totals[0].d} C=${totals[0].c}`);
// V.c no zero-value transactions
const zeroTxns = await db.$queryRawUnsafe<{ n: number }[]>(`
  SELECT count(*)::int AS n FROM (
    SELECT t.id FROM "LedgerTransaction" t JOIN "LedgerLine" l ON l."txnId" = t.id
    GROUP BY t.id HAVING sum(l."amountMinor") = 0
  ) x`);
check("V.c: no zero-value ledger transaction exists (post-fix fixtures)", (zeroTxns[0]?.n ?? 0) === 0, `zeroTxns=${zeroTxns[0]?.n ?? 0}`);
// V.d clearing run-delta == 0
const clearingDelta = (netsEnd[ACCOUNTS.payoutClearing()] ?? 0) - clearingStart;
check("V.d: PAYOUT_CLEARING run-delta == 0 (every fixture payout netted; never negative)", clearingDelta === 0 && (netsEnd[ACCOUNTS.payoutClearing()] ?? 0) >= clearingStart, `delta=${clearingDelta}, end=${netsEnd[ACCOUNTS.payoutClearing()]}, start=${clearingStart}`);
// V.e nothing stuck
const stuck = await db.affiliatePayout.findMany({ where: { id: { in: fixturePayoutIds }, status: { in: ["requested", "processing"] } } });
check("V.e: no fixture payout stuck in requested/processing", stuck.length === 0, `stuck=${JSON.stringify(stuck.map((p) => p.id))}`);
// V.f entry integrity
const badPaid = await db.affiliateCommissionEntry.count({ where: { status: "paid", payoutId: null } });
const overReversed = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "AffiliateCommissionEntry" WHERE "reversedMinor" > "amountMinor"`);
check("V.f: paid entries all bound to a payout; no entry reversed beyond its amount", badPaid === 0 && (overReversed[0]?.n ?? 0) === 0, `paidUnbound=${badPaid} overReversed=${overReversed[0]?.n ?? 0}`);
// V.g wallet caches == truth (app invariant engine)
const inv = await runLedgerInvariants();
check("V.g: app ledger invariants report zero hard problems", inv.ok && inv.problems.length === 0 && inv.hardDrift.length === 0, JSON.stringify({ problems: inv.problems.slice(0, 3), hardDrift: inv.hardDrift.length }));
// V.h T-A4/T-A4f == payout amounts (paid/failed fixture payouts)
let amtMismatch = 0;
for (const pid of fixturePayoutIds) {
  const p = await db.affiliatePayout.findUniqueOrThrow({ where: { id: pid } });
  const tx = await payoutTxnAmounts(pid);
  if (p.status === "paid" && tx.a4 !== p.amountMinor) amtMismatch++;
  if (p.status === "failed" && (p.failReason ?? "").startsWith("Auto-released") && (tx.a4 !== undefined || tx.a4f !== undefined)) amtMismatch++;
  if (p.status === "failed" && !(p.failReason ?? "").startsWith("Auto-released") && tx.a4f !== p.amountMinor) amtMismatch++;
}
check("V.h: every terminal fixture payout's ledger postings equal its row amount (auto-released ⇒ none)", amtMismatch === 0, `mismatches=${amtMismatch}`);
// V.i BANK_MAIN delta == Σ paid amounts (affiliate payouts only touch bank via T-A4)
const bankDelta = (netsEnd[ACCOUNTS.BANK_MAIN] ?? 0) - bankStart;
check("V.i: BANK_MAIN run-delta == Σ fixture T-A4 payouts (no money created or lost)", bankDelta === bankPaidTotal.total, `delta=${bankDelta} expected=${bankPaidTotal.total}`);

evidence.invariants = {
  globalDebit: totals[0].d, globalCredit: totals[0].c,
  clearingStart, clearingEnd: netsEnd[ACCOUNTS.payoutClearing()] ?? 0, clearingDelta,
  liabilityStart, liabilityEnd: netsEnd[ACCOUNTS.affiliateLiability()] ?? 0,
  bankStart, bankEnd: netsEnd[ACCOUNTS.BANK_MAIN] ?? 0, bankPaidTotal: bankPaidTotal.total,
  fixturePayoutIds,
};
evidence.failures = exitCode();
writeFileSync("docs/staging/evidence/phase3-work2-vf8f1-regression.json", JSON.stringify(evidence, null, 2));
const code = summary("phase3-work2-vf8f1-regression");
await db.$disconnect();
process.exit(code === 0 ? 0 : 1);
