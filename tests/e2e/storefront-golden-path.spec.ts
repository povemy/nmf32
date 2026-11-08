// ============================================================================
// E2E #1 — Anonymous shopper golden path (desktop viewport).
// ----------------------------------------------------------------------------
// Drives the real UI through the marketplace's critical purchase funnel and
// verifies BOTH halves of the data contract on every hop:
//   • the backend payloads match src/lib/types/api-contract.ts EXACTLY
//     (deep runtime validation of every key/type — no missing, no extra);
//   • the frontend actually renders the values those payloads carry
//     (product-card accessible names, result counts, PDP title/price, cart
//     drawer lines are all derived FROM the captured payload and matched
//     against the DOM).
// Plus the global sweep: every /api JSON response of the whole session must
// use the platform envelope ({data[,meta]} | {error:{code,message,…}}).
// ============================================================================
import { test, expect } from "@playwright/test";
import type { AddCartItemData, PdpData, SfProductCard } from "../../src/lib/types/api-contract";
import {
  ApiRecorder,
  expectOkEnvelope,
  expectPagedEnvelope,
  formatMinor,
  sweepEnvelopes,
  vAddCartItemData,
  vGetCartData,
  vMarketHomeData,
  vMarketSuggestData,
  vMeAnonymousData,
  vPdpData,
  vSfAppConfigData,
  vSfCartSettingsData,
  vSfProductCard,
  vSfReviewsListData,
  vStockProbeData,
  vArray,
} from "./contract";

/** The accessible name every ProductCard button carries (ui-bits.tsx). */
const cardLabelOf = (p: SfProductCard): string => `${p.title} from ${p.storeName}, ${formatMinor(p.priceMinor)}`;

test("anonymous shopper: home → search → PDP → guest add-to-cart — payloads match api-contract.ts", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 800 });

  const rec = new ApiRecorder();
  rec.attach(page);
  await page.goto("/");

  // ---- 1. boot identity: anonymous variant of GET /api/auth/me ------------
  const meBoot = await rec.waitFor("GET /api/auth/me (anonymous boot)", (c) => c.url.pathname === "/api/auth/me" && c.method === "GET");
  const me = expectOkEnvelope(meBoot, vMeAnonymousData, "GET /api/auth/me (anonymous)");
  expect(me.userType).toBeNull();

  // ---- 2. marketplace landing aggregate ------------------------------------
  const homeRes = await rec.waitFor("GET /api/market/home", (c) => c.url.pathname === "/api/market/home" && c.method === "GET");
  const home = expectOkEnvelope(homeRes, vMarketHomeData, "GET /api/market/home");

  const homeProducts: SfProductCard[] = [
    ...home.featured,
    ...home.latest,
    ...home.trending,
    ...home.flashDeals.products,
    ...home.inline.flatMap((m) => m.products),
  ];
  expect(homeProducts.length, "the landing payload must surface products (featured/latest/trending/flash/inline)").toBeGreaterThan(0);
  // domain sanity on the aggregate the UI is about to render
  for (const p of homeProducts) {
    expect(p.ratingAvg, `${p.title} ratingAvg must be a 0–5 average`).toBeGreaterThanOrEqual(0);
    expect(p.ratingAvg).toBeLessThanOrEqual(5);
  }

  // ---- 3. DOM ⇠ payload: rendered cards are built FROM the home payload ----
  const cardButtons = page.locator('button[aria-label*=" from "][aria-label*=", RM "]');
  await expect(cardButtons.first()).toBeVisible({ timeout: 45_000 });
  const renderedCount = await cardButtons.count();
  expect(renderedCount, "the storefront grid should render several product cards").toBeGreaterThanOrEqual(3);

  const firstCardLabel = (await cardButtons.first().getAttribute("aria-label")) ?? "";
  const labelMatch = homeProducts.some((p) => cardLabelOf(p) === firstCardLabel);
  expect(
    labelMatch,
    `the first rendered card must be an exact payload product (accessible name "${firstCardLabel}" should equal "«title» from «store», RM …" of a /api/market/home product)`,
  ).toBe(true);

  // ---- 4. search flow: paged listing envelope + UI total ⇠ meta.total ------
  const searchTarget = home.latest[0] ?? homeProducts[0];
  expect(searchTarget).toBeDefined();
  const searchInput = page.getByLabel("Search for products, brands and more");
  await expect(searchInput).toBeVisible();
  await searchInput.fill(searchTarget.title);
  await searchInput.press("Enter");

  const productsRes = await rec.waitFor("GET /api/market/products", (c) => c.url.pathname === "/api/market/products" && c.method === "GET");
  const { data: rows, meta } = expectPagedEnvelope(productsRes, vArray(vSfProductCard), "GET /api/market/products");
  expect(rows.length, "the search must return at least one product card").toBeGreaterThan(0);
  expect(meta.page).toBe(1);
  expect(meta.size).toBeGreaterThanOrEqual(rows.length);
  expect(meta.total, "meta.total must cover the returned page").toBeGreaterThanOrEqual(rows.length);
  expect(
    rows.some((p) => p.id === searchTarget.id),
    `searching the exact title of "${searchTarget.title}" must surface that product`,
  ).toBe(true);

  // the results header shows the payload's own total — UI ⇠ payload agreement
  await expect(page.getByText(new RegExp(`^${meta.total} products? found$`))).toBeVisible({ timeout: 30_000 });

  // ---- 5. PDP hop with a purchasable-product fallback loop -----------------
  // The first result may be multi-variant or out of stock; a real shopper
  // simply taps the next card — the loop mirrors that until an add succeeds.
  let addedCart: AddCartItemData | null = null;
  let addedPdp: PdpData | null = null;
  let lastAddError: unknown = null;

  for (const candidate of [rows.find((p) => p.id === searchTarget.id) ?? rows[0], ...rows.filter((p) => p.id !== searchTarget.id).slice(0, 3)]) {
    try {
      const label = cardLabelOf(candidate);
      await page.getByRole("button", { name: label, exact: true }).first().click();

      const pdpRes = await rec.waitFor(
        `GET /api/sf/${candidate.storeSlug}/products/${candidate.slug}`,
        (c) => c.url.pathname === `/api/sf/${candidate.storeSlug}/products/${candidate.slug}` && c.method === "GET",
      );
      const pdp = expectOkEnvelope(pdpRes, vPdpData, `GET /api/sf/${candidate.storeSlug}/products/${candidate.slug}`);
      expect(pdp.product.id, "the PDP must describe the card that was clicked").toBe(candidate.id);

      // UI ⇠ payload: identity block renders the payload title, price block renders payload price
      await expect(page.locator('section[aria-label="Product details"]')).toContainText(pdp.product.title, { timeout: 30_000 });
      await expect(page.getByText(formatMinor(pdp.product.priceMinor)).first()).toBeVisible();

      if (pdp.product.variants.length === 0) throw new Error(`product ${candidate.slug} has no variants`);
      if (pdp.product.variants.length === 1) {
        const only = pdp.product.variants[0];
        if (!only.isActive || only.stock <= 0) throw new Error(`product ${candidate.slug} single variant is unpurchasable`);
        await page
          .getByRole("button", { name: "Add to cart", exact: true })
          .filter({ visible: true })
          .first()
          .click();
      } else {
        // multi-option product: the CTA opens the variant sheet first
        await page
          .getByRole("button", { name: "Select options", exact: true })
          .filter({ visible: true })
          .first()
          .click();
        const sheet = page.getByRole("dialog");
        await expect(sheet).toBeVisible({ timeout: 15_000 });
        await sheet.locator('[role="radio"]:not([aria-disabled="true"])').first().click({ timeout: 10_000 });
        await sheet.getByRole("button", { name: "Add to cart", exact: true }).click();
      }

      const addRes = await rec.waitFor(
        "POST /api/cart/items",
        (c) => c.url.pathname === "/api/cart/items" && c.method === "POST",
      );
      const added = expectOkEnvelope(addRes, vAddCartItemData, "POST /api/cart/items");
      if (!added.cart.items.some((it) => it.productId === pdp.product.id)) {
        throw new Error(`the returned cart does not contain the added product ${pdp.product.id}`);
      }
      addedCart = added;
      addedPdp = pdp;
      break;
    } catch (e) {
      lastAddError = e;
    }
  }

  if (!addedCart || !addedPdp) {
    throw lastAddError instanceof Error ? lastAddError : new Error("no purchasable product among the first search results");
  }

  // ---- 6. cart payload cross-field invariants (guest token cart) ----------
  // line totals and per-store rollups must be arithmetic the frontend can trust
  for (const it of addedCart.cart.items) {
    expect(it.lineTotalMinor, `${it.title} lineTotalMinor must equal unitPriceMinor × qty`).toBe(it.unitPriceMinor * it.qty);
    expect(it.qty).toBeGreaterThanOrEqual(it.moq);
  }
  for (const store of addedCart.cart.stores) {
    const lines = addedCart.cart.items.filter((it) => it.storeId === store.storeId);
    expect(lines.length, `store ${store.storeName} rollup must reference its line items`).toBeGreaterThan(0);
    expect(store.itemCount).toBe(lines.length);
    expect(store.subtotalMinor).toBe(lines.reduce((sum, it) => sum + it.lineTotalMinor, 0));
  }
  // a guest add mints a token-keyed cart — the token is echoed for guests
  expect(addedCart.cart.token, "guest cart view must echo its token").toBeTruthy();

  // ---- 7. cart drawer opens and renders the payload line -------------------
  const settingsRes = await rec.waitFor(
    "GET /api/sf/[slug]/cart-settings (cart drawer)",
    (c) => c.url.pathname.endsWith("/cart-settings") && c.method === "GET",
  );
  expectOkEnvelope(settingsRes, vSfCartSettingsData, "GET /api/sf/[slug]/cart-settings");
  await expect(page.getByRole("dialog").last()).toContainText(addedPdp.product.title, { timeout: 15_000 });

  // ---- 8. optional-but-expected auxiliary endpoints ------------------------
  const appConfig = rec.first((c) => c.url.pathname === "/api/sf/app-config" && c.method === "GET");
  if (appConfig) expectOkEnvelope(appConfig, vSfAppConfigData, "GET /api/sf/app-config");

  const suggest = rec.first((c) => c.url.pathname === "/api/market/search/suggest" && c.method === "GET");
  if (suggest) expectOkEnvelope(suggest, vMarketSuggestData, "GET /api/market/search/suggest");

  // The cart endpoint is read several times per session (boot, badge refresh,
  // drawer) — EVERY read must conform to GetCartData.
  const cartGets = rec.all().filter((c) => c.url.pathname === "/api/cart" && c.method === "GET");
  for (const c of cartGets) expectOkEnvelope(c, vGetCartData, `GET /api/cart${c.url.search}`);

  const reviewsGet = rec.first(
    (c) => /\/products\/[^/]+\/reviews$/.test(c.url.pathname) && c.method === "GET",
  );
  if (reviewsGet) expectPagedEnvelope(reviewsGet, vSfReviewsListData, "GET /api/sf/[slug]/products/[pSlug]/reviews");

  const stockGet = await rec
    .waitFor("GET /api/cart/stock (drawer items)", (c) => c.url.pathname === "/api/cart/stock" && c.method === "GET", 20_000)
    .catch(() => null);
  if (stockGet) expectOkEnvelope(stockGet, vStockProbeData, "GET /api/cart/stock");

  // ---- 9. global envelope sweep over EVERY captured /api response ----------
  const problems = sweepEnvelopes(rec.all());
  expect(problems, `every /api JSON response must use the platform envelope:\n${problems.join("\n")}`).toEqual([]);

  const captured = rec.all().map((c) => `${c.method} ${c.url.pathname} [${c.status}]`);
  console.log(
    `[contract] anonymous golden path — ${captured.length} /api responses swept, ` +
      `deep-validated: auth/me(anon), market/home (${homeProducts.length} product cards), ` +
      `market/products (${rows.length}/${meta.total} rows), sf PDP, POST cart/items, cart-settings` +
      `${reviewsGet ? ", reviews" : ""}${stockGet ? ", cart/stock" : ""}, ${cartGets.length}× cart` +
      `${suggest ? ", suggest" : ""}`,
  );
});
