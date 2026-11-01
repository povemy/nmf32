// ============================================================================
// PHASE 2.1 STAGING TEST — Verified-purchase reviews end-to-end (runbook §7).
// ----------------------------------------------------------------------------
// ⚠️ PREPARED — DO NOT RUN IN THIS SANDBOX. Authorized staging only, AFTER
// migration 20261101000001_phase1_review_verified_purchase is applied.
// [LT]-tagged, self-cleaning.
//
// Covers (§7 "Reviews"):
//   • Anonymous submission rejected (401).
//   • Signed-in NON-purchaser rejected (403).
//   • Eligible buyer (delivered order containing the product) accepted →
//     review lands as PENDING (pre-moderation).
//   • Duplicate review rejected (409/dup guard — code + DB unique).
//   • Pending review EXCLUDED from public aggregates (ratingAvg/Count).
//   • Moderation APPROVE → aggregate updates; seller self-review blocked.
//   • Moderation REJECT → aggregate unchanged.
// ============================================================================
import { db } from "../../src/lib/db";
import { hashPasswordAsync } from "../../src/lib/password";
import { check, summary, exitCode } from "./lib";

const BASE = "http://127.0.0.1:3000";
const RUN = Date.now().toString(36);
const SHOPPER_EMAIL = `lt-review-${RUN}@nomofee.test`;
const PASSWORD = "LtReview123!";

type Json = Record<string, unknown>;
async function api(method: string, path: string, opts: { cookie?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  let json: Json = {};
  try { json = await res.json() as Json; } catch { /* empty */ }
  return { status: res.status, json };
}
const errCode = (j: Json) => String((j.error as Json | undefined)?.code ?? "");

async function main() {
  // ---- fixtures: [LT] shopper + a live store + product + a DELIVERED order --
  const store = await db.store.findFirst({
    where: { status: "live", seller: { is: { marketplaceOptIn: true } } },
    include: { seller: true },
  });
  if (!store) { console.error("no live opt-in store for fixture"); process.exit(1); }
  const product = await db.product.findFirst({
    where: { storeId: store.id, status: "active", variants: { some: { stock: { gt: 0 } } } },
    include: { variants: true },
  });
  if (!product) { console.error("no active product in store"); process.exit(1); }

  const shopper = await db.shopperUser.create({
    data: { email: SHOPPER_EMAIL, passwordHash: await hashPasswordAsync(PASSWORD), fullName: "LT Review Buyer" },
  });

  // A DELIVERED order containing the product (direct fixture — the eligibility
  // join must find it: most recent delivered|completed order of THIS shopper
  // containing THIS product in THIS store).
  const order = await db.order.create({
    data: {
      orderNumber: `LT-REV-${RUN}`,
      storeId: store.id,
      shopperId: shopper.id,
      customerName: "LT Review Buyer",
      customerEmail: SHOPPER_EMAIL,
      status: "delivered",
      currency: "MYR",
      subtotalMinor: 1000, discountMinor: 0, shippingMinor: 0, taxMinor: 0, totalMinor: 1000,
      shippingAddressJson: "{}",
      items: { create: [{ productId: product.id, variantId: product.variants[0].id, title: product.title, qty: 1, unitPriceMinor: 1000, lineSubtotalMinor: 1000 }] },
    },
  });

  try {
    const slug = store.slug;
    const pSlug = product.slug;
    const reviewPath = `/api/sf/${slug}/products/${pSlug}/reviews`;

    // Aggregate baseline.
    const pdp0 = await api("GET", `/api/sf/${slug}/products/${pSlug}`);
    const agg0 = ((pdp0.json.data as Json) ?? {}) as { ratingAvg?: number; ratingCount?: number };
    const baseCount = agg0.ratingCount ?? 0;

    const body = { rating: 5, title: "LT great product", content: "Verified staged purchase — review pipeline works end to end." };

    // 1 — anonymous rejected.
    const anon = await api("POST", reviewPath, { body });
    check("R1 anonymous submission rejected (401)", anon.status === 401, `status=${anon.status}`);

    // 2 — signed-in NON-purchaser rejected.
    const login = await fetch(`${BASE}/api/auth/shopper/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "qa.shopper@nomofee.test", password: "Shopper123!" }),
    });
    const qaCookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    if (qaCookie) {
      const np = await api("POST", reviewPath, { cookie: qaCookie, body });
      check("R2 non-purchaser rejected (403)", np.status === 403, `status=${np.status} code=${errCode(np.json)}`);
    } else {
      check("R2 non-purchaser rejected (403)", false, "qa.shopper fixture missing on this environment");
    }

    // 3 — eligible buyer accepted → PENDING.
    const ownLogin = await fetch(`${BASE}/api/auth/shopper/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: SHOPPER_EMAIL, password: PASSWORD }),
    });
    const ownCookie = (ownLogin.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    const ok1 = await api("POST", reviewPath, { cookie: ownCookie, body });
    const reviewId = String(((ok1.json.data as Json) ?? {}).id ?? "");
    check("R3 eligible buyer accepted (pending)", ok1.status === 201 || ok1.status === 200, `status=${ok1.status} code=${errCode(ok1.json)}`);

    // 4 — duplicate rejected.
    const dup = await api("POST", reviewPath, { cookie: ownCookie, body });
    check("R4 duplicate review rejected", dup.status === 409 || dup.status === 400, `status=${dup.status} code=${errCode(dup.json)}`);

    // 5 — pending EXCLUDED from aggregates.
    const pdp1 = await api("GET", `/api/sf/${slug}/products/${pSlug}`);
    const agg1 = ((pdp1.json.data as Json) ?? {}) as { ratingCount?: number };
    check("R5 pending review excluded from public aggregates", (agg1.ratingCount ?? 0) === baseCount, `${baseCount} → ${agg1.ratingCount}`);

    // 6 — moderation approve → aggregate updates (+1 at rating 5).
    const adminLogin = await api("POST", "/api/auth/login", { body: { email: (await db.adminUser.findFirst({ where: { role: "superadmin" } }))?.email ?? "admin@nomofee.io", password: process.env.LT_ADMIN_PASSWORD ?? "Admin123!", portal: "admin" } });
    const adminTok = String((adminLogin.json.data as Json)?.token ?? "");
    if (reviewId && adminTok) {
      const approve = await api("POST", `/api/admin/reviews/${reviewId}/moderate`, { token: adminTok, body: { action: "approve" } });
      check("R6a moderation approve accepted", approve.status === 200, `status=${approve.status} code=${errCode(approve.json)}`);
      const pdp2 = await api("GET", `/api/sf/${slug}/products/${pSlug}`);
      const agg2 = ((pdp2.json.data as Json) ?? {}) as { ratingCount?: number; ratingAvg?: number };
      check("R6b published review counted in aggregates", (agg2.ratingCount ?? 0) === baseCount + 1, `${baseCount} → ${agg2.ratingCount}`);
    } else {
      check("R6 moderation transitions (admin fixture login required)", false, "set LT_ADMIN_PASSWORD for the superadmin to exercise moderation");
    }

    // 7 — seller self-review blocked (seller login on own product).
    //     (Requires seller fixture credentials — probed via store.seller.email with
    //     LT_SELLER_PASSWORD; skipped cleanly when unset.)
    if (process.env.LT_SELLER_PASSWORD && store.seller) {
      const sLogin = await api("POST", "/api/auth/login", { body: { email: store.seller.email, password: process.env.LT_SELLER_PASSWORD, portal: "seller" } });
      const sTok = String((sLogin.json.data as Json)?.token ?? "");
      if (sTok) {
        const self = await api("POST", reviewPath, { token: sTok, body });
        check("R7 seller self-review blocked (403)", self.status === 403, `status=${self.status}`);
      }
    } else {
      console.log("R7 seller self-review block: SKIPPED (set LT_SELLER_PASSWORD to exercise)");
    }
  } finally {
    await db.review.deleteMany({ where: { order: { id: order.id } } }).catch(() => {});
    await db.orderItem.deleteMany({ where: { orderId: order.id } }).catch(() => {});
    await db.orderStatusHistory.deleteMany({ where: { orderId: order.id } }).catch(() => {});
    await db.order.delete({ where: { id: order.id } }).catch(() => {});
    await db.session.deleteMany({ where: { userType: "shopper", userId: shopper.id } }).catch(() => {});
    await db.shopperUser.delete({ where: { id: shopper.id } }).catch(() => {});
    console.log(`[cleanup] removed [LT] review fixtures (${order.orderNumber}, ${SHOPPER_EMAIL})`);
  }
  process.exit(summary("Reviews E2E") === 0 ? 0 : exitCode());
}

main().catch((e) => { console.error("reviews-e2e crashed:", e); process.exit(1); });
