// ============================================================================
// WORK ORDER 14 E2E — Homepage × Admin Campaign integration, run against the
// LIVE dev server (http://127.0.0.1:3000) and its real database. Covers the
// ten mandated admin→homepage scenarios PLUS archive + layout-order controls:
//
//   T1  Draft festive campaign (hero placement) never appears publicly.
//   T2  Scheduled campaign stays hidden before its start time, becomes
//       eligible the moment the window opens (start moved past "now").
//   T3  Published campaign appears on the homepage with the correct image,
//       heading, subtext, CTA label and destination.
//   T4  Placement change (hero → showcase) is reflected.
//   T5  Expired campaign disappears automatically (end moved past "now").
//   T6  Deactivated (unpublished) campaign disappears.
//   T7  Mobile banner: desktop + mobile creatives both exposed, distinct.
//   T8  Campaign landing destinations resolve server-side (category, store,
//       search keywords, external https) and INVALID destinations are
//       rejected at write time (400).
//   T9  Cache invalidation: an update reaches the public homepage within the
//       documented window (tag bust ⇒ seconds; 60 s TTL is the ceiling).
//   T10 Product integrity: flash deals only contain genuinely discounted
//       active products; homepage presentation never mutates price/stock.
//   T11 Archive: archived campaign vanishes from every public surface, sits
//       in the admin "archived" filter, restores cleanly.
//   T12 Homepage layout: section order save/normalize/restore through the
//       admin API and the public payload.
//
// Everything goes through the REAL admin API → real database → real public
// aggregate. NO mocked homepage data. Fixtures are [LT14]-tagged and cleaned
// up. Writes: docs/staging/evidence/homepage-campaign-e2e.json
// ============================================================================
// @ts-nocheck
import { readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.LT_BASE ?? "http://127.0.0.1:3000";
const RUN = Date.now().toString(36);
const TAG = "[LT14]";
const PASSWORD = "Lt14Ops!pass";

const { db } = await import("../../src/lib/db");
const { hashPasswordAsync } = await import("../../src/lib/password");
const { base32Decode, totpCode, totpCounterAt } = await import("../../src/lib/mfa");
const { check, summary, exitCode } = await import("./lib");

const evidence = { runId: RUN, base: BASE, steps: [] as unknown[] };
const step = (name: string, detail: unknown) => {
  (evidence.steps as unknown[]).push({ name, detail });
  console.log(`[LT14] ${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function fetchHome() {
  const r = await api("GET", "/api/market/home");
  if (r.status !== 200 || r.json?.data == null || typeof r.json.data !== "object") {
    // Error/invalid responses must NEVER satisfy a poll — treat as not-ready.
    return null;
  }
  return r.json.data;
}

/** Every public surface a campaign can appear on. */
function campaignIdsIn(home) {
  const ids = new Set<string>();
  for (const s of home.hero ?? []) if (s.id && !s.id.startsWith("banner:")) ids.add(s.id);
  for (const t of home.heroSecondary ?? []) ids.add(t.id);
  for (const t of home.promoTiles ?? []) ids.add(t.id);
  for (const c of home.showcase ?? []) ids.add(c.id);
  for (const m of home.inline ?? []) ids.add(m.id);
  return ids;
}

/** Poll the public homepage until `pred` holds (cache propagation window).
 *  Transient errors are retried; a persistently failing endpoint times out. */
async function pollHome(pred, label, timeoutMs = 75_000) {
  const t0 = Date.now();
  let lastError = "";
  for (let i = 0; i < 150; i++) {
    try {
      const home = await fetchHome();
      if (home && pred(home)) return { home, ms: Date.now() - t0 };
      if (home) lastError = "predicate false";
      else lastError = "non-200/invalid response";
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await sleep(1500);
  }
  throw new Error(`pollHome timeout (${label}) after ${Date.now() - t0}ms — last: ${lastError}`);
}

const now = () => new Date();
const iso = (d: Date) => d.toISOString();
const minutes = (n: number) => n * 60 * 1000;

async function main() {
  step("run", `base=${BASE} runId=${RUN}`);

  // ── ops admin (campaigns.manage) — the ops role holds money caps, so the
  // mandatory MFA enrollment gate applies to EVERY admin route: enroll +
  // confirm TOTP, then re-login through the MFA challenge (same flow the
  // phase3-step4 suite uses for its finance admin). ────────────────────────
  const email = `lt14-ops-${RUN}@nomofee.test`;
  await db.adminUser.create({
    data: { email, name: "LT14 Ops", role: "ops", isActive: true, passwordHash: await hashPasswordAsync(PASSWORD) },
  });
  const li0 = await api("POST", "/api/auth/login", { body: { email, password: PASSWORD, portal: "admin" } });
  const enroll = await api("POST", "/api/admin/mfa/enroll", { token: li0.json?.data?.token, body: { password: PASSWORD } });
  const secret = base32Decode(String(enroll.json?.data?.secretBase32 ?? ""));
  const confirm = await api("POST", "/api/admin/mfa/confirm", {
    token: li0.json?.data?.token,
    body: { password: PASSWORD, code: totpCode(secret, totpCounterAt(Math.floor(Date.now() / 1000))) },
  });
  if (confirm.status !== 200) throw new Error(`MFA confirm failed: ${confirm.status}`);
  // TOTP single-use: wait for the NEXT 30s window before the verify login.
  await sleep(Math.max(0, 30_100 - (Date.now() % 30_000)));
  const li1 = await api("POST", "/api/auth/login", { body: { email, password: PASSWORD, portal: "admin" } });
  const verify = await api("POST", "/api/auth/mfa/verify", {
    body: { challenge: li1.json?.data?.challenge, code: totpCode(secret, totpCounterAt(Math.floor(Date.now() / 1000))) },
  });
  const token = verify.json?.data?.token;
  check("admin login (ops role, campaigns.manage, MFA-verified)", li0.status === 200 && Boolean(token), `login=${li0.status} verify=${verify.status}`);
  if (!token) throw new Error("no admin token — aborting");

  // RBAC probe: anonymous callers must NOT manage campaigns.
  const anon = await api("POST", "/api/admin/campaigns", { body: { name: "x", startAt: iso(now()), endAt: iso(new Date(now().getTime() + minutes(60))) } });
  check("public visitors cannot create campaigns (401)", anon.status === 401, `status=${anon.status}`);

  // Baseline product snapshot for T10.
  const watchSlugs = ["pulse-anc-earbuds", "aurora-ceramic-vase", "barrier-repair-serum"];
  const before = await db.product.findMany({
    where: { slug: { in: watchSlugs } },
    select: { id: true, slug: true, priceMinor: true, salesCount: true, status: true, variants: { select: { id: true, priceMinor: true, compareAtPriceMinor: true, stock: true } } },
  });
  const beforeMap = new Map(before.map((p) => [p.slug, JSON.stringify(p)]));

  const mkBody = (over = {}) => ({
    name: `${TAG} Campaign ${RUN}`,
    startAt: iso(new Date(now().getTime() - minutes(60))),
    endAt: iso(new Date(now().getTime() + minutes(60 * 24))),
    isPublished: false,
    placement: "showcase",
    ...over,
  });

  // ── T1: draft stays private ──────────────────────────────────────────────
  const draft = await api("POST", "/api/admin/campaigns", { token, body: mkBody({ name: `${TAG} Draft Hero ${RUN}`, placement: "hero", bannerDesktopUrl: `/api/img/lt14-draft?w=1400&h=480&label=Draft` }) });
  const draftId = draft.json?.data?.id;
  check("T1 draft campaign created (unpublished)", draft.status === 200 && Boolean(draftId), `status=${draft.status}`);
  {
    const { home } = await pollHome((h) => Array.isArray(h.hero), "fresh read");
    check("T1 draft is INVISIBLE on the public homepage", !campaignIdsIn(home).has(draftId));
  }

  // ── T2: scheduled stays hidden until the window opens ────────────────────
  const sched = await api("POST", "/api/admin/campaigns", { token, body: mkBody({ name: `${TAG} Scheduled ${RUN}`, isPublished: true, startAt: iso(new Date(now().getTime() + minutes(120))), endAt: iso(new Date(now().getTime() + minutes(600))) }) });
  const schedId = sched.json?.data?.id;
  {
    const { home } = await pollHome((h) => Array.isArray(h.hero), "scheduled read");
    check("T2 scheduled campaign hidden before start", !campaignIdsIn(home).has(schedId));
  }
  const schedPatch = await api("PATCH", `/api/admin/campaigns/${schedId}`, { token, body: { startAt: iso(new Date(now().getTime() - minutes(1))) } });
  check("T2 window-open PATCH accepted", schedPatch.status === 200, `status=${schedPatch.status}`);
  {
    const { ms } = await pollHome((h) => campaignIdsIn(h).has(schedId), "scheduled→live");
    check("T2 campaign eligible the moment its window opens", true, `propagated in ${ms}ms`);
    evidence.scheduledPropagationMs = ms;
  }

  // ── T3 + T7: published hero campaign with desktop/mobile creatives ───────
  const desktopUrl = `/api/img/lt14-hero-desk-${RUN}?w=1400&h=480&label=Desktop`;
  const mobileUrl = `/api/img/lt14-hero-mob-${RUN}?w=800&h=480&label=Mobile`;
  const hero = await api("POST", "/api/admin/campaigns", {
    token,
    body: mkBody({
      name: `${TAG} Published Hero ${RUN}`,
      placement: "hero",
      isPublished: true,
      priority: 100, // outranks everything → first slide
      description: "T3 landing description",
      ctaLabel: "Shop the LT14 sale",
      ctaHref: "search:earbuds",
      bannerDesktopUrl: desktopUrl,
      bannerMobileUrl: mobileUrl,
      theme: { greeting: "LT14 Mega Sale", tagline: "Work order 14 verification" },
    }),
  });
  const heroId = hero.json?.data?.id;
  check("T3 published hero campaign created", hero.status === 200 && Boolean(heroId), `status=${hero.status}`);
  {
    const { home } = await pollHome((h) => (h.hero ?? []).some((s) => s.id === heroId), "hero visible");
    const slide = home.hero.find((s) => s.id === heroId);
    check("T3 hero slide is the FIRST slide (priority)", home.hero[0]?.id === heroId);
    check("T3 heading from theme greeting", slide?.title === "LT14 Mega Sale", `title=${slide?.title}`);
    check("T3 subtext from description", slide?.subtext === "T3 landing description", `subtext=${slide?.subtext}`);
    check("T3 CTA label", slide?.ctaLabel === "Shop the LT14 sale", `label=${slide?.ctaLabel}`);
    check("T3 CTA destination resolved server-side", JSON.stringify(slide?.cta) === JSON.stringify({ kind: "search", q: "earbuds" }), `cta=${JSON.stringify(slide?.cta)}`);
    check("T7 desktop creative exposed", slide?.imageUrl === desktopUrl, `imageUrl=${slide?.imageUrl}`);
    check("T7 mobile creative exposed and distinct", slide?.mobileImageUrl === mobileUrl && mobileUrl !== desktopUrl, `mobile=${slide?.mobileImageUrl}`);
  }

  // ── T8: destination kinds + write-side rejection ─────────────────────────
  const dests = [
    { href: "category:electronics", want: { kind: "category", slug: "electronics" } },
    { href: "store:bytebazaar", want: { kind: "store", slug: "bytebazaar" } },
    { href: "https://example.com/lt14", want: { kind: "external", url: "https://example.com/lt14" } },
  ];
  const destIds: string[] = [];
  for (const d of dests) {
    const r = await api("POST", "/api/admin/campaigns", { token, body: mkBody({ name: `${TAG} Dest ${d.href} ${RUN}`, isPublished: true, placement: "showcase", ctaHref: d.href }) });
    const id = r.json?.data?.id;
    destIds.push(id);
    const { home } = await pollHome((h) => (h.showcase ?? []).some((c) => c.id === id), `dest ${d.href}`);
    const card = home.showcase.find((c) => c.id === id);
    check(`T8 destination ${d.href} resolves`, JSON.stringify(card?.cta) === JSON.stringify(d.want), `cta=${JSON.stringify(card?.cta)}`);
  }
  const badDest = await api("POST", "/api/admin/campaigns", { token, body: mkBody({ name: `${TAG} Bad dest ${RUN}`, ctaHref: "javascript:alert(1)" }) });
  check("T8 javascript: destination rejected (400)", badDest.status === 400, `status=${badDest.status}`);
  const badPlacement = await api("POST", "/api/admin/campaigns", { token, body: mkBody({ name: `${TAG} Bad placement ${RUN}`, placement: "sidebar" }) });
  check("T8 unknown placement rejected (400)", badPlacement.status === 400, `status=${badPlacement.status}`);

  // ── T4: placement change ────────────────────────────────────────────────
  await api("PATCH", `/api/admin/campaigns/${heroId}`, { token, body: { placement: "showcase", priority: 0 } });
  {
    const { home } = await pollHome((h) => (h.showcase ?? []).some((c) => c.id === heroId) && !(h.hero ?? []).some((s) => s.id === heroId), "hero→showcase");
    check("T4 placement change reflected (hero → showcase)", (home.showcase ?? []).some((c) => c.id === heroId) && !(home.hero ?? []).some((s) => s.id === heroId));
  }

  // ── T9: cache invalidation timing on an UPDATE ───────────────────────────
  const renamed = `${TAG} Renamed Hero ${RUN}`;
  await api("PATCH", `/api/admin/campaigns/${heroId}`, { token, body: { name: renamed, placement: "hero", priority: 100 } });
  {
    const { home, ms } = await pollHome((h) => (h.hero ?? []).some((s) => s.id === heroId && s.name === renamed), "rename propagation");
    check("T9 update reaches the public homepage within the documented window", ms <= 70_000, `propagated in ${ms}ms (ceiling 70s; tag-bust makes it seconds, 60s TTL is the worst case)`);
    evidence.renamePropagationMs = ms;
    // T9b: the update ALSO changed the placement back — verify.
    check("T9b concurrent placement change also reflected", (home.hero ?? []).some((s) => s.id === heroId));
  }

  // ── T5: expiry ───────────────────────────────────────────────────────────
  const expirePatch = await api("PATCH", `/api/admin/campaigns/${heroId}`, { token, body: { endAt: iso(new Date(now().getTime() - minutes(1))) } });
  check("T5 expiry PATCH accepted", expirePatch.status === 200, `status=${expirePatch.status}`);
  {
    const { home } = await pollHome((h) => !campaignIdsIn(h).has(heroId), "expired disappears");
    check("T5 expired campaign disappears automatically", !campaignIdsIn(home).has(heroId));
  }

  // ── T6: deactivate ──────────────────────────────────────────────────────
  const t6a = await api("PATCH", `/api/admin/campaigns/${heroId}`, { token, body: { endAt: iso(new Date(now().getTime() + minutes(600))), isPublished: true } });
  check("T6 republish PATCH accepted", t6a.status === 200, `status=${t6a.status}`);
  await pollHome((h) => campaignIdsIn(h).has(heroId), "republished for T6");
  const t6b = await api("PATCH", `/api/admin/campaigns/${heroId}`, { token, body: { isPublished: false } });
  check("T6 deactivate PATCH accepted", t6b.status === 200, `status=${t6b.status}`);
  {
    const { home } = await pollHome((h) => !campaignIdsIn(h).has(heroId), "deactivated disappears");
    check("T6 deactivated campaign removed from the homepage", !campaignIdsIn(home).has(heroId));
  }

  // ── T11: archive lifecycle ──────────────────────────────────────────────
  const t11a = await api("PATCH", `/api/admin/campaigns/${heroId}`, { token, body: { isPublished: true } });
  check("T11 republish PATCH accepted", t11a.status === 200, `status=${t11a.status}`);
  await pollHome((h) => campaignIdsIn(h).has(heroId), "republished for T11");
  const t11b = await api("PATCH", `/api/admin/campaigns/${heroId}`, { token, body: { archived: true } });
  check("T11 archive PATCH accepted", t11b.status === 200, `status=${t11b.status}`);
  {
    const { home } = await pollHome((h) => !campaignIdsIn(h).has(heroId), "archived disappears");
    check("T11 archived campaign vanishes from every public surface", !campaignIdsIn(home).has(heroId));
  }
  {
    const archivedList = await api("GET", `/api/admin/campaigns?status=archived&q=${encodeURIComponent(TAG)}`, { token });
    const defaultList = await api("GET", `/api/admin/campaigns?q=${encodeURIComponent(TAG)}`, { token });
    check("T11 archived filter lists it; default list excludes it", (archivedList.json?.data ?? []).some((c) => c.id === heroId) && !(defaultList.json?.data ?? []).some((c) => c.id === heroId));
  }
  const t11c = await api("PATCH", `/api/admin/campaigns/${heroId}`, { token, body: { archived: false } });
  check("T11 unarchive PATCH accepted", t11c.status === 200, `status=${t11c.status}`);
  {
    const { home } = await pollHome((h) => campaignIdsIn(h).has(heroId), "restored");
    check("T11 unarchive restores public visibility", campaignIdsIn(home).has(heroId));
  }

  // ── T12: homepage layout order ──────────────────────────────────────────
  const customOrder = ["hero", "trending", "quick_access", "showcase"];
  const putOrder = await api("PUT", "/api/admin/home-layout", { token, body: { order: customOrder } });
  check("T12 layout save accepted", putOrder.status === 200, `status=${putOrder.status}`);
  {
    const { home } = await pollHome((h) => JSON.stringify(h.sectionOrder) === JSON.stringify(customOrder), "layout propagates");
    check("T12 public homepage follows the saved section order", JSON.stringify(home.sectionOrder) === JSON.stringify(customOrder), `order=${JSON.stringify(home.sectionOrder)}`);
  }
  {
    const junk = await api("PUT", "/api/admin/home-layout", { token, body: { order: ["bogus", "trending", "trending"] } });
    check("T12 invalid order is normalized server-side (hero forced)", JSON.stringify(junk.json?.data?.order) === JSON.stringify(["hero", "trending"]), `order=${JSON.stringify(junk.json?.data?.order)}`);
    const anonPut = await api("PUT", "/api/admin/home-layout", { body: { order: ["hero"] } });
    check("T12 public visitors cannot change the layout (401)", anonPut.status === 401, `status=${anonPut.status}`);
  }
  // restore default
  await api("PUT", "/api/admin/home-layout", { token, body: { order: ["hero", "quick_access", "showcase", "flash_deals", "categories", "trending", "featured", "stores", "new_arrivals"] } });

  // ── T10: product integrity ──────────────────────────────────────────────
  {
    const { home } = await pollHome((h) => Array.isArray(h.flashDeals?.products) && Array.isArray(h.trending), "final read for T10");
    const deals = home.flashDeals?.products ?? [];
    check("T10 flash deals populated from genuinely discounted products", deals.length > 0, `${deals.length} products`);
    let allHonest = true;
    for (const p of deals) {
      if (!(p.compareAtPriceMinor != null && p.compareAtPriceMinor > p.priceMinor)) allHonest = false;
    }
    check("T10 every flash deal carries a REAL compare-at above the selling price", allHonest);
    const trending = home.trending ?? [];
    check("T10 trending only lists products with real sales", trending.length > 0 && trending.every((p) => p.salesCount > 0), `${trending.length} products`);

    // No price/stock drift on the watched products after ALL campaign churn.
    const after = await db.product.findMany({
      where: { slug: { in: watchSlugs } },
      select: { id: true, slug: true, priceMinor: true, salesCount: true, status: true, variants: { select: { id: true, priceMinor: true, compareAtPriceMinor: true, stock: true } } },
    });
    let unchanged = true;
    for (const p of after) {
      if (beforeMap.get(p.slug) !== JSON.stringify(p)) unchanged = false;
    }
    check("T10 homepage presentation mutated NO product price/stock/sales data", unchanged);

    // Cross-check one deal against the authoritative listing API.
    const deal = deals.find((p) => p.slug === "pulse-anc-earbuds");
    if (deal) {
      const listed = await api("GET", `/api/market/products?search=pulse&size=5`);
      const row = (listed.json?.data ?? []).find((p) => p.slug === "pulse-anc-earbuds");
      check("T10 flash-deal price equals the listing API price", Boolean(row) && row.priceMinor === deal.priceMinor, `deal=${deal.priceMinor} listing=${row?.priceMinor}`);
    } else {
      check("T10 flash-deal price equals the listing API price", false, "pulse not in deals");
    }
  }

  // ── cleanup ─────────────────────────────────────────────────────────────
  const mine = await db.campaign.findMany({ where: { name: { contains: TAG } }, select: { id: true, name: true } });
  for (const c of mine) await db.campaign.delete({ where: { id: c.id } }).catch(() => {});
  await db.adminUser.delete({ where: { email } }).catch(() => {});
  step("cleanup", `removed ${mine.length} [LT14] campaigns + ops admin; layout restored to default`);
  {
    // Direct DB deletion bypasses the API cache-busting, so the public cache
    // may serve deleted campaigns for up to the 60 s TTL — poll it out.
    const { home } = await pollHome((h) => ![...campaignIdsIn(h)].some((id) => mine.some((m) => m.id === id)), "cleanup propagation", 75_000);
    check("cleanup: no [LT14] campaign remains on the public homepage", ![...campaignIdsIn(home)].some((id) => mine.some((m) => m.id === id)));
    check("cleanup: default section order restored", JSON.stringify(home.sectionOrder) === JSON.stringify(["hero", "quick_access", "showcase", "flash_deals", "categories", "trending", "featured", "stores", "new_arrivals"]));
  }

  writeFileSync("docs/staging/evidence/homepage-campaign-e2e.json", JSON.stringify(evidence, null, 2));
  await db.$disconnect();
  const failures = summary("WORK ORDER 14 — homepage × campaign E2E");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("[LT14] FATAL:", e);
  // Best-effort cleanup even on fatal errors.
  try {
    const mine = await db.campaign.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    for (const c of mine) await db.campaign.delete({ where: { id: c.id } }).catch(() => {});
    await db.adminUser.delete({ where: { email: `lt14-ops-${RUN}@nomofee.test` } }).catch(() => {});
    await db.$disconnect();
  } catch {}
  process.exit(1);
});
