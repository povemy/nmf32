// ============================================================================
// ABUSE & SECURITY TEST SUITE (review rewards work order §10 — all 18 cases).
// Runs against the live dev server (localhost:3000) with REAL API calls and
// verifies the DATABASE state after each critical step. Staging only.
// ============================================================================
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const BASE = "http://localhost:3000";
let pass = 0;
let fail = 0;
const results: string[] = [];

function report(name: string, ok: boolean, detail: string) {
  if (ok) { pass++; results.push(`  PASS ${name} — ${detail}`); }
  else { fail++; results.push(`  FAIL ${name} — ${detail}`); }
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/shopper/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SM-Client": "web" },
    body: JSON.stringify({ email, password }),
  });
  const b = (await res.json()) as { data?: { token?: string } };
  if (!b.data?.token) throw new Error(`login failed for ${email}: ${res.status}`);
  return b.data.token;
}

async function loginAdmin(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, portal: "admin" }),
  });
  const b = (await res.json()) as { data?: { token?: string } };
  if (!b.data?.token) throw new Error(`admin login failed for ${email}: ${res.status}`);
  return b.data.token;
}

async function loginSeller(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, portal: "seller" }),
  });
  const b = (await res.json()) as { data?: { token?: string } };
  if (!b.data?.token) throw new Error(`seller login failed for ${email}: ${res.status}`);
  return b.data.token;
}

async function api(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json: { data?: unknown; error?: { code?: string; message?: string } } = {};
  try { json = (await res.json()) as typeof json; } catch { /* empty */ }
  return { status: res.status, code: json.error?.code ?? null, data: json.data, raw: json };
}

async function main() {
  // ------------------------------------------------------ IDEMPOTENT RESET
  // Remove artifacts from any previous suite run (shopper-authored reviews
  // + their reward rows) and recompute affected aggregates. Synthetic staged
  // fixtures (null shopperId) are untouched.
  {
    const testShoppers = await db.shopperUser.findMany({
      where: { email: { in: ["aisyah@nomofee.test", "qa.shopper@nomofee.test"] } },
      select: { id: true },
    });
    const ids = testShoppers.map((s) => s.id);
    const old = await db.review.findMany({ where: { shopperId: { in: ids } }, select: { id: true, productId: true } });
    if (old.length > 0) {
      await db.review.deleteMany({ where: { shopperId: { in: ids } } });
      await db.membershipReward.deleteMany({ where: { shopperId: { in: ids } } });
      const pids = [...new Set(old.map((r) => r.productId))];
      for (const pid of pids) {
        const agg = await db.review.aggregate({ where: { productId: pid, status: "published" }, _avg: { rating: true }, _count: { rating: true } });
        await db.product.update({ where: { id: pid }, data: { ratingAvg: Math.round((agg._avg.rating ?? 0) * 100) / 100, ratingCount: agg._count.rating } });
      }
      console.log(`[reset] removed ${old.length} prior suite review(s)`);
    }
  }

  // ---------------------------------------------------------------- logins
  const aisyah = await login("aisyah@nomofee.test", "NOMOFEE123!");
  const qa = await login("qa.shopper@nomofee.test", "Shopper123!");
  const aff = await login("aff-alpha@verify.nomofee.io", "Verify123!");
  const mod = await loginAdmin("moderator@nomofee.io", "Mod12345!");
  const seller = await loginSeller("lumina@nomofee.io", "Seller123!");
  console.log("logins OK");

  const sf = (store: string, product: string) => `/api/sf/${store}/products/${product}`;
  // The reviews route throttles 5 POSTs/min/IP and 3 submissions/hour/account.
  // Pacing keeps the suite inside the REAL limits (no bypass — the limiter is
  // part of the abuse defense being tested).
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const post = async (store: string, product: string, token: string | null, payload: unknown) => {
    await sleep(14_000);
    return api("POST", `${sf(store, product)}/reviews`, token, payload);
  };

  // snapshot pre-state
  const reviewsBefore = await db.review.count();
  const rewardsBefore = await db.membershipReward.count();
  console.log(`pre-state: ${reviewsBefore} reviews (all synthetic), ${rewardsBefore} reward rows\n`);

  // ============================================================ TEST 1
  // Non-purchaser attempts to review (no eligible order at all).
  {
    const r = await post("lumina-living", "aurora-ceramic-vase", aff, { rating: 5, title: "looks nice" });
    report("T1 non-purchaser 403", r.status === 403 && r.code === "VERIFIED_PURCHASE_REQUIRED", `status=${r.status} code=${r.code}`);
  }

  // ============================================================ TEST 2
  // Purchaser attempts to review BEFORE goods arrive (order still shipped).
  {
    const r = await post("lumina-living", "candle-neroli", aff, { rating: 5 });
    report("T2 shipped-not-delivered 403", r.status === 403 && r.code === "VERIFIED_PURCHASE_REQUIRED", `status=${r.status} code=${r.code}`);
  }

  // ============================================================ TEST 3
  // Paid but not shipped (goods not in hand) — unsuccessful-delivery review.
  {
    const r = await post("bytebazaar", "pulse-anc-earbuds", aisyah, { rating: 5 });
    report("T3 paid-not-delivered 403", r.status === 403 && r.code === "VERIFIED_PURCHASE_REQUIRED", `status=${r.status} code=${r.code}`);
  }

  // ============================================================ TEST 4
  // Cancelled order — never eligible.
  {
    const r = await post("bytebazaar", "rgb-light-bars", aisyah, { rating: 1 });
    report("T4 cancelled order 403", r.status === 403 && r.code === "VERIFIED_PURCHASE_REQUIRED", `status=${r.status} code=${r.code}`);
  }

  // ============================================================ TEST 5 + 13
  // Cross-order forgery + client tampering: qa submits with SOMEBODY ELSE'S
  // orderId, a forged verifiedPurchase flag, and a forged reward amount. The
  // server must derive eligibility itself, ignore every client-side claim.
  {
    const r = await post("lumina-living", "rattan-wall-mirror", qa, {
      rating: 2,
      title: "Mirror arrived warped",
      body: "Not happy with the weave quality.",
      orderId: "NM-100025",             // tradecasm's order — must be IGNORED
      orderNumber: "NM-100025",
      verifiedPurchase: true,           // client-asserted flag — must be IGNORED
      rewardPoints: 50000,              // forged reward — must be IGNORED
      points: 999,
    });
    const okStatus = r.status === 201;
    const d = r.data as { reward?: { points: number } } | undefined;
    report("T5/13 forged order+flags accepted only via server eligibility",
      okStatus && d?.reward?.points === 5, `status=${r.status} reward=${d?.reward?.points}`);
    // the frozen orderId must be qa's OWN order (NM-100003), not the forged one
    const rattanPid = (await db.product.findFirst({ where: { slug: "rattan-wall-mirror" }, select: { id: true } }))!.id;
    const mine = await db.review.findFirst({ where: { shopperId: (await db.shopperUser.findUnique({ where: { email: "qa.shopper@nomofee.test" } }))!.id, productId: rattanPid }, orderBy: { createdAt: "desc" }, select: { orderId: true, order: { select: { orderNumber: true } } } });
    report("T13b server-frozen orderId is the reviewer's own order", mine?.order?.orderNumber === "NM-100003", `frozen=${mine?.order?.orderNumber}`);
  }

  // ============================================================ TEST 6
  // Guest (no authentication) attempts to submit.
  {
    const r = await post("lumina-living", "aurora-ceramic-vase", null, { rating: 5 });
    report("T6 guest 401", r.status === 401, `status=${r.status} code=${r.code}`);
  }

  // ============================================================ TEST 7
  // Tampered star rating (out of range / non-integer) is rejected.
  {
    const r1 = await post("lumina-living", "aurora-ceramic-vase", aisyah, { rating: 9 });
    const r2 = await post("lumina-living", "aurora-ceramic-vase", aisyah, { rating: 4.5 });
    report("T7a tampered rating rejected", r1.status === 400 && r2.status === 400, `9→${r1.status}/${r1.code} 4.5→${r2.status}/${r2.code}`);
    // XSS payload — stored as inert TEXT (control chars stripped; React escapes on render)
    const xss = "<script>alert('xss')</script><img src=x onerror=alert(1)>";
    const r3 = await post("lumina-living", "aurora-ceramic-vase", aisyah, { rating: 4, title: xss, body: `Great vase \u0000\u0007${xss}` });
    const ok = r3.status === 201;
    const stored = await db.review.findFirst({ where: { productId: (await db.product.findFirst({ where: { slug: "aurora-ceramic-vase" } }))!.id, shopperId: (await db.shopperUser.findUnique({ where: { email: "aisyah@nomofee.test" } }))!.id }, select: { title: true, body: true } });
    const cleanTitle = stored?.title === xss; // stored verbatim as text — rendered escaped by React (no dangerouslySetInnerHTML)
    const cleanBody = stored?.body === `Great vase ${xss}`; // control chars stripped
    report("T7b XSS payload stored inert (no control chars, React-escaped render)", ok && cleanTitle && cleanBody, `status=${r3.status} title-verbatim=${cleanTitle} ctrl-stripped=${cleanBody}`);
  }

  // ============================================================ TEST 8
  // Duplicate submission by the same shopper for the same product.
  {
    const r = await post("lumina-living", "aurora-ceramic-vase", aisyah, { rating: 5 });
    report("T8 duplicate 409", r.status === 409 && r.code === "REVIEW_ALREADY_EXISTS", `status=${r.status} code=${r.code}`);
  }

  // ============================================================ TEST 9
  // Concurrent duplicate submissions — exactly one wins.
  {
    const [r1, r2] = await Promise.all([
      post("lumina-living", "linen-cushion-sand", qa, { rating: 3, title: "Soft but thin" }),
      post("lumina-living", "linen-cushion-sand", qa, { rating: 3, title: "Soft but thin" }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    const qaId = (await db.shopperUser.findUnique({ where: { email: "qa.shopper@nomofee.test" } }))!.id;
    const [reviewRows, rewardRows] = await Promise.all([
      db.review.count({ where: { shopperId: qaId } }),
      db.membershipReward.count({ where: { shopperId: qaId } }),
    ]);
    report("T9 concurrent → exactly one 201 + one 409", statuses[0] === 201 && statuses[1] === 409, `statuses=${statuses.join(",")}`);
    report("T9b one review + ONE reward per shopper after race", reviewRows === 2 && rewardRows === 2, `reviews=${reviewRows} (rattan+linen) rewards=${rewardRows} (both 5pt)`);
  }

  // ============================================================ TEST 10
  // Pending reviews never affect public aggregates.
  {
    const r = await api("GET", `${sf("lumina-living", "aurora-ceramic-vase")}`, null);
    const d = r.data as { product: { ratingCount: number; ratingAvg: number }; reviews: unknown[] };
    report("T10 pending review invisible on public PDP", d.product.ratingCount === 0 && d.reviews.length === 0, `ratingCount=${d.product.ratingCount} listLen=${d.reviews.length}`);
  }

  // ============================================================ TEST 11
  // Edit rules: pending-only edits (max 2), each audited, no extra reward.
  {
    const aisyahId = (await db.shopperUser.findUnique({ where: { email: "aisyah@nomofee.test" } }))!.id;
    const auroraId = (await db.product.findFirst({ where: { slug: "aurora-ceramic-vase" } }))!.id;
    const review = await db.review.findFirst({ where: { shopperId: aisyahId, productId: auroraId } });
    const e1 = await api("PATCH", `/api/me/reviews/${review!.id}`, aisyah, { rating: 5, body: "Updated after second look — lovely glaze." });
    const e2 = await api("PATCH", `/api/me/reviews/${review!.id}`, aisyah, { rating: 4, body: "Final: 4 stars." });
    const e3 = await api("PATCH", `/api/me/reviews/${review!.id}`, aisyah, { rating: 3 });
    const editsLogged = await db.activityLog.count({ where: { action: "shopper.review.edited", entityId: review!.id } });
    const rewardsForAisyah = await db.membershipReward.count({ where: { shopperId: aisyahId } });
    report("T11 edits 1+2 OK, 3rd hits limit", e1.status === 200 && e2.status === 200 && e3.status === 409 && e3.code === "EDIT_LIMIT", `e1=${e1.status} e2=${e2.status} e3=${e3.status}/${e3.code}`);
    report("T11b edit history audited, reward NOT re-credited", editsLogged === 2 && rewardsForAisyah === 1, `auditRows=${editsLogged} rewards=${rewardsForAisyah}`);
    // Cross-shopper edit attempt: qa tries to edit aisyah's review → 404 (indistinguishable)
    const cross = await api("PATCH", `/api/me/reviews/${review!.id}`, qa, { rating: 1 });
    report("T11c cross-shopper edit 404", cross.status === 404, `status=${cross.status}`);
  }

  // ============================================================ TEST 12
  // Seller self-review + seller cannot touch moderation.
  {
    // Realistic attack: the seller ALSO registers a SHOPPER account with the
    // same email (the route's step-4 guard exists exactly for this).
    // Seed that shopper identity (staging), login as a shopper, attempt review.
    const sellerEmail = "lumina@nomofee.io";
    const existing = await db.shopperUser.findUnique({ where: { email: sellerEmail } });
    if (!existing) {
      const { hashPassword } = await import("../../src/lib/password");
      await db.shopperUser.create({
        data: { email: sellerEmail, fullName: "Sofia Lim (buyer alias)", passwordHash: hashPassword("Seller123!"), status: "active" },
      });
    }
    const sellerShopper = await login(sellerEmail, "Seller123!");
    const r = await post("lumina-living", "aurora-ceramic-vase", sellerShopper, { rating: 5, title: "Our best vase!" });
    report("T12a seller self-review (shopper alias) 403", r.status === 403 && r.code === "SELLER_SELF_REVIEW", `status=${r.status} code=${r.code}`);
    const r2 = await api("GET", "/api/admin/reviews?status=pending", seller);
    report("T12b seller token blocked from moderation API", r2.status === 401 || r2.status === 403, `status=${r2.status}`);
  }

  // ============================================================ TEST 14
  // Moderator queue: shows both pending reviews WITH purchase context.
  {
    const r = await api("GET", "/api/admin/reviews?status=pending", mod);
    const rows = (r.data ?? []) as { orderNumber?: string | null; shopper?: { email: string } | null; order?: { orderNumber: string } | null; reward?: { points: number } | null }[];
    const aurora = rows.find((x) => x.shopper?.email === "aisyah@nomofee.test");
    const rattan = rows.find((x) => x.shopper?.email === "qa.shopper@nomofee.test");
    report("T14 queue lists pending reviews with order + reward context",
      rows.length >= 2 && !!aurora?.order?.orderNumber && !!rattan?.order?.orderNumber && (rattan?.reward?.points ?? 0) === 5,
      `pending=${rows.length} auroraOrder=${aurora?.order?.orderNumber} rattanOrder=${rattan?.order?.orderNumber}`);
  }

  // ============================================================ TEST 15
  // Approval: publishes, recomputes aggregate, idempotent on repeat.
  {
    const aisyahId = (await db.shopperUser.findUnique({ where: { email: "aisyah@nomofee.test" } }))!.id;
    const auroraId = (await db.product.findFirst({ where: { slug: "aurora-ceramic-vase" } }))!.id;
    const review = await db.review.findFirst({ where: { shopperId: aisyahId, productId: auroraId } });
    const approve = await api("POST", `/api/admin/reviews/${review!.id}`, mod, { action: "approve" });
    const again = await api("POST", `/api/admin/reviews/${review!.id}`, mod, { action: "approve" });
    const pub = await db.product.findUnique({ where: { id: auroraId }, select: { ratingAvg: true, ratingCount: true } });
    report("T15 approve publishes + aggregate recomputed", approve.status === 200 && pub!.ratingCount === 1 && pub!.ratingAvg === 4, `status=${approve.status} agg=${pub!.ratingAvg}/${pub!.ratingCount}`);
    report("T15b repeat approve 409 ALREADY_MODERATED", again.status === 409 && again.code === "ALREADY_MODERATED", `status=${again.status} code=${again.code}`);
    // Public PDP now shows it WITH the verified-purchase badge (orderId != null)
    const pdp = await api("GET", `${sf("lumina-living", "aurora-ceramic-vase")}`, null);
    const d = pdp.data as { product: { ratingCount: number }; reviews: { orderId: string | null; rating: number }[] };
    report("T15c published review public + verified badge", d.product.ratingCount === 1 && d.reviews.length === 1 && d.reviews[0].orderId != null && d.reviews[0].rating === 4, `count=${d.product.ratingCount} verified=${d.reviews[0]?.orderId != null}`);
    // Approval did NOT credit a second reward
    const rewardsAisyah = await db.membershipReward.count({ where: { shopperId: aisyahId } });
    report("T15d approval creates NO duplicate reward", rewardsAisyah === 1, `rewards=${rewardsAisyah}`);
  }

  // ============================================================ TEST 16
  // Rejection with auditable reward reversal (proven fraud path).
  {
    const qaId = (await db.shopperUser.findUnique({ where: { email: "qa.shopper@nomofee.test" } }))!.id;
    const rattanId = (await db.product.findFirst({ where: { slug: "rattan-wall-mirror" } }))!.id;
    const review = await db.review.findFirst({ where: { shopperId: qaId, productId: rattanId } });
    // reversal without a reason is rejected
    const noReason = await api("POST", `/api/admin/reviews/${review!.id}`, mod, { action: "reject", reverseReward: true });
    const reject = await api("POST", `/api/admin/reviews/${review!.id}`, mod, { action: "reject", reason: "Fabricated experience — incentive farming", reverseReward: true });
    const reward = await db.membershipReward.findFirst({ where: { reviewId: review!.id } });
    const agg = await db.product.findUnique({ where: { id: rattanId }, select: { ratingCount: true } });
    const audit = await db.activityLog.count({ where: { action: "membership.reward.reversed", entityId: review!.id } });
    report("T16 reversal requires a reason", noReason.status === 400, `status=${noReason.status}`);
    report("T16b reject+reverse OK, reward audited, aggregate clean",
      reject.status === 200 && reward?.reversedAt != null && agg!.ratingCount === 0 && audit === 1,
      `reject=${reject.status} reversed=${reward?.reversedAt != null} agg=${agg!.ratingCount} auditRows=${audit}`);
    // Repeating the reject converges (already moderated)
    const repeat = await api("POST", `/api/admin/reviews/${review!.id}`, mod, { action: "reject", reverseReward: true, reason: "again" });
    report("T16c repeat reject 409", repeat.status === 409, `status=${repeat.status}`);
    // Rejected review never appears publicly
    const pdp = await api("GET", `${sf("lumina-living", "rattan-wall-mirror")}`, null);
    const d = pdp.data as { product: { ratingCount: number }; reviews: unknown[] };
    report("T16d rejected review invisible publicly", d.product.ratingCount === 0 && d.reviews.length === 0, `count=${d.product.ratingCount}`);
  }

  // ============================================================ TEST 17
  // Edit after moderation is frozen.
  {
    const aisyahId = (await db.shopperUser.findUnique({ where: { email: "aisyah@nomofee.test" } }))!.id;
    const auroraId = (await db.product.findFirst({ where: { slug: "aurora-ceramic-vase" } }))!.id;
    const review = await db.review.findFirst({ where: { shopperId: aisyahId, productId: auroraId } });
    const r = await api("PATCH", `/api/me/reviews/${review!.id}`, aisyah, { rating: 1 });
    report("T17 edit after publication frozen 409", r.status === 409 && r.code === "NOT_EDITABLE", `status=${r.status} code=${r.code}`);
  }

  // ============================================================ TEST 18
  // Reward retry after completed flow — no new credits anywhere.
  {
    const rewardsAfter = await db.membershipReward.count();
    const totalExpected = rewardsBefore + 3; // aisyah(1) + qa(rattan) + qa(linen)
    report("T18 exactly 3 new reward rows for 3 real submissions", rewardsAfter === totalExpected, `before=${rewardsBefore} after=${rewardsAfter}`);
    // qa's reward summary: linen active 5 pts, rattan reversed
    const qaId = (await db.shopperUser.findUnique({ where: { email: "qa.shopper@nomofee.test" } }))!.id;
    const summary = await api("GET", "/api/me/reviews", qa);
    const d = summary.data as { rewards: { activePoints: number; activeCount: number; reversedCount: number } };
    report("T18b shopper ledger summary accurate (5 active, 1 reversed)", d.rewards.activePoints === 5 && d.rewards.activeCount === 1 && d.rewards.reversedCount === 1, `active=${d.rewards.activePoints}p/${d.rewards.activeCount} reversed=${d.rewards.reversedCount}`);
  }

  // ====================================================== EXTRA: listing API
  {
    const all = await api("GET", `${sf("glow-theory", "mineral-spf50")}/reviews?sort=recent`, null);
    const one = await api("GET", `${sf("glow-theory", "mineral-spf50")}/reviews?star=1`, null);
    const high = await api("GET", `${sf("bytebazaar", "pulse-anc-earbuds")}/reviews?sort=highest`, null);
    const a = all.data as { reviews: { rating: number }[] };
    const o = (one.data as { reviews: { rating: number }[] });
    const h = (high.data as { reviews: { rating: number }[] });
    const metaOne = (await api("GET", `${sf("glow-theory", "mineral-spf50")}/reviews?star=1&size=5`, null));
    report("X1 listing filter star=1", (one.raw as { meta?: { total: number } }).meta?.total === 1 && o.reviews.every((x) => x.rating === 1), `total=${(one.raw as { meta?: { total: number } }).meta?.total}`);
    report("X2 listing sort=highest ordering", h.reviews.length === 2 && h.reviews[0].rating >= h.reviews[h.reviews.length - 1].rating, `order=${h.reviews.map((x) => x.rating).join(",")}`);
    report("X3 listing default recent", a.reviews.length === 2, `len=${a.reviews.length}`);
    // eligibility probes
    const ea = await api("GET", `${sf("lumina-living", "aurora-ceramic-vase")}/reviews/eligibility`, aisyah);
    const eq = await api("GET", `${sf("lumina-living", "rattan-wall-mirror")}/reviews/eligibility`, qa);
    const anon = await api("GET", `${sf("lumina-living", "aurora-ceramic-vase")}/reviews/eligibility`, null);
    report("X4 eligibility: reviewed shopper shows already_reviewed", (ea.data as { reason: string })?.reason === "already_reviewed", `reason=${(ea.data as { reason: string })?.reason}`);
    report("X5 eligibility: rejected reviewer shows already_reviewed too", (eq.data as { reason: string })?.reason === "already_reviewed", `reason=${(eq.data as { reason: string })?.reason}`);
    report("X6 eligibility: anonymous 401", anon.status === 401, `status=${anon.status}`);
    // aisyah's to-review should now exclude aurora (reviewed) and include nothing else eligible
    const mine = await api("GET", "/api/me/reviews", aisyah);
    const md = mine.data as { toReview: { product: { slug: string } }[]; submitted: { status: string }[] };
    report("X7 me/reviews to-review excludes reviewed product", !md.toReview.some((t) => t.product.slug === "aurora-ceramic-vase"), `toReview=[${md.toReview.map((t) => t.product.slug).join(",")}]`);
  }

  // ---------------------------------------------------------------- summary
  console.log("\n================ RESULTS ================");
  for (const r of results) console.log(r);
  console.log(`\n${pass} passed, ${fail} failed (pre-state: ${reviewsBefore} reviews / ${rewardsBefore} rewards)`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error("SUITE ERROR", e); process.exit(1); }).finally(() => db.$disconnect());
