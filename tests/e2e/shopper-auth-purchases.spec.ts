// ============================================================================
// E2E #2 — Shopper sign-in → identity → purchases hub (mobile viewport).
// ----------------------------------------------------------------------------
// The authentication critical path, UI-driven end to end:
//   • open the header sign-in dialog (which itself probes the sandbox-only
//     dev-accounts panel endpoint — validated too);
//   • submit real credentials through the UnifiedAuthPanel (the SAME form
//     every portal uses — POST /api/auth/unified-login);
//   • assert the shopper success variant of the contract EXACTLY
//     (userType/shopper/token/claimed/emailVerified/guestCartMerged);
//   • assert the post-login identity round-trip (GET /api/auth/me →
//     MeShopperData) agrees with the login payload (same shopper id);
//   • land on the purchases hub and deep-validate GET /api/me/orders —
//     the paged composite OrdersData with all six bucket counts and every
//     order-summary field — then prove the UI renders the payload's own
//     order numbers.
// Plus the global envelope sweep over every captured /api response.
// ============================================================================
import { test, expect } from "@playwright/test";
import {
  ApiRecorder,
  bodyHasUserType,
  expectOkEnvelope,
  expectPagedEnvelope,
  sweepEnvelopes,
  vDevAccountsData,
  vMeAnonymousData,
  vMeShopperData,
  vOrdersData,
  vUnifiedShopperData,
} from "./contract";

/** Seeded sandbox demo buyer (GET /api/auth/dev-accounts — dev-only panel). */
const BUYER_EMAIL = "aisyah@nomofee.test";
const BUYER_PASSWORD = "NOMOFEE123!";

test("shopper sign-in → identity + purchases — payloads match api-contract.ts", async ({ page }) => {
  test.setTimeout(240_000);
  // Mobile surface: the BottomNav (Home/Orders/Cart/Earn/Chat/Me) is the
  // primary navigation below md — this also exercises the responsive layout.
  await page.setViewportSize({ width: 390, height: 844 });

  const rec = new ApiRecorder();
  rec.attach(page);
  await page.goto("/");

  // ---- 1. anonymous boot identity ------------------------------------------
  const meBoot = await rec.waitFor("GET /api/auth/me (anonymous boot)", (c) => c.url.pathname === "/api/auth/me" && c.method === "GET");
  const meAnon = expectOkEnvelope(meBoot, vMeAnonymousData, "GET /api/auth/me (anonymous)");
  expect(meAnon.userType).toBeNull();

  // ---- 2. open the unified sign-in dialog ----------------------------------
  await page.getByRole("button", { name: "Sign in to NOMOFEE" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // The dialog mounts the sandbox-only DevAccountsPanel — its endpoint is
  // part of the contract surface the login dialog depends on.
  const devAccountsRes = await rec.waitFor(
    "GET /api/auth/dev-accounts (sandbox panel)",
    (c) => c.url.pathname === "/api/auth/dev-accounts" && c.method === "GET",
    30_000,
  );
  const devAccounts = expectOkEnvelope(devAccountsRes, vDevAccountsData, "GET /api/auth/dev-accounts");
  expect(devAccounts.accounts.length, "the sandbox panel must list the seeded accounts").toBeGreaterThan(0);

  // ---- 3. submit real credentials through UnifiedAuthPanel ----------------
  await dialog.locator('input[type="email"]').fill(BUYER_EMAIL);
  await dialog.locator('input[type="password"]').fill(BUYER_PASSWORD);
  await dialog.locator('form button[type="submit"]').click();

  const loginRes = await rec.waitFor(
    "POST /api/auth/unified-login",
    (c) => c.url.pathname === "/api/auth/unified-login" && c.method === "POST",
  );
  const login = expectOkEnvelope(loginRes, vUnifiedShopperData, "POST /api/auth/unified-login");
  expect(login.shopper.email, "the session belongs to the credentials just submitted").toBe(BUYER_EMAIL);
  expect(login.token, "a session token must be minted").not.toBe("");
  expect(login.guestCartMerged, "guestCartMerged is a count — an integer ≥ 0 by contract").toBeGreaterThanOrEqual(0);
  expect(login.claimed.ordersClaimed).toBeGreaterThanOrEqual(0);

  // ---- 4. post-login identity round-trip -----------------------------------
  const meAfter = await rec.waitFor(
    "GET /api/auth/me (shopper variant)",
    (c) => c.url.pathname === "/api/auth/me" && c.method === "GET" && bodyHasUserType(c, "shopper"),
  );
  const me = expectOkEnvelope(meAfter, vMeShopperData, "GET /api/auth/me (shopper)");
  expect(me.shopper.id, "auth/me must agree with the login payload's shopper id").toBe(login.shopper.id);
  expect(me.shopper.fullName).toBe(login.shopper.fullName);

  // the dialog is gone — the signed-in surface took over
  await expect(dialog).toBeHidden({ timeout: 20_000 });

  // ---- 5. purchases hub via the mobile bottom nav --------------------------
  await page.getByRole("button", { name: "Orders" }).click();

  const ordersRes = await rec.waitFor(
    "GET /api/me/orders",
    (c) => c.url.pathname === "/api/me/orders" && c.method === "GET",
  );
  const { data: orders, meta } = expectPagedEnvelope(ordersRes, vOrdersData, "GET /api/me/orders");

  // seeded demo buyer has real purchase history — the hub has content to show
  expect(orders.orders.length, "the demo buyer must have orders to render").toBeGreaterThan(0);
  expect(meta.total).toBeGreaterThanOrEqual(orders.orders.length);
  expect(meta.size).toBeGreaterThanOrEqual(orders.orders.length);

  // bucket roll-ups: exactly the six contract buckets, sums consistent
  expect(Object.keys(orders.bucketCounts).sort()).toEqual([
    "cancelled",
    "completed",
    "to_pay",
    "to_rate",
    "to_receive",
    "to_ship",
  ]);
  const bucketSum = Object.values(orders.bucketCounts).reduce((s, n) => s + n, 0);
  expect(bucketSum, "bucket counts must partition the same order set the total describes").toBe(meta.total);

  // order-level domain sanity: money invariants the UI relies on
  for (const o of orders.orders) {
    expect(o.orderNumber, "order numbers use the NM-* format").toMatch(/^NM-/);
    expect(o.totalMinor).toBeGreaterThan(0);
    expect(o.items.length).toBeGreaterThan(0);
    for (const it of o.items) expect(it.qty).toBeGreaterThan(0);
  }

  // UI ⇠ payload: the hub renders the payload's own newest order number
  await expect(page.getByText(orders.orders[0].orderNumber).first()).toBeVisible({ timeout: 30_000 });

  // The hub may hit this endpoint more than once per session (me-hub-cache
  // warms bucket counts with a ?size=1 probe alongside the paged list) —
  // give the extra read a moment to land, then EVERY captured response of
  // the session must conform to the same contract.
  await rec
    .waitFor(
      "second GET /api/me/orders (cache-warm probe)",
      (c) => c.url.pathname === "/api/me/orders" && c.method === "GET" && c !== ordersRes,
      15_000,
    )
    .catch(() => null);
  const allOrdersResponses = rec.all().filter((c) => c.url.pathname === "/api/me/orders" && c.method === "GET");
  expect(allOrdersResponses.length).toBeGreaterThanOrEqual(1);
  for (const c of allOrdersResponses) {
    const { data: d, meta: m } = expectPagedEnvelope(c, vOrdersData, `GET /api/me/orders${c.url.search}`);
    for (const o of d.orders) expect(o.orderNumber).toMatch(/^NM-/);
    // bucketCounts is always scope-independent (computed across ALL statuses);
    // it partitions the order set exactly when the fetch is unfiltered.
    if (!c.url.searchParams.has("bucket")) {
      const sum = Object.values(d.bucketCounts).reduce((s, n) => s + n, 0);
      expect(sum, `unfiltered me/orders (${c.url.search}) total must equal the six-bucket partition`).toBe(m.total);
    }
  }

  // ---- 6. global envelope sweep over EVERY captured /api response ----------
  const problems = sweepEnvelopes(rec.all());
  expect(problems, `every /api JSON response must use the platform envelope:\n${problems.join("\n")}`).toEqual([]);

  const captured = rec.all().map((c) => `${c.method} ${c.url.pathname} [${c.status}]`);
  console.log(
    `[contract] shopper auth path — ${captured.length} /api responses swept, ` +
      `deep-validated: auth/me(anon→shopper), auth/dev-accounts (${devAccounts.accounts.length} accounts), ` +
      `unified-login (shopper variant, guestCartMerged=${login.guestCartMerged}), ` +
      `${allOrdersResponses.length}× me/orders (newest list: ${orders.orders.length}/${meta.total} shown, buckets sum=${bucketSum})`,
  );
});
