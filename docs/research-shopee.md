# Shopee Open Platform Research (Phase 2)

Task ID: p2-shopee · Agent: shopee-doc-researcher · Date: 2026 (research session)
Scope: official docs at `open.shopee.com` (V2 API reference + Developer Guides). Everything below marked **[VERIFIED]** was read directly off a fetched docs page; URLs are given per section.

---

## 1. Method & blockers

**Method that worked.** `open.shopee.com` docs are JS-rendered SPAs — `curl` and page-reader return empty shells. Used the headless **agent-browser CLI**:

```bash
agent-browser --session shopee open "<URL>"
sleep 6-8
agent-browser --session shopee eval "document.body.innerText.slice(0, 15000)"   # + further chunks
```

Two page families were crawled:
- **API reference**: `https://open.shopee.com/documents/v2/v2.<api_name>?module=<M>&type=1` — module IDs found by clicking nav items: **AMS=127, Product=89, Shop=92, Public=104**. Each page: description, method+path, Common Request Parameters, request/response tables, examples, error codes, **"API Permissions" (app types allowed)**, update log.
- **Developer guides**: `https://open.shopee.com/developer-guide/<id>` — **12** (dev account registration), **14** (App management), **16** (API calls incl. signing), **20** (Authorization & Authentication), **27** (V2.0 API Call Flow — images only), **702** (Shopee AMS API Integration Guide).
- FAQ (`/faq?categoryId=…`, Debugging=2054) for error_auth table + 429/rate-limit guidance.

**Blockers / inaccessible:**
- **Console (`open.shopee.com` → "Console") is login-walled** — actual App Key values, Go Live forms and callback-domain config screens could not be inspected; documented from the *App management* / *Developer account registration* guides instead.
- **"Shopee Markets" footer link** is a heading with no crawlable content (external/JS).
- **Exact numeric rate limits (QPS) are not published** anywhere we crawled — only the HTTP 429 handling guidance (see §7).
- The doc-tree nav is click-handler driven (no anchors); page URLs had to be discovered by clicking + reading `window.location.href`.

---

## 2. App registration & credentials

Source: https://open.shopee.com/developer-guide/12 and /developer-guide/14 — **[VERIFIED]**

1. Sign up at open.shopee.com (email + verification code; email immutable) → submit profile for approval.
2. **Account types**: `Individual Seller` (no business license, serves only own shop), `Registered Business Seller` (licensed, own shop), `Third-party Partner Platform (ISV)` (licensed business serving other sellers).
3. **App types** (each maps to fixed API permission sets): ERP System, Product Management, Order Management, Accounting and Finance, Marketing, **Seller In-house System** ("Use this App type if you are a Shopee seller managing your own Apps"), Customer Service, Ads Service. A `Custom APP` type also appears in per-API permission lists.
4. **Create App** in Console → on success you get **Test Partner ID + Test Key** (sandbox only). After **Go Live** submission, review ≈24h → **Live Partner_id and Live Key** "under the App Key section". Max **10 Apps** per account; an App may authorize shops across different markets; no shop-count limit.
5. App statuses: `Developing` (cannot authorize shops or call prod APIs) / `Online` / `New App authorizations restricted` / `API calls restricted` / `Suspended`.
6. Keys can be reset from App edit page; deleting an App invalidates partner ID/Key **and all existing shop authorizations**.
7. **MY (Malaysia) seller eligibility** for Open Platform access — verbatim: "MY (Malaysia) — Mall Sellers OR Registered Business Sellers OR Sellers with minimum 1 order in L12M". (SG: Mall/Managed or ≥30 orders/30d; TW: Mall only; ID: Mall/Managed or ≥30 orders/30d; VN: Preferred/Mall; PH: Mall/Managed or ≥600 orders/30d; BR: registered business + ≥1 order/30d.)
8. ISV criteria: registered business, **live product with existing ecommerce integrations + trial account**, HTTPS + TLS 1.2 + security rating "A"; "Your services should not include … extracting listing information to enable transactions outside of Shopee" (Platform Partner Rules) — relevant constraint for an import tool operated by third parties.

**Suggested env vars** (names are ours; values come from the Console App page):

| Env var | Meaning |
|---|---|
| `SHOPEE_PARTNER_ID` | partner_id (test vs live pair — pick by `SHOPEE_ENV`) |
| `SHOPEE_PARTNER_KEY` | partner_key (secret, used as HMAC-SHA256 key) |
| `SHOPEE_SHOP_ID` | authorised shop_id (returned in auth redirect / GetAccessToken) |
| `SHOPEE_ENV` | `sandbox` \| `live` → host selection (§7) |
| `SHOPEE_REDIRECT_URI` | callback URL for the authorisation link |
| `SHOPEE_ACCESS_TOKEN` / `SHOPEE_REFRESH_TOKEN` | per-shop token pair (4h / 30d, refresh rotates) |
| `SHOPEE_REGION` | `MY` etc. (informational; `region` also returned by `shop.get_shop_info`) |

---

## 3. Authorisation flow & token lifecycle

Sources: https://open.shopee.com/developer-guide/20 (Authorization and Authentication, updated 2026-07-23) + API refs `v2.public.get_access_token`, `v2.public.refresh_access_token` — **[VERIFIED]**

**Step 1 — authorisation link** (fixed URL + params):

```
https://open.shopee.com/auth?partner_id={partner_id}&auth_type=seller&redirect_uri={url}&response_type=code
```

- `auth_type`: `seller` (shop/merchant) | `supplier` | `user`. Optional `state` (CSRF).
- Production: `https://open.shopee.com/auth` (global ex-CN/BR), `https://open.shopee.cn/auth` (CN), `https://open.shopee.com.br/auth` (BR). Sandbox: `https://open.sandbox.test-stable.shopee.com/auth` (+ `.cn`/`.com.br` variants).
- redirect_uri domain **must match the Redirect URL Domain configured in the Console** ("The domain of redirect_uri is not consistent with the Redirect URL Domain declared in console" otherwise).
- ⚠️ verbatim: "The timestamp used to calculate the sign is only valid for 5 minutes. After the timestamp and the sign expire, the authorization link will no longer be valid" — i.e. the link itself carries `timestamp`+`sign`.

**Step 2 — seller authorises.** Seller logs in (shop account = single shop; main account = multiple shops/merchants; sub-accounts cannot authorise) and picks validity: **7 / 30 / 90 / 180 / 365 days** or custom within **365 days max**. Redirect carries:

```
https://{redirect_uri}/?code=xxxxxxxxxx&shop_id=xxxxxx      # shop-account auth
https://{redirect_uri}/?code=xxxxxx&main_account_id=xxxxxx  # main-account auth
```

**Step 3 — exchange code → tokens.**

| | GetAccessToken | RefreshAccessToken |
|---|---|---|
| Method/Path | **POST** `https://partner.shopeemobile.com/api/v2/auth/token/get` | **POST** `https://partner.shopeemobile.com/api/v2/auth/access_token/get` |
| Query (common) | `partner_id`, `timestamp`, `sign` (Public-API signing, no access_token/shop_id) | same |
| Body | `code` (one-time, **expires 10 min**), `partner_id`, `shop_id` **or** `main_account_id` | `refresh_token`, `partner_id`, `shop_id` (or merchant/supplier/user/principal_id — refreshed separately) |
| Response | `access_token`, `refresh_token`, `expire_in`, `shop_id_list[]`, `merchant_id_list[]`, `supplier_id_list[]`, `user_id_list[]`, `principal_id_list[]` | `access_token` (new), `refresh_token` (**new**), `expire_in`, echo of ids |

**Lifecycle rules (verbatim where marked):**
- "The access_token is a dynamic token required for calling non-public APIs. It is valid for **4 hours** and can be used multiple times."
- "The refresh_token is valid for **30 days**" and is **single-use** — "Each refresh_token … can only be used once by either a shop_id or merchant_id …"; each refresh returns a **new refresh_token** that must be used next ("Please use the new refresh_token for the next RefreshAccessToken call").
- "After a new access_token is generated, the previous access_token will remain valid for another **5 minutes**."
- "The RefreshAccessToken API must be called within the authorization validity period." Authorisation expiry itself (≤365d) requires seller re-authorisation; `expire_time` is returned by `shop.get_shop_info` and `public.get_shops_by_partner`.
- Store tokens **per shop_id/merchant_id**; initial main-account tokens are shared across authorised shops until first per-shop refresh (then they fork permanently).
- Re-authorisation refreshes both tokens.
- API refs confirm the same numbers: access_token "expires after 4 hours", refresh_token "valid … for 30 days"; `expire_in` sample `14400` s = 4 h.

**Token errors seen in refs/FAQ:** `invalid_code` ("The code is expired or used or invalid"), `refresh_token_expired`, `shop_access_expired`, `shop_no_linked`, `shop_banned`, `error_shop_refresh_token`, `source_ip_undeclared` (IP whitelist must be declared in Console; max 1000 IPs).

---

## 4. Request signing (exact algorithm)

Source: https://open.shopee.com/developer-guide/16 ("API calls" → "Signature calculation") — **[VERIFIED, incl. worked examples]**

**Step 1 — build the base string** by concatenating, *strictly in this order*, the API path (no host) + common params:

| API type | Base string order |
|---|---|
| **Shop API** | `partner_id` + `api_path` + `timestamp` + `access_token` + `shop_id` |
| **Merchant API** | `partner_id` + `api_path` + `timestamp` + `access_token` + `merchant_id` |
| **Public API** | `partner_id` + `api_path` + `timestamp` |

Worked example from the docs (Shop API): partner_id `2001887`, path `/api/v2/shop/get_shop_info`, timestamp `1655714431`, access_token `59777174636562737266615546704c6d`, shop_id `14701711` →
`Base string = 2001887/api/v2/shop/get_shop_info165571443159777174636562737266615546704c6d14701711`

**Step 2 — HMAC-SHA256** with the **partner_key** (from Console App detail page) over the base string; output is a **hex-encoded string** (lowercase; Java demo uses `String.format("%032x", sign)`).

Docs code (Python):
```python
base_string = "%s%s%s%s%s" % (partner_id, path, timest, access_token, shop_id)  # Shop API
sign = hmac.new(partner_key, base_string, hashlib.sha256).hexdigest()
url = host + path + "?partner_id=%s&shop_id=%s&timestamp=%s&access_token=%s&sign=%s" % (...)
```

Notes:
- `timestamp` = unix seconds, "valid for 5 minutes" (each request must be within 5 min of its timestamp).
- Request params are **never** part of the signature — only the fields above.
- GET: all params in query string. POST: common params in query, request params in JSON body (`Content-Type: application/json`); `partner_id` goes in the **query**, not the body, for POST (FAQ: "no partner id in the query").
- The two auth endpoints (`/api/v2/auth/token/get`, `/api/v2/auth/access_token/get`) are signed as **Public APIs**: base string = `partner_id + path + timestamp` (confirmed in the demo code on developer-guide/20).
- Response envelope always has `request_id`, `error` (empty on success), `message`, optional `warning`, `response`.

---

## 5. Endpoint matrix

All production paths are under `https://partner.shopeemobile.com` (alt hosts: `openplatform.shopee.cn` for CN-deployed devs, `openplatform.shopee.com.br` for US-deployed; sandbox `https://openplatform.sandbox.test-stable.shopee.sg`). "Common" = `partner_id, timestamp, sign, access_token, shop_id` (Shop API) or `partner_id, timestamp, sign` (Public API).

| Purpose | Method + path | Key request params | Key response fields | Source (fetched) |
|---|---|---|---|---|
| Exchange auth code for tokens | POST `/api/v2/auth/token/get` (Public signing) | query: partner_id, timestamp, sign; body: code, partner_id, shop_id \| main_account_id | access_token (4h), refresh_token (30d), expire_in, shop_id_list, merchant_id_list | /documents/v2/v2.public.get_access_token?module=104&type=1 ; /developer-guide/20 |
| Refresh tokens (rotating) | POST `/api/v2/auth/access_token/get` (Public signing) | query: partner_id, timestamp, sign; body: refresh_token, partner_id, shop_id | access_token, **new** refresh_token, expire_in | /documents/v2/v2.public.refresh_access_token?module=104&type=1 ; /developer-guide/20 |
| List shops authorised to this app | GET `/api/v2/public/get_shops_by_partner` (Public signing) | page_no, page_size | authed_shop_list[] {shop_id, region, auth_time, expire_time}, sip_affi_shop_list[], more | /documents/v2/v2.public.get_shops_by_partner?module=104&type=1 |
| Shop identity / auth window | GET `/api/v2/shop/get_shop_info` (Shop) | — (common only) | shop_name, region, status (BANNED/FROZEN/NORMAL), auth_time, expire_time, is_cb, merchant_id, is_sip, is_main_shop/is_direct_shop, shop_fulfillment_flag | /documents/v2/v2.shop.get_shop_info?module=92&type=1 |
| Shop profile (logo/branding) | GET `/api/v2/shop/get_profile` (Shop) | — | response.shop_logo (image URL), response.shop_name, response.description (update via `shop.update_profile`, fields shop_logo/description/shop_name) | /documents/v2/v2.shop.get_profile?module=92&type=1 |
| Category tree (for mapping) | GET `/api/v2/product/get_category` (Shop) | language (MY: en/ms-my/zh-hans) | category_list[] {category_id, parent_category_id, original_category_name, display_category_name, has_children} | /documents/v2/v2.product.get_category?module=89&type=1 |
| **List item IDs of the shop** | GET `/api/v2/product/get_item_list` (Shop) | offset (req), page_size (req, **max 100**), item_status[] (req: NORMAL/BANNED/UNLIST/REVIEWING/SELLER_DELETE/SHOPEE_DELETE), update_time_from/to | item[] {item_id, item_status, update_time}, total_count, **has_next_page, next_offset** | /documents/v2/v2.product.get_item_list?module=89&type=1 |
| Item detail (title/desc/price/img) | GET `/api/v2/product/get_item_base_info` (Shop) | item_id_list (≤50), need_tax_info?, need_complaint_policy? | item_list[]: item_id, category_id, item_name, description(+description_info extended), item_sku, attribute_list[], price_info[] (currency, original_price, current_price, inflated_*), image{image_url_list[], image_id_list[]}, weight, dimension, stock_info_v2{summary_info.total_available_stock, seller_stock[], shopee_stock[]}, condition (NEW/USED), item_status (NORMAL/BANNED/UNLIST/SELLER_DELETE/SHOPEE_DELETE/REVIEWING), has_model, has_promotion, brand, video_info[], pre_order, wholesales, logistics… | /documents/v2/v2.product.get_item_base_info?module=89&type=1 |
| Item engagement stats | GET `/api/v2/product/get_item_extra_info` (Shop) | item_id_list (≤50) | item_list[] {item_id, sale, views, likes, rating_star, comment_count} | /documents/v2/v2.product.get_item_extra_info?module=89&type=1 |
| **Variants** of an item | GET `/api/v2/product/get_model_list` (Shop) | item_id | tier_variation[] {name, option_list[] {option, image{image_id,image_url}}}; model[] {model_id, tier_index[], price_info[] (currency, current_price, original_price), model_sku, model_status (MODEL_NORMAL/MODEL_UNAVAILABLE), stock_info_v2 (summary_info.total_available_stock, seller_stock[]), weight, dimension, gtin_code}; standardise_tier_variation[] | /documents/v2/v2.product.get_model_list?module=89&type=1 |
| *Spec's starting endpoint* — products enrolled in affiliate Open Campaign | GET `/api/v2/ams/get_open_campaign_added_product` (**AMS app type only**) | page_size (1–100), cursor, sort_by (commission_rate/−), search_type ITEM_NAME/ITEM_ID, search_content (≤50 ids) | item_list[] {item_id, item_name, campaign_id, campaign_status (Upcoming/Ongoing/Terminating), commission_rate, period_start/end_time, commission_protection_list[]}, total_count, cursor, has_more | /documents/v2/v2.ams.get_open_campaign_added_product?module=127&type=1 |

Note: the catalogue list API is **`product.get_item_list`** — there is **no** `product.get_product_list` in V2 (the task brief's guessed name doesn't exist; the nav tree confirms). Other nearby APIs: `product.search_item`, `product.get_variations`, `product.get_attribute_tree`, `product.get_brand_list` (all Shop APIs, module 89).

---

## 6. Product / variant / image / category fields available (import mapping)

**[VERIFIED] field names** from §5 sources. Mapping to our normalised schema (`Product`/`ProductVariant`/`ProductImage` in `prisma/schema.prisma`):

| Our field | Shopee source | Notes |
|---|---|---|
| `title` | `get_item_base_info` → `item_name` | "Name of the item in local language" |
| `description` | `item_description` field `description` (normal) or `description_info.extended_description.field_list[]` (extended: text/image fields, `description_type`) | HTML-ish; extended descriptions can embed images |
| `price` (compare/current) | `price_info[]`: `original_price`, `current_price` (promo price if under promotion), `currency`; per-model on `get_model_list` → `model[].price_info[]` | **If item has models, item-level price_info is NOT returned** — must read per model. SG/MY/BR/MX/PL/ES/AR support 2-decimal prices, others integer |
| `ProductVariant` | `get_model_list` → `model[]` (model_id, model_sku, model_status, price_info, stock_info_v2) + `tier_variation[]` (variation names + `option_list[].option` + option images); `model[].tier_index[]` maps model → option index per tier | e.g. tier_index [0,1] = option 0 of tier 1 + option 1 of tier 2 |
| `ProductImage` | `get_item_base_info` → `image.image_url_list[]` / `image_id_list[]` (+ `image_ratio`); variant option images at `tier_variation[].option_list[].image`; promotion images `promotion_image` | URLs are CDN (e.g. `cf.shopee.sg/file/...`); shop logo via `shop.get_profile.shop_logo` |
| `stock` | `stock_info_v2.summary_info.total_available_stock` (item & model level), `seller_stock[]` (location_id, stock, if_saleable), `total_reserved_stock` | |
| categories | `category_id` on item + `product.get_category` tree (category_id, parent_category_id, names, has_children); attributes via `attribute_list[]` (attribute_id, original_attribute_name, is_mandatory, attribute_value_list[]) | language param for MY: en/ms-my/zh-hans |
| `condition` | `condition` ("NEW/USED — Is it second-hand") | |
| status | `item_status` (NORMAL/BANNED/UNLIST/REVIEWING/SELLER_DELETE/SHOPEE_DELETE) + model_status | filter list calls by NORMAL/UNLIST |
| sku | `item_sku` (parent) + `model[].model_sku` | |
| extras | `brand`, `weight` (KG), `dimension` (package L/W/H cm), `video_info[]`, `pre_order`, `has_promotion`, `logistic_info[]`, `sale/views/likes/rating_star` (extra_info) | |

Image import caveat: Shopee CDN URLs are hotlinkable but rotate-by-id; our house rule "all demo imagery stays on `/api/img`" → download/rehost at import time.

---

## 7. Pagination, rate limits, markets

**Pagination (two styles, both [VERIFIED]):**
- `product.get_item_list`: **offset/limit** — required `offset` (int64, default 0) + `page_size` (**max = 100**; changelog 2022-03-28 "page size update.Max=100"); response `has_next_page` (bool) + `next_offset` (int64) → "if has_next_page is true, this value need set to next request.offset"; `total_count` returned. Time-window filter `update_time_from/to` enables incremental sync.
- `ams.get_open_campaign_added_product` + `get_item_base_info`-style batch lists: **cursor** style — `page_size` 1–100, response `cursor` ("Pass the content in the next request as cursor to get the next page data") + `has_more`.
- `public.get_shops_by_partner`: page_no/page_size + `more` bool.

**Rate limits:**
- No published numeric QPS. FAQ (Debugging, /faq?categoryId=2054): "When your API calls reach the limit, you will receive an **HTTP 429** … please adjust the setting for the number of requests per second (**QPS**) and reduce the call frequency appropriately … avoid frequent retry operations"; continued abuse → restrictions, lift via support ticket. **Treat as assumption**: self-throttle well below e.g. 10 QPS for import loops and back off exponentially on 429.
- Push/webhook limits (not our use-case) do publish numbers (600 pushes/6h, <70% success → warning).

**Hosts & environments [VERIFIED, /developer-guide/16 + /20]:** production `partner.shopeemobile.com` (SG-adjacent), `openplatform.shopee.cn` (CN devs), `openplatform.shopee.com.br` (US-adjacent); sandbox `openplatform.sandbox.test-stable.shopee.sg` (+ `.cn`); sandbox auth `open.sandbox.test-stable.shopee.com/auth`; sandbox Test Partner ID/Key only.

**Markets:** Open Platform regions appearing in docs: SG, MY, TH, VN, PH, TW, ID, BR, MX, CO, CL (+ CB-KR/CB-JP/CB-CN cross-border; ES/FR/PL local sunsets noted in error_auth list — "shop_market_offline … ES/FR/PL region"). **MY is fully supported**: seller eligibility (§2.7), category languages `en / ms-my / zh-hans`, 2-decimal pricing, `advance_stock` for "PH/VN/ID/MY local selected shops". `shop.get_shop_info.region` returns e.g. `MY` — use it to pin import locale/currency (MYR).

---

## 8. URL-only import feasibility verdict + the spec's campaign endpoint

### Verdict: a public shop URL alone CANNOT import a catalogue via the official API — **[VERIFIED, multiple independent evidence]**

1. **Every catalogue API is a Shop API.** /developer-guide/16: "This means that Shop and Merchant APIs can be called only after the shop has granted authorization." Shop APIs require `access_token` + `shop_id` (and both are inside the signed base string) — there is no public/read-only catalogue endpoint anywhere in the V2 nav tree (checked the full Product/Shop/Public categories).
2. **No URL/sluge-based lookup exists.** `public.*` contains only: `get_shops_by_partner`, `get_merchants_by_partner`, `get_access_token`, `refresh_access_token`, `get_token_by_resend_code`, `get_shopee_ip_ranges` — none takes a shop URL or returns catalogue data.
3. **The only door in is the authorisation-code flow** (§3): the seller must log in at `open.shopee.com/auth?partner_id=…&auth_type=seller&…`, confirm, and the app receives `code` → tokens. Seller-picked validity ≤365 days; revocable any time (Seller Center / changing the auth URL).
4. Even scraping-side workarounds are contract-risky: Platform Partner Rules (quoted in dev-registration criteria) explicitly forbid ISVs whose services include "extracting listing information to enable transactions outside of Shopee" — so a compliant product must drive sellers through authorisation.
   → **Product implication (SHOPMESH):** the Shopee connector must be an *authorised-connection* importer (seller clicks auth link → we store tokens per shop → pull `get_item_list` → `get_item_base_info`/`get_model_list`), not a paste-a-URL importer. A URL field can at most pre-fill the shop's region/slug for display after authorisation.

### The spec's starting endpoint `v2.ams.get_open_campaign_added_product` is NOT a catalogue importer — **[VERIFIED]**

- API description (verbatim): "**Retrieve all products currently in the Open Campaign**, including campaign status, commission rate, and promotion period."
- AMS guide (/developer-guide/702): "Open Campaigns: Sellers can **open their shop's products for public affiliate promotion**, allowing creators to freely select and promote items"; the endpoint "Retrieve[s] all products currently in the Open Campaign and ready to be picked up by any affiliates to promote at any time." Its response fields are campaign bookkeeping (`campaign_id`, `campaign_status` Upcoming/Ongoing/Terminating, `commission_rate`, `period_start/end_time`, `commission_protection_list`) — no description/images/stock/variants.
- **Gated twice**: (a) "APP types that can call this API: **Affiliate Marketing Solution Management**" only; (b) business errors: "Sorry you don't have access to AMS features" and "Please agree to the AMS T&C in Seller Center - Affiliate Marketing Solutions first before using Open API." It also still requires a normal authorised shop (common params include access_token/shop_id) and returns only what the seller *chose* to enrol in affiliate promotion — neither a full catalogue nor an unauthorised feed.
- **Recommendation:** drop it from the import spec; the correct chain is `public.get_shops_by_partner` → `shop.get_shop_info`/`get_profile` → `product.get_item_list` → `product.get_item_base_info` (+`get_item_extra_info` optional) → `product.get_model_list` per item with `has_model=true`, with `product.get_category` for taxonomy mapping.

---

## 9. Facts verified vs assumptions / unresolved

**Verified (read directly from fetched official pages, with URLs in body):**
1. Signing: base string per API type (Shop: partner_id+path+timestamp+access_token+shop_id; Public: +timestamp only), HMAC-SHA256 with partner_key, hex digest, 5-min timestamp window, request params excluded from signature (/developer-guide/16, with worked example).
2. Auth link format `https://open.shopee.com/auth?partner_id&auth_type&redirect_uri&response_type=code`; redirect returns `code`+`shop_id`/`main_account_id`; code one-time/10 min.
3. GetAccessToken = POST `/api/v2/auth/token/get`; RefreshAccessToken = POST `/api/v2/auth/access_token/get` (both reference page header AND guide demo code agree).
4. access_token 4 h multi-use; refresh_token 30 d single-use and rotating (new one each refresh, shown in sample `expire_in=14400`); old access_token stays alive 5 min after refresh; authorisation validity seller-chosen ≤365 days.
5. Shop-level catalogue APIs and paths: `get_item_list` (offset/page_size≤100/item_status required/has_next_page+next_offset), `get_item_base_info` (≤50 item_ids; full field set incl. price_info/image/stock_info_v2/condition/item_status/has_model), `get_item_extra_info` (sale/views/likes/rating_star), `get_model_list` (tier_variation + model with price/stock/sku/status/weight), `shop.get_shop_info` (shop_name/region/status/auth_time/expire_time), `shop.get_profile` (shop_logo/shop_name/description), `product.get_category` (tree + MY languages).
6. `ams.get_open_campaign_added_product` = affiliate Open Campaign listing (purpose verbatim; AMS app type only; AMS T&C errors; cursor pagination).
7. Shop/Merchant/Public API taxonomy; catalogue data only after shop authorisation (explicit guide quote).
8. App registration: Test/Live Partner ID+Key, Go-Live ≈24 h review, ≤10 apps, app statuses, key reset, Seller In-house System type for own-shop tools.
9. MY market supported (eligibility: Mall OR Registered Business OR ≥1 order in L12M; languages en/ms-my/zh-hans; 2-decimal prices).
10. Production/sandbox hosts incl. `partner.shopeemobile.com` and sandbox test-stable domains; `public.get_shops_by_partner` lists authorised shops with `expire_time`.
11. Rate limiting exists as HTTP 429 + QPS guidance; IP whitelist (≤1000 IPs, `source_ip_undeclared`); error_auth catalogue incl. `refresh_token_expired`, `shop_access_expired`.
12. Response envelope `{request_id, error, message, warning?, response}` on every call.

**Assumptions / unresolved:**
- **Numeric QPS/rate-limit values** — not published in any crawled page; must be discovered empirically in sandbox, or via a support ticket.
- Console internals (exact Console screens for partner_key display, callback-domain config, IT-asset declaration) — behind login; UI flow reconstructed from guides only.
- Whether unlisted/legacy paths like `/api/v2/public/get_access_token` (alias of `/auth/token/get`) work — reference page header says `/api/v2/auth/token/get`; use that.
- Sandbox data quality/coverage for MY shops (sandbox shops may be synthetic) — needs hands-on testing.
- Push/webhook push notifications for product changes — documented separately (Push Mechanism guide) but not crawled in depth here; import v1 can rely on `update_time_from` polling instead.
- Shopee "Shopee Markets" marketing page content (market-specific notes beyond eligibility table) — not crawlable.
