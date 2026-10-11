// Shopee Open Platform V2 connector (Phase 5) — implements the OFFICIAL contract
// verified in docs/research-shopee.md:
//   - signing: HMAC-SHA256(partner_id + api_path + timestamp + access_token? + shop_id?, partner_key)
//   - authorisation: open.shopee.com/auth → one-time code → /api/v2/auth/token/get (4h/30d)
//   - catalogue: product.get_item_list (offset paging, ≤100) → product.get_item_base_info → product.get_model_list
// Live imports require SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY + seller authorisation.
// Without credentials the connector honestly reports needs_credentials — it never fakes data.
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { openSecret, sealSecret } from "@/lib/secretbox";
import { rethrowMarketplace, toMinor, type AuthStatus, type MarketplaceConnector, type NormalizedProduct, type NormalizedShop, type ResolvedUrl } from "./types";

const API_HOST = process.env.SHOPEE_ENV === "live" ? "https://partner.shopeemobile.com" : "https://openplatform.sandbox.test-stable.shopee.sg";
const AUTH_PORTAL = "https://open.shopee.com";

function creds() {
  const partnerId = process.env.SHOPEE_PARTNER_ID;
  const partnerKey = process.env.SHOPEE_PARTNER_KEY;
  return { partnerId, partnerKey, present: Boolean(partnerId && partnerKey) };
}

/** Sign an API path per official V2 algorithm. */
function signPath(apiPath: string, timestamp: number, accessToken?: string, shopId?: string): string {
  const { partnerId, partnerKey } = creds();
  if (!partnerId || !partnerKey) throw new ApiError(503, "CONNECTOR_NOT_CONFIGURED", "Shopee credentials are not configured on the server.");
  const base = `${partnerId}${apiPath}${timestamp}${accessToken ?? ""}${shopId ?? ""}`;
  return crypto.createHmac("sha256", partnerKey).update(base).digest("hex");
}

async function shopeeFetch<T>(apiPath: string, opts: { accessToken?: string; shopId?: string; body?: unknown } = {}): Promise<T> {
  const { partnerId } = creds();
  if (!partnerId) throw new ApiError(503, "CONNECTOR_NOT_CONFIGURED", "Shopee credentials are not configured on the server.");
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signPath(apiPath, timestamp, opts.accessToken, opts.shopId);
  const url = new URL(API_HOST + apiPath);
  url.searchParams.set("partner_id", partnerId);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);
  if (opts.accessToken) url.searchParams.set("access_token", opts.accessToken);
  if (opts.shopId) url.searchParams.set("shop_id", opts.shopId);
  const res = await fetch(url, {
    method: opts.body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json().catch(() => null)) as { error?: string; message?: string; response?: T } | null;
  if (!res.ok || !json || json.error) {
    throw new ApiError(502, "MARKETPLACE_ERROR", `Shopee API error: ${json?.error ?? res.status} ${json?.message ?? ""}`.trim());
  }
  return (json.response ?? (json as unknown)) as T;
}

type TokenResp = { access_token: string; refresh_token: string; expire_in?: number; shop_id?: number | string; request_id?: string };
type ShopInfo = { shop_name?: string; shop_logo?: string; region?: string; status?: string };
type ItemListResp = { item?: { item_id: number; update_time?: number }[]; has_next_page?: boolean; next_offset?: number; total_count?: number };
type ItemBase = {
  item_id: number; item_name?: string; description?: string; has_model?: boolean;
  item_status?: string; category_id?: number; item_sku?: string;
  price_info?: { currency?: string; current_price?: number | string; original_price?: number | string };
  image?: { image_url_list?: string[] };
  stock_info_v2?: { summary_info?: { total_available_stock?: number } };
};
type ModelListResp = { model?: { model_id: number; tier_index?: number[]; price_info?: { current_price?: number | string; original_price?: number | string }; model_sku?: string; model_status?: string; stock_info_v2?: { summary_info?: { total_available_stock?: number } } }[]; tier_variation?: { name?: string; option_list?: { option?: string; image?: string }[] }[] };

async function getConnection(connectionId: string) {
  const conn = await db.marketplaceConnection.findUnique({ where: { id: connectionId } });
  if (!conn || conn.platform !== "shopee") throw new ApiError(404, "CONNECTION_NOT_FOUND", "Shopee connection not found.");
  return conn;
}

export const shopeeConnector: MarketplaceConnector = {
  platform: "shopee",

  detect(url: URL) {
    const host = url.hostname.replace(/^www\./, "");
    return host === "shopee.com.my" || host.endsWith(".shopee.com.my") || /^shopee\.(sg|co\.id|co\.th|th|ph|vn|tw|com\.br|cl|mx)$/.test(host)
      ? { platform: "shopee" as const }
      : null;
  },

  async resolve(url: URL): Promise<ResolvedUrl> {
    const parts = url.pathname.split("/").filter(Boolean);
    const m = url.pathname.match(/-i\.(\d+)\.(\d+)/);
    if (parts[0] === "product" && parts.length >= 3) {
      return { platform: "shopee", urlType: "product", shopId: parts[1], productId: parts[2], normalizedUrl: `${url.protocol}//${url.hostname}${url.pathname}` };
    }
    if (m) {
      return { platform: "shopee", urlType: "product", shopId: m[1], productId: m[2], normalizedUrl: `${url.protocol}//${url.hostname}${url.pathname}` };
    }
    if (parts[0] === "shop" && parts[1]) {
      return { platform: "shopee", urlType: "shop", shopId: parts[1], normalizedUrl: `${url.protocol}//${url.hostname}${url.pathname}` };
    }
    return { platform: "shopee", urlType: "shop", shopId: parts[0], normalizedUrl: `${url.protocol}//${url.hostname}${url.pathname}` };
  },

  async authStatus(): Promise<AuthStatus> {
    const { present } = creds();
    const missing: string[] = [];
    if (!process.env.SHOPEE_PARTNER_ID) missing.push("SHOPEE_PARTNER_ID");
    if (!process.env.SHOPEE_PARTNER_KEY) missing.push("SHOPEE_PARTNER_KEY");
    const connected = await db.marketplaceConnection.findFirst({
      where: { platform: "shopee", status: "connected" },
      select: { id: true },
    });
    return {
      envConfigured: present,
      connected: Boolean(connected),
      needsAuthorisation: present && !connected,
      missing,
      beginUrl: present ? `${AUTH_PORTAL}/auth?partner_id=${process.env.SHOPEE_PARTNER_ID}&auth_type=seller&response_type=code` : null,
    };
  },

  async beginAuthorisation({ redirectUri, state }) {
    const { partnerId, present } = creds();
    if (!present || !partnerId) return null;
    const u = new URL(`${AUTH_PORTAL}/auth`);
    u.searchParams.set("partner_id", partnerId);
    u.searchParams.set("auth_type", "seller");
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    if (state) u.searchParams.set("state", state);
    return { authorizeUrl: u.toString() };
  },

  async exchangeCode({ code, shopIdParam }) {
    const { partnerId, partnerKey, present } = creds();
    if (!present || !partnerId || !partnerKey) throw new ApiError(503, "CONNECTOR_NOT_CONFIGURED", "Shopee credentials are not configured.");
    const timestamp = Math.floor(Date.now() / 1000);
    const path = "/api/v2/auth/token/get";
    const sign = crypto.createHmac("sha256", partnerKey).update(`${partnerId}${path}${timestamp}`).digest("hex");
    const res = await fetch(`${API_HOST}${path}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, shop_id: Number(shopIdParam ?? 0), partner_id: Number(partnerId) }),
      signal: AbortSignal.timeout(15000),
    });
    const json = (await res.json().catch(() => null)) as { error?: string; message?: string; response?: TokenResp } | null;
    if (!res.ok || !json || json.error || !json.response) {
      throw new ApiError(502, "AUTH_FAILED", `Shopee token exchange failed: ${json?.error ?? res.status} ${json?.message ?? ""}`.trim());
    }
    const t = json.response;
    const shopId = String(shopIdParam ?? t.shop_id ?? "");
    const expiresAt = new Date(Date.now() + (t.expire_in ?? 4 * 3600) * 1000);
    let shop: NormalizedShop = { sourceShopId: shopId, name: `Shopee shop ${shopId}` };
    try {
      const info = await shopeeFetch<ShopInfo>("/api/v2/shop/get_shop_info", { accessToken: t.access_token, shopId });
      shop = { sourceShopId: shopId, name: info.shop_name ?? shop.name, logoUrl: info.shop_logo ?? null, region: info.region ?? "MY" };
    } catch {
      // shop info is best-effort; token still valid
    }
    await db.marketplaceConnection.upsert({
      where: { platform_shopId: { platform: "shopee", shopId } },
      create: {
        platform: "shopee", shopId, shopName: shop.name, region: shop.region ?? "MY", status: "connected",
        envConfigured: true, accessTokenEnc: sealSecret(t.access_token), refreshTokenEnc: sealSecret(t.refresh_token),
        expiresAt, scopesJson: "[]",
      },
      update: {
        status: "connected", accessTokenEnc: sealSecret(t.access_token), refreshTokenEnc: sealSecret(t.refresh_token),
        expiresAt, lastError: null, shopName: shop.name,
      },
    });
    return { shop, expiresAt, scopes: [] };
  },

  async refreshIfNeeded(connectionId) {
    const conn = await getConnection(connectionId);
    if (!conn.expiresAt || conn.expiresAt.getTime() - Date.now() > 10 * 60 * 1000) return;
    const { partnerId, partnerKey, present } = creds();
    if (!present || !partnerId || !partnerKey) throw new ApiError(503, "CONNECTOR_NOT_CONFIGURED", "Shopee credentials are not configured.");
    const refresh = openSecret(conn.refreshTokenEnc);
    if (!refresh) throw new ApiError(502, "TOKEN_ERROR", "Stored Shopee refresh token could not be read — reconnect the shop.");
    const timestamp = Math.floor(Date.now() / 1000);
    const path = "/api/v2/auth/access_token/get";
    const sign = crypto.createHmac("sha256", partnerKey).update(`${partnerId}${path}${timestamp}`).digest("hex");
    const res = await fetch(`${API_HOST}${path}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refresh, shop_id: Number(conn.shopId), partner_id: Number(partnerId) }),
      signal: AbortSignal.timeout(15000),
    });
    const json = (await res.json().catch(() => null)) as { error?: string; response?: TokenResp } | null;
    if (!json?.response) {
      await db.marketplaceConnection.update({ where: { id: conn.id }, data: { status: "expired", lastError: "refresh failed" } });
      throw new ApiError(502, "TOKEN_REFRESH_FAILED", "Shopee token refresh failed — reconnect the shop.");
    }
    // refresh token is single-use and rotated on every refresh (official docs)
    await db.marketplaceConnection.update({
      where: { id: conn.id },
      data: {
        accessTokenEnc: sealSecret(json.response.access_token),
        refreshTokenEnc: sealSecret(json.response.refresh_token),
        expiresAt: new Date(Date.now() + (json.response.expire_in ?? 4 * 3600) * 1000),
        lastRefreshAt: new Date(),
        status: "connected",
      },
    });
  },

  async getShop(connectionId): Promise<NormalizedShop> {
    try {
      const conn = await getConnection(connectionId);
      await this.refreshIfNeeded(connectionId);
      const fresh = await getConnection(connectionId);
      const token = openSecret(fresh.accessTokenEnc);
      if (!token) throw new ApiError(502, "TOKEN_ERROR", "Stored Shopee token could not be read.");
      const info = await shopeeFetch<ShopInfo>("/api/v2/shop/get_shop_info", { accessToken: token, shopId: conn.shopId ?? undefined });
      return { sourceShopId: conn.shopId ?? "", name: info.shop_name ?? `Shopee shop ${conn.shopId}`, logoUrl: info.shop_logo ?? null, region: info.region ?? "MY" };
    } catch (err) {
      rethrowMarketplace(err, "Shopee");
    }
  },

  async listProductsPage(connectionId, cursor, pageSize) {
    try {
      const conn = await getConnection(connectionId);
      await this.refreshIfNeeded(connectionId);
      const fresh = await getConnection(connectionId);
      const token = openSecret(fresh.accessTokenEnc);
      if (!token) throw new ApiError(502, "TOKEN_ERROR", "Stored Shopee token could not be read.");
      const resp = await shopeeFetch<ItemListResp>("/api/v2/product/get_item_list", {
        accessToken: token,
        shopId: conn.shopId ?? undefined,
        body: { offset: cursor ? Number(cursor) : 0, page_size: Math.min(pageSize, 100) },
      });
      return {
        products: (resp.item ?? []).map((i) => ({ sourceProductId: String(i.item_id), updatedHint: i.update_time ?? null })),
        nextCursor: resp.has_next_page && resp.next_offset !== undefined ? String(resp.next_offset) : null,
      };
    } catch (err) {
      rethrowMarketplace(err, "Shopee");
    }
  },

  async getProduct(connectionId, sourceProductId): Promise<NormalizedProduct> {
    try {
      const conn = await getConnection(connectionId);
      await this.refreshIfNeeded(connectionId);
      const fresh = await getConnection(connectionId);
      const token = openSecret(fresh.accessTokenEnc);
      if (!token) throw new ApiError(502, "TOKEN_ERROR", "Stored Shopee token could not be read.");
      const base = await shopeeFetch<{ item?: ItemBase }>("/api/v2/product/get_item_base_info", {
        accessToken: token,
        shopId: conn.shopId ?? undefined,
        body: { item_id_list: [Number(sourceProductId)] },
      });
      const item = base.item?.[0];
      if (!item) throw new ApiError(404, "SOURCE_PRODUCT_NOT_FOUND", "The product no longer exists on Shopee.");
      const warnings: string[] = [];
      const images = (item.image?.image_url_list ?? []).map((u, i) => ({ url: u, sortOrder: i, alt: item.item_name ?? null }));
      if (images.length === 0) warnings.push("No images returned by the marketplace");
      let variants: NormalizedProduct["variants"] = [];
      if (item.has_model) {
        const models = await shopeeFetch<ModelListResp>("/api/v2/product/get_model_list", {
          accessToken: token,
          shopId: conn.shopId ?? undefined,
          body: { item_id: Number(sourceProductId) },
        });
        const tiers = models.tier_variation ?? [];
        variants = (models.model ?? []).map((mo) => {
          const options: { name: string; value: string }[] = [];
          (mo.tier_index ?? []).forEach((ti, dim) => {
            const tv = tiers[dim];
            const opt = tv?.option_list?.[ti]?.option;
            if (tv && opt) options.push({ name: tv.name ?? `Option ${dim + 1}`, value: opt });
          });
          const priceMinor = toMinor(mo.price_info?.current_price);
          if (priceMinor === null) warnings.push("Variant price unavailable from marketplace");
          return {
            sourceModelId: String(mo.model_id),
            sourceSku: mo.model_sku ?? null,
            options,
            priceMinor: priceMinor ?? 0,
            compareAtPriceMinor: toMinor(mo.price_info?.original_price),
            stock: mo.stock_info_v2?.summary_info?.total_available_stock ?? null,
            imageUrl: tiers[0]?.option_list?.[mo.tier_index?.[0] ?? -1]?.image ?? null,
            isAvailable: mo.model_status === "ACTIVE",
          };
        });
      } else {
        const priceMinor = toMinor(item.price_info?.current_price);
        if (priceMinor === null) warnings.push("Price unavailable from marketplace");
        variants = [
          {
            sourceModelId: `${item.item_id}-default`,
            sourceSku: item.item_sku ?? null,
            options: [],
            priceMinor: priceMinor ?? 0,
            compareAtPriceMinor: toMinor(item.price_info?.original_price),
            stock: item.stock_info_v2?.summary_info?.total_available_stock ?? null,
            imageUrl: images[0]?.url ?? null,
            isAvailable: item.item_status === "ACTIVE",
          },
        ];
      }
      return {
        sourceProductId: String(item.item_id),
        title: item.item_name ?? `Shopee item ${item.item_id}`,
        descriptionHtml: item.description ?? null,
        brand: null, // base_info does not include brand — do not invent
        categoryHint: item.category_id ? String(item.category_id) : null,
        images,
        variants,
        currency: item.price_info?.currency ?? "MYR",
        sourceStatus: item.item_status ?? "UNKNOWN",
        isAvailable: item.item_status === "ACTIVE",
        warnings,
      };
    } catch (err) {
      rethrowMarketplace(err, "Shopee");
    }
  },
};
