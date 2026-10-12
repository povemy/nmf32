# TikTok Shop Open Platform Research (Phase 2)

Task ID: p2-tiktok · Researched from official TikTok Shop Partner Center developer docs (live SPA, fetched 2026-10-11). Every claim below is traceable to a source URL in section 5 / inline.

## 1. Method & blockers

- **Docs are JS-rendered SPAs** — `curl` and plain page readers return empty shells. Method used (proven): `agent-browser --session tiktok open <url>` → wait 6–8 s → `eval "document.body.innerText.slice(...)"` in 15 k chunks for guide pages.
- **Reference/API pages**: the rendered page only shows ~22 lines of example JSON and top-level tables. Workaround discovered: every doc page has a **"Download Markdown"** button that exports the *complete* page (full nested schema tables + full example JSON). Tagged the button via `eval` and clicked it programmatically; agent-browser saved the file. Raw copies kept in `~/.cache/tiktok-docs/*.md` (get-product.md 78 KB, search-products.md, rate-limits.md, regions-and-languages.md, create-your-app.md, access-scope.md, tts-webhooks-overview.md, common-errors.md, generate-test-access-token.md).
- **Blockers**:
  - No developer credentials in this sandbox → nothing could be live-tested; everything below is documentation-verified only.
  - Legacy slug `authorization-guide-202309` (linked from "Create your App") returns "No document found" — the current consolidated reference is `authorization-overview-202407` (fetched fine).
  - Rate-limit page publishes **no fixed QPS numbers** (dynamic allocation model) — see §7.
  - Partner Center app console itself (login-gated) not researched — app-registration facts come from the public docs.

## 2. App registration & credentials

Source: https://partner.tiktokshop.com/docv2/page/create-your-app

- Flow: Partner Center → **App & Service → Create app & service** → choose **Public** vs **Custom** app type, service category, name, **Market**, **Seller type** (Local / Cross-border), enable **Enable API**, set **Redirect URL** and **Webhook URL** → Create.
- Market and seller type are creation-time choices ("may not be editable after app creation"). Cross-border seller type "may require additional identifiers such as `shop_cipher`".
- Public apps are store-listed and require review. **Custom apps launch privately via authorization link with no review, UNLESS**: the app category is **Connector**, or it reaches **≥25 seller authorizations** (both apply to a SHOPMESH-style import connector → plan for app review).
- Credentials available afterwards at `App & Service → [app] → App credentials / Basic information`:

| Credential | Use |
|---|---|
| **App Key** | public app identifier; in every signed request (`app_key`) and token calls |
| **App Secret** | secret key for HMAC signing + token calls; **server-side only** |
| **Service ID** | used to build seller authorization links (`?service_id={service_id}`) |

- Env var names a deployer needs (project convention; secrets server-side only, never inline in DB):
  - `TIKTOK_SHOP_APP_KEY`
  - `TIKTOK_SHOP_APP_SECRET`
  - `TIKTOK_SHOP_REDIRECT_URI` (must be pre-registered on the app; receives `?code=...&state=...`)
  - `TIKTOK_SHOP_WEBHOOK_URL` (optional; per-shop webhook target can also be set via API)
  - Per-shop tokens (access/refresh), `shop_id`, `shop_cipher`, `open_id`, `granted_scopes` belong in DB (`MarketplaceConnection`), not env.
- Testing without a live seller: **Development Shops** (`partner-sso.tiktok.com` console → Development Kits → Development Shops → Authorize App) yield a real `code` → token flow for test sellers. Source: https://partner.tiktokshop.com/docv2/page/generate-test-access-token

## 3. Authorisation flow & token lifecycle

Sources: https://partner.tiktokshop.com/docv2/page/authorization-overview-202407 · https://partner.tiktokshop.com/docv2/page/seller-authorization-guide · https://partner.tiktokshop.com/docv2/page/create-your-app

1. **Authorization link** (seller, custom+public apps). Domains by market:
   - US: `https://services.us.tiktokshop.com/open/authorize?service_id={service_id}`
   - ROW: `https://services.tiktokshop.com/open/authorize?service_id={service_id}`
   - Add `state` (recommended, CSRF: unguessable, single-use, validated on callback).
   - Seller clicks Next under their region → logs in → approves → redirect to your Redirect URL: `{redirect_url}?code=FeBoANmHP3yqdoUI9fZOCw&state={state}`; if rejected: `code=null&error=auth_denied`.
   - Alternative for public apps: Seller Center App Store install (`authorization-via-app-store`).
2. **Exchange code → tokens** (server-side): `GET https://auth.tiktok-shops.com/api/v2/token/get?app_key=…&app_secret=…&auth_code=…&grant_type=authorized_code`
   - ⚠️ `grant_type` is literally **`authorized_code`** (not OAuth standard `authorization_code`) — docs call this out twice; wrong spelling fails.
   - **auth_code expires in 30 minutes, single use** (error `36004004` if reused/expired).
   - Response `data`: `access_token` (send as **`x-tts-access-token`** header), `access_token_expire_in` (unix ts; **default validity 7 days**), `refresh_token`, `refresh_token_expire_in` (unix ts; **equals the authorization duration the seller granted**), `open_id`, `seller_name`, `seller_base_region` (e.g. `US`, `ID`), `user_type`, `granted_scopes` (scope keys, e.g. `["seller.product.basic"]`).
   - `user_type`: `0`=Seller, `1`=Creator, `2`=Partner (legacy), `3`=Partner/TAP, `4`/`5`=Global Selling seller. Shop APIs expect **0**.
3. **Refresh**: `GET https://auth.tiktok-shops.com/api/v2/token/refresh?app_key=…&app_secret=…&refresh_token=…&grant_type=refresh_token` — same response shape. Expired/revoked refresh token ⇒ full re-authorization (error handling: `105002` = expired access token).
4. **Bind shops**: call Get Authorized Shops (§5) to map token → shop(s) (`id`, `name`, `region`, `seller_type`, **`cipher`** = shop_cipher needed by product APIs, `code`).
5. **Lifecycle webhooks**: `UPCOMING_AUTHORIZATION_EXPIRATION` fires **30 days before expiry, then daily at 00:00** until reauthorized; `SELLER_DEAUTHORIZATION` on revoke (seller cancels in Seller Center → App Store → My apps and incidents). Sellers renew by re-opening the auth link or re-installing from App Store.

## 4. Request signing (exact algorithm)

Sources: https://partner.tiktokshop.com/docv2/page/sign-your-api-request · https://partner.tiktokshop.com/docv2/page/common-parameters

- **Base/OpenAPI host (all regions, incl. US)**: `https://open-api.tiktokglobalshop.com` — confirmed in every reference example and in the domain table on Create your App ("OpenAPI resource calls — `https://open-api.tiktokglobalshop.com` — US: Same / ROW: Same"). The token host is separate: `https://auth.tiktok-shops.com` (token calls are plain GET query params, **not signed**).
- Common request params:
  - Query: **`app_key`** (required), **`timestamp`** (required; 10-digit Unix seconds; valid window **[now−5 min, now+30 s]**; else `36009004 Invalid timestamp`), **`sign`** (required).
  - Headers: **`x-tts-access-token`** (required for 202309+ APIs; replaces legacy `access_token` query param), `content-type: application/json`.
  - Endpoint-specific: **`shop_cipher`** (required by shop-level APIs, e.g. product; obtained from Get Authorized Shops; error `106013` if missing), `category_asset_cipher` (category-asset endpoints only). If part of the query, they ARE included in the signature.
- Algorithm (HMAC-SHA256, hex output; docs give Go/Java/Node/Python samples):
  1. Take all query params **excluding `sign` and `access_token`**; sort keys alphabetically (ASCII).
  2. Concatenate in order as `{key}{value}` (no delimiters).
  3. **Prepend the request path** (e.g. `/authorization/202309/shops`).
  4. If content-type ≠ `multipart/form-data`, **append the exact raw request body bytes** (never re-serialize JSON for signing).
  5. Wrap: `input = app_secret + input + app_secret`.
  6. `sign = hex( HMAC-SHA256( key=app_secret, msg=input ) )`.
- Worked example from docs (app_secret `e59af819cc`):
  ```
  GET https://open-api.tiktokglobalshop.com/authorization/202309/shops?app_key=29a39d&sign=b596b73e0cc6de07ac26f036364178ab16b0a907af13d43f0a0cd2345f582dc8&timestamp=1623812664
  sign input = e59af819cc + "/authorization/202309/shops" + "app_key29a39d" + "timestamp1623812664" + e59af819cc
  ```
- Common-mistake checklist (verbatim from docs): wrong app_key/secret; `sign`/`access_token` accidentally included; using plain SHA-256 instead of HMAC-SHA256; timestamp outside window; re-serialized JSON body → different signature.
- Webhook verification (inbound) is **different**: `Authorization` header = `hex(HMAC-SHA256(app_key + raw_body, app_secret))`, no `Bearer` prefix; verify with raw body + constant-time compare.

## 5. Endpoint matrix

| Purpose | Method + path | Key request params | Key response fields | Scope | Source URL |
|---|---|---|---|---|---|
| Get access token | GET `https://auth.tiktok-shops.com/api/v2/token/get` | `app_key`, `app_secret`, `auth_code`, `grant_type=authorized_code` (not signed) | `access_token`, `access_token_expire_in` (7 d), `refresh_token`, `refresh_token_expire_in`, `open_id`, `seller_name`, `seller_base_region`, `user_type`, `granted_scopes` | — (app credentials only) | /docv2/page/authorization-overview-202407 |
| Refresh token | GET `https://auth.tiktok-shops.com/api/v2/token/refresh` | `app_key`, `app_secret`, `refresh_token`, `grant_type=refresh_token` | same as above | — | /docv2/page/authorization-overview-202407 |
| List authorized shops | GET `/authorization/202309/shops` | query: `app_key`, `sign`, `timestamp`; header: `x-tts-access-token` | `data.shops[]`: `id`, `name`, `region`, `seller_type` (e.g. `CROSS_BORDER`), **`cipher`** (= shop_cipher), `code` | seller token (user_type 0) | /docv2/page/get-authorized-shops-202309 |
| Search products (catalogue listing) | POST `/product/202309/products/search` | query: `app_key`, `sign`, `timestamp`, **`page_size` (required, 1–100)**, `page_token`, `category_version` (US v2 7-level / other v1 3-level), **`shop_cipher` (required)**; body: `status` (ALL/DRAFT/PENDING/FAILED/ACTIVATE/SELLER_DEACTIVATED/PLATFORM_DEACTIVATED/FREEZE/DELETED/SCHEDULED), `seller_skus[]` (≤10), `create_time_ge/le`, `update_time_ge/le`, `locale` (BCP-47), `include_live_quick_products` | `data.total_count`, `data.next_page_token`, `data.products[]`: `id`, `title`, `status`, `create_time`, `update_time`, `sales_regions[]` (incl. `MY`), `skus[]`: `id`, `seller_sku`, `price{currency, sale_price, tax_exclusive_price}`, `inventory[]{warehouse_id, quantity}`, `fees[]` | **`seller.product.basic`** ("Product Basic") | /docv2/page/search-products-202309 |
| Get product detail | GET `/product/202309/products/{product_id}` | query: `app_key`, `sign`, `timestamp`, **`shop_cipher` (required)**, optional `return_under_review_version`, `return_draft_version` (mutually exclusive), `locale` | full schema — see §6 | **`seller.product.basic`** | /docv2/page/get-product-202309 |
| Configure shop webhook | PUT `/event/202309/webhooks` | query: `app_key`, `sign`, `timestamp`, `shop_cipher`; body: `{"address":"https://…","event_type":"PACKAGE_UPDATE"}` | code/message | shop token | /docv2/page/tts-webhooks-overview |
| (referenced, not fetched) Category rules / attributes / warehouses | Get Category Rules, Get Attributes, Get Warehouse List, Get/Update Shop Webhooks, Upload Product Image | — | — | product-related | referenced from get-product.md / search-products.md |

## 6. Product / variant / image / category fields (Get Product response — verified from full schema)

Source: https://partner.tiktokshop.com/docv2/page/get-product-202309 (schema ^ = data.*)

- **Product core**: `id`, `title` (string), `description` (**HTML** string with `<p>/<ul>/<img>`), `status` (DRAFT/PENDING/FAILED/ACTIVATE/SELLER_DEACTIVATED/PLATFORM_DEACTIVATED/FREEZE/DELETED/SCHEDULED — combines product+audit status), `product_status` (without audit), `brand {id, name}`, `create_time`/`update_time` (unix s), `key_product_features[]` (≤5), `search_terms[]` (≤15), `external_product_id`, `external_urls[]`, `is_cod_allowed` (markets incl. **MY**), `selling_format` (FIXED_PRICE/LIVE_AUCTION/…).
- **Category**: `category_chains[] {id, is_leaf, local_name, parent_id}` (full ancestor tree; root parent_id = `0`), plus `recommended_categories[] {id, local_name}` (AI-suggested from title/desc/images). US shops use 7-level tree (`category_version=v2`), others 3-level (`v1`).
- **Product images**: `main_images[] {height, width, uri, urls[], thumb_urls[]}` (uri = stable CDN object id; urls = full https links on `*.ibyteimg.com`). Same image object shape reused for `size_chart.image`, certification images, etc.
- **Video**: `video {url, cover_url, format (MP4), height, width, size (MB), id}`.
- **Package**: `package_dimensions {length, width, height, unit (CENTIMETER)}`, `package_weight {value, unit (KILOGRAM/POUND)}` (strings).
- **SKUs** (`skus[]`, one per variant):
  - `id`, `seller_sku` (internal code), `external_sku_id`, `identifier_code {type (GTIN/EAN/UPC/ISBN/JAN), code}`, `status_info {status (NORMAL/DEACTIVATED), deactivation_source}`.
  - **Price**: `price {currency, sale_price ("117.5" — local display price before discounts), tax_exclusive_price ("110" — global sellers pre-tax; = sale_price for JP/US-China-warehouse), unit_price (EU), starting_bid_price}` + `list_price {amount, currency}` (US-only verified MSRP/RRP, can render as strikethrough).
  - **Inventory**: `inventory[] {warehouse_id, quantity (1–99 999 in-stock), backorder_quantity, handling_time}` — per warehouse array.
  - **Variants**: `sales_attributes[] {id, name (e.g. "Color"), value_id, value_name (e.g. "Red"), sku_img {…image object…}, supplementary_sku_images[] (US only)}` — i.e. option name/value pairs per SKU, and **variant-specific image (`sku_img`) keyed to the primary sales attribute (usually colour)**.
  - Per-SKU logistics: `sku_dimensions {length,width,height,unit}`, `sku_weight {value,unit}`; limits `purchase_order_quantity_limit {maximum_order_quantity, cumulative_order_quantity}`; presale `pre_sale {type, fulfillment_type}`.
- **Audit block** (TikTok listing review): `audit {status: NONE/AUDITING/FAILED/PRE_APPROVED/APPROVED, pre_approved_reasons[], not_submitted_reasons[]}`, `audit_failed_reasons[] {listing_platform, position, reasons[], suggestions[]}`.
- Mapping to SHOPMESH `Product`/`ProductVariant`/`ProductImage`: title→`title`; description HTML→`description` (needs sanitising); price.sale_price + currency→minor units; sales_attributes[]→option/value JSON; skus[].inventory[] (sum or first warehouse)→stock; main_images[]→ProductImage (urls[0], sortOrder=index); sales_attributes[].sku_img→variant image; category_chains→Category mapping (leaf local_name).

## 7. Pagination, rate limits, markets (MY), webhooks

- **Pagination (Search Products)**: `page_size` **required**, valid **[1–100]**; first page = omit `page_token`; response returns **`next_page_token`** (opaque, e.g. `cGFnZV9udW1iZXI9Mg==`) — pass back as `page_token`. There is **no `has_more` field**; iterate until `next_page_token` absent. `total_count` returned. **Hard cap: total search results cannot exceed 10 000** (error `12052180`) → use `create_time_ge/le` / `update_time_ge/le` windows to walk large catalogues incrementally. Errors `12019108/12019109` = invalid page number/size.
- **Rate limits** (source: /docv2/page/rate-limits): **dynamic QPS allocation — no fixed public numbers, no quota-query API**. Isolation unit = **App ID × Authorized Shop** (plus app/endpoint-level and platform-protective layers). Conservative planning baselines *per App ID × Shop* (not guaranteed): heavy write/complex analytics **0.2–1 rps**; standard write **1–3**; standard read/sync **3–10**; lightweight read/batch **5–20 rps**. Ramp 20–30 % per 10–15 min from the low end. Throttle signals: **HTTP `429`** and/or business code **`36009002`** ("Too many requests"); handle both as throttling; honour `Retry-After`; exponential backoff + jitter (base 1 s, cap ~60 s, ≤5 retries); batch endpoints count as 1 call. `503` ≠ rate limit (retry after short wait).
- **Markets** (source: /docv2/page/regions-and-languages): supported regions = BR, FR, DE, ID, IE, IT, JP, **MY**, MX, PH, SG, ES, TH, GB, US, VN. **Malaysia (MY) is supported; default locale `ms-MY`**; MYR in the SKU `price.currency` enum; COD flag applicable for MY. One global API host serves all regions; region surfaces via shop `region` and `shop_cipher`/`category_asset_cipher` values.
- **Webhooks** (source: /docv2/page/tts-webhooks-overview): shop-level HTTPS POST, configured in Partner Center or via `PUT /event/202309/webhooks`. Product-relevant topics: **`PRODUCT_CREATION`**, **`PRODUCT_INFORMATION_CHANGE`** (title/description/main images/attributes changes go live), **`PRODUCT_STATUS_CHANGE`** (audit results), **`PRODUCT_CATEGORY_CHANGE`**, **`PRODUCT_AUDIT_STATUS_CHANGE`**; connection topics: **`SELLER_DEAUTHORIZATION`**, **`UPCOMING_AUTHORIZATION_EXPIRATION`**. Payload: `{type, tts_notification_id (use for idempotency), shop_id, timestamp, data{…}}`. Signature in `Authorization` header: `HMAC-SHA256(app_key + raw_body, app_secret)` hex, no Bearer. Docs recommend **polling as backup** — webhooks must not be the only source of truth.

## 8. URL-only import feasibility verdict

**Verdict: NOT possible via the official OpenAPI — a seller must authorize the app.** Evidence:

1. Every product-reading endpoint (Search Products, Get Product) documents required header `x-tts-access-token` — *"The seller access_token value from Get Access Token, when user_type = 0"* — plus required scope **`seller.product.basic`**, required query `shop_cipher`, and HMAC signature (sources: /docv2/page/search-products-202309, /docv2/page/get-product-202309). There is **no unauthenticated/public catalogue endpoint** anywhere in the API reference nav (Public/OAuth-only endpoints are limited to token + authorization surfaces).
2. The Access scope page states even "Public"-type scopes still require seller authorization for shop data: *"your app needs to be authorized by the seller before you can access specific shop-related data"* (source: /docv2/page/access-scope).
3. Shop identity itself is authorization-gated: `shop_cipher` (needed by every product call) comes from Get Authorized Shops, which requires the seller token (source: /docv2/page/get-authorized-shops-202309).
4. Docs never describe fetching a product by consumer URL; consumer storefront URLs (`tiktok.com`/`shop.tiktok.com`) are outside the OpenAPI and scraping them would sit outside documented support (and ToS). **Conclusion for SHOPMESH: TikTok connector = OAuth (Custom app → authorization link) → Search + Get Product sync; the "paste a product URL" path is not viable and should be surfaced as OAuth-connect only.**

## 9. Facts verified vs assumptions / unresolved

**Verified (doc-quoted):**
- Base host `https://open-api.tiktokglobalshop.com` (US & ROW identical); token host `https://auth.tiktok-shops.com/api/v2/token/{get,refresh}`; auth entry `https://services{.us}.tiktokshop.com/open/authorize?service_id={service_id}`.
- `grant_type=authorized_code` (sic) / `refresh_token`; auth_code 30-min single-use; access token ≈7 days; refresh token = granted duration; refresh → same response shape.
- Signing: HMAC-SHA256 over `secret + path + sorted{key}{value} + raw_body(except multipart) + secret`; exclude `sign`+`access_token`; `x-tts-access-token` header (202309+) not signed; timestamp window [−5 min, +30 s].
- GET `/authorization/202309/shops` → `shops[]{id,name,region,seller_type,cipher,code}`.
- POST `/product/202309/products/search` (scope `seller.product.basic`): page_size 1–100 required, page_token/next_page_token, total_count, status enum, seller_skus ≤10, search-result cap 10 000 (12052180), locale list incl. `ms-MY`.
- GET `/product/202309/products/{product_id}` full schema: title/description(HTML)/brand/category_chains/main_images/video/package_*/skus[price{currency,sale_price,tax_exclusive_price},inventory[{warehouse_id,quantity}],sales_attributes[{name,value_name,sku_img}],seller_sku,status_info,audit…].
- Rate limiting: dynamic QPS, App ID × Authorized Shop isolation, 429/`36009002`, baselines 0.2–20 rps by API class.
- Regions incl. **MY/ms-MY/MYR**; webhook topics incl. PRODUCT_* and auth-lifecycle; webhook HMAC `app_key+raw_body`.
- Error codes: `36009002` throttle, `105005` scope denied, `105002` token expired, `106001` bad sign, `36009004` family (missing sign/invalid key/bad timestamp/unexpected shop_cipher), `106013` missing shop_cipher, `36004004` bad auth_code, `36009033` IP allowlist.
- App registration: Public vs Custom; Connector category or ≥25 authorizations ⇒ review; credentials = App Key / App Secret / Service ID; Development Shops for testing.

**Assumptions / unresolved:**
- Exact per-endpoint QPS for product endpoints: unknowable by design (dynamic) — implement adaptive throttling, don't hard-code.
- Refresh-token absolute validity for production apps ("authorization duration granted") — actual selectable durations live behind the login-gated console; docs describe renewal via 30-day warning webhook, not a fixed number.
- `has_more` flag: absent on Search Products page; absence treated as "no more pages" signal (high confidence but not explicitly stated as contract).
- Whether `shop_cipher` is required for purely local (non-cross-border) MY shops: docs say required for product endpoints generally and "cross-border shops" in the caveat text; treat as always-required (safe default), verify in sandbox.
- Category-tree endpoints (Get Categories/Get Category Rules) and Upload Product Image referenced but not fetched — needed later for category mapping work.
- Live-call verification impossible in this sandbox (no app credentials) — all above is doc-verified only.
