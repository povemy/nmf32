// TikTok Shop Open API 202309 connector (Phase 5) — implements the OFFICIAL contract
// verified in docs/research-tiktok.md:
//   - API host: https://open-api.tiktokglobalshop.com; token host: https://auth.tiktok-shops.com
//   - signing: hex(HMAC-SHA256(secret + path + sorted{k}{v} + raw_body + secret))
//   - common query: app_key, timestamp, sign; header x-tts-access-token; product APIs need shop_cipher
//   - products read scope: seller.product.basic; search = POST /product/202309/products/search
//   - token grant_type is "authorized_code" (NOT "authorization_code") per official docs
// Requires TIKTOK_SHOP_APP_KEY / TIKTOK_SHOP_APP_SECRET + seller authorisation.
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { openSecret, sealSecret } from "@/lib/secretbox";
import { rethrowMarketplace, toMinor, type AuthStatus, type MarketplaceConnector, type NormalizedProduct, type NormalizedShop, type ResolvedUrl } from "./types";

const API_HOST = "https://open-api.tiktokglobalshop.com";
const AUTH_HOST = "https://auth.tiktok-shops.com";
const AUTH_PORTAL = "https://services.tiktokshop.com";

function creds() {
  const appKey = process.env.TIKTOK_SHOP_APP_KEY;
  const appSecret = process.env.TIKTOK_SHOP_APP_SECRET;
  return { appKey, appSecret, present: Boolean(appKey && appSecret) };
}

/** Official signing: HMAC-SHA256 over secret+path+sorted{k}{v}+body+secret. */
function signRequest(path: string, params: Record<string, string>, body: string | null): string {
  const { appSecret } = creds();
  if (!appSecret) throw new ApiError(503, "CONNECTOR_NOT_CONFIGURED", "TikTok Shop credentials are not configured on the server.");
  const kv = Object.keys(params)
    .filter((k) => k !== "sign" && k !== "access_token")
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join("");
  const base = `${appSecret}${path}${kv}${body ?? ""}${appSecret}`;
  return crypto.createHmac("sha256", appSecret).update(base).digest("hex");
}

async function tiktokFetch<T>(path: string, opts: { accessToken?: string; shopCipher?: string; query?: Record<string, string>; body?: unknown; method?: "GET" | "POST" } = {}): Promise<T> {
  const { appKey, present } = creds();
  if (!present || !appKey) throw new ApiError(503, "CONNECTOR_NOT_CONFIGURED", "TikTok Shop credentials are not configured.");
  const method = opts.method ?? (opts.body ? "POST" : "GET");
  const bodyStr = opts.body ? JSON.stringify(opts.body) : null;
  const params: Record<string, string> = { app_key: appKey, timestamp: String(Math.floor(Date.now() / 1000)), ...(opts.query ?? {}) };
  params.sign = signRequest(path, params, bodyStr);
  const url = new URL(API_HOST + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(opts.accessToken ? { "x-tts-access-token": opts.accessToken } : {}),
    },
    body: bodyStr,
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json().catch(() => null)) as { code?: number; message?: string; data?: T } | null;
  if (!json || json.code !== 0 || !json.data) {
    throw new ApiError(502, "MARKETPLACE_ERROR", `TikTok Shop API error ${json?.code ?? res.status}: ${json?.message ?? "unknown"}`);
  }
  return json.data;
}

type TokenResp = { access_token: string; refresh_token: string; access_token_expire_at?: number; refresh_token_expire_at?: number; open_id?: string };
type Shop = { id: string; name?: string; region?: string; cipher?: string; seller_type?: string };
type SearchResult = { products?: { id: string }[]; next_page_token?: string };
type ProductDetail = {
  id: string; title?: string; description?: string; status?: string;
  brand?: { name?: string } | null;
  category_chains?: { categories?: { id?: string; name?: string; is_leaf?: boolean }[] }[];
  main_images?: { urls?: string[]; thumb_urls?: string[] }[];
  skus?: {
    id?: string; seller_sku?: string;
    price?: { sale_price?: string | number; tax_exclusive_price?: string | number; original_price?: string | number; currency?: string };
    inventory?: { quantity?: number }[];
    sales_attributes?: { name?: string; value_name?: string; sku_img?: { urls?: string[] } }[];
    status_info?: { seller_status?: string };
  }[];
};

async function getConnection(connectionId: string) {
  // PHASE 2.2 (C3): explicit select — every column EXCEPT sellerId (the dev DB
  // does not have the column until migration 20261105000000 is applied; a
  // default full-row select would fail at runtime pre-migration).
  const conn = await db.marketplaceConnection.findUnique({
    where: { id: connectionId },
    select: {
      id: true, storeId: true, platform: true, status: true, envConfigured: true,
      shopId: true, shopName: true, shopCipher: true, region: true,
      accessTokenEnc: true, refreshTokenEnc: true, scopesJson: true,
      expiresAt: true, lastRefreshAt: true, lastError: true,
      createdAt: true, updatedAt: true,
    },
  });
  if (!conn || conn.platform !== "tiktok") throw new ApiError(404, "CONNECTION_NOT_FOUND", "TikTok Shop connection not found.");
  return conn;
}

export const tiktokConnector: MarketplaceConnector = {
  platform: "tiktok",

  detect(url: URL) {
    const host = url.hostname;
    return host === "tiktok.com" || host === "www.tiktok.com" || host === "shop.tiktok.com" || host.endsWith(".tiktok.com")
      ? { platform: "tiktok" as const }
      : null;
  },

  async resolve(url: URL): Promise<ResolvedUrl> {
    const parts = url.pathname.split("/").filter(Boolean);
    const prodIdx = parts.indexOf("product");
    if (prodIdx >= 0 && parts[prodIdx + 1]) {
      return { platform: "tiktok", urlType: "product", shopId: parts[prodIdx + 1], productId: parts[prodIdx + 2], normalizedUrl: `${url.protocol}//${url.hostname}${url.pathname}` };
    }
    const shopIdx = parts.indexOf("shop");
    if (shopIdx >= 0 && parts[shopIdx + 1]) {
      return { platform: "tiktok", urlType: "shop", shopId: parts[shopIdx + 1], normalizedUrl: `${url.protocol}//${url.hostname}${url.pathname}` };
    }
    if (parts.length >= 1) {
      return { platform: "tiktok", urlType: "shop", shopId: parts[0].replace(/^@/, ""), normalizedUrl: `${url.protocol}//${url.hostname}${url.pathname}` };
    }
    return { platform: "tiktok", urlType: "unknown", normalizedUrl: `${url.protocol}//${url.hostname}${url.pathname}` };
  },

  async authStatus(): Promise<AuthStatus> {
    const { present } = creds();
    const missing: string[] = [];
    if (!process.env.TIKTOK_SHOP_APP_KEY) missing.push("TIKTOK_SHOP_APP_KEY");
    if (!process.env.TIKTOK_SHOP_APP_SECRET) missing.push("TIKTOK_SHOP_APP_SECRET");
    const connected = await db.marketplaceConnection.findFirst({ where: { platform: "tiktok", status: "connected" }, select: { id: true } });
    return {
      envConfigured: present,
      connected: Boolean(connected),
      needsAuthorisation: present && !connected,
      missing,
      beginUrl: present ? `${AUTH_PORTAL}/open/authorize?app_key=${process.env.TIKTOK_SHOP_APP_KEY}${process.env.TIKTOK_SHOP_SERVICE_ID ? `&service_id=${process.env.TIKTOK_SHOP_SERVICE_ID}` : ""}` : null,
    };
  },

  async beginAuthorisation({ state }) {
    const { appKey, present } = creds();
    if (!present || !appKey) return null;
    const u = new URL(`${AUTH_PORTAL}/open/authorize`);
    u.searchParams.set("app_key", appKey);
    if (process.env.TIKTOK_SHOP_SERVICE_ID) u.searchParams.set("service_id", process.env.TIKTOK_SHOP_SERVICE_ID);
    if (state) u.searchParams.set("state", state);
    return { authorizeUrl: u.toString() };
  },

  async exchangeCode({ code, sellerId }) {
    const { appKey, appSecret, present } = creds();
    if (!present || !appKey || !appSecret) throw new ApiError(503, "CONNECTOR_NOT_CONFIGURED", "TikTok Shop credentials are not configured.");
    const body = new URLSearchParams({ app_key: appKey, app_secret: appSecret, auth_code: code, grant_type: "authorized_code" });
    const res = await fetch(`${AUTH_HOST}/api/v2/token/get`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    const json = (await res.json().catch(() => null)) as { code?: number; message?: string; data?: TokenResp } | null;
    if (!json || json.code !== 0 || !json.data) {
      throw new ApiError(502, "AUTH_FAILED", `TikTok Shop token exchange failed: ${json?.code ?? res.status} ${json?.message ?? ""}`.trim());
    }
    const t = json.data;
    // fetch authorised shops to bind shop identity + cipher (required by product APIs)
    const shopsData = await tiktokFetch<{ shops?: Shop[]; total_count?: number }>("/authorization/202309/shops", { accessToken: t.access_token });
    const shop = shopsData.shops?.[0];
    if (!shop) throw new ApiError(502, "AUTH_FAILED", "No authorised TikTok Shop found for this authorisation.");
    const expiresAt = new Date((t.access_token_expire_at ?? Math.floor(Date.now() / 1000) + 7 * 86400) * 1000);
    const normalized: NormalizedShop = { sourceShopId: shop.id, name: shop.name ?? `TikTok Shop ${shop.id}`, region: shop.region ?? "MY" };
    // PHASE 2.2 (C3 — OAuth ownership): attribute the connection to the seller
    // whose OAuth flow created it (sellerId comes from the validated signed
    // `state`). On create it is persisted directly; on update (existing shop
    // re-authorised) a guarded follow-up attributes ONLY rows still unattributed
    // — an attributed connection is never stolen by another seller's flow.
    // select: { id } avoids the full-row return (sellerId is not applied on the
    // update branch, so the row stays runtime-safe to read here).
    const conn = await db.marketplaceConnection.upsert({
      where: { platform_shopId: { platform: "tiktok", shopId: shop.id } },
      create: {
        platform: "tiktok", shopId: shop.id, shopName: normalized.name, region: normalized.region ?? "MY",
        shopCipher: shop.cipher ?? null, status: "connected", envConfigured: true,
        accessTokenEnc: sealSecret(t.access_token), refreshTokenEnc: sealSecret(t.refresh_token),
        expiresAt, scopesJson: JSON.stringify(["seller.product.basic"]), sellerId: sellerId ?? null,
      },
      update: {
        status: "connected", shopCipher: shop.cipher ?? null, accessTokenEnc: sealSecret(t.access_token),
        refreshTokenEnc: sealSecret(t.refresh_token), expiresAt, lastError: null, shopName: normalized.name,
      },
      select: { id: true },
    });
    if (sellerId) {
      await db.marketplaceConnection.updateMany({ where: { id: conn.id, sellerId: null }, data: { sellerId } });
    }
    return { shop: normalized, expiresAt, scopes: ["seller.product.basic"] };
  },

  async refreshIfNeeded(connectionId) {
    const conn = await getConnection(connectionId);
    if (!conn.expiresAt || conn.expiresAt.getTime() - Date.now() > 10 * 60 * 1000) return;
    const { appKey, appSecret, present } = creds();
    if (!present || !appKey || !appSecret) throw new ApiError(503, "CONNECTOR_NOT_CONFIGURED", "TikTok Shop credentials are not configured.");
    const refresh = openSecret(conn.refreshTokenEnc);
    if (!refresh) throw new ApiError(502, "TOKEN_ERROR", "Stored TikTok refresh token could not be read — reconnect the shop.");
    const body = new URLSearchParams({ app_key: appKey, app_secret: appSecret, grant_type: "refresh_token", refresh_token: refresh });
    const res = await fetch(`${AUTH_HOST}/api/v2/token/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    const json = (await res.json().catch(() => null)) as { code?: number; data?: TokenResp } | null;
    if (!json || json.code !== 0 || !json.data) {
      await db.marketplaceConnection.update({ where: { id: conn.id }, data: { status: "expired", lastError: "refresh failed" }, select: { id: true } });
      throw new ApiError(502, "TOKEN_REFRESH_FAILED", "TikTok Shop token refresh failed — reconnect the shop.");
    }
    await db.marketplaceConnection.update({
      where: { id: conn.id },
      data: {
        accessTokenEnc: sealSecret(json.data.access_token),
        refreshTokenEnc: sealSecret(json.data.refresh_token),
        expiresAt: new Date((json.data.access_token_expire_at ?? Math.floor(Date.now() / 1000) + 7 * 86400) * 1000),
        lastRefreshAt: new Date(),
        status: "connected",
      },
      select: { id: true },
    });
  },

  async getShop(connectionId): Promise<NormalizedShop> {
    try {
      const conn = await getConnection(connectionId);
      await this.refreshIfNeeded(connectionId);
      const fresh = await getConnection(connectionId);
      const token = openSecret(fresh.accessTokenEnc);
      if (!token) throw new ApiError(502, "TOKEN_ERROR", "Stored TikTok token could not be read.");
      const data = await tiktokFetch<{ shops?: Shop[] }>("/authorization/202309/shops", { accessToken: token });
      const shop = data.shops?.find((s) => s.id === conn.shopId) ?? data.shops?.[0];
      return { sourceShopId: shop?.id ?? conn.shopId ?? "", name: shop?.name ?? conn.shopName ?? `TikTok Shop ${conn.shopId}`, region: shop?.region ?? "MY" };
    } catch (err) {
      rethrowMarketplace(err, "TikTok Shop");
    }
  },

  async listProductsPage(connectionId, cursor, pageSize) {
    try {
      const conn = await getConnection(connectionId);
      await this.refreshIfNeeded(connectionId);
      const fresh = await getConnection(connectionId);
      const token = openSecret(fresh.accessTokenEnc);
      if (!token) throw new ApiError(502, "TOKEN_ERROR", "Stored TikTok token could not be read.");
      const data = await tiktokFetch<SearchResult>("/product/202309/products/search", {
        accessToken: token,
        shopCipher: fresh.shopCipher ?? undefined,
        body: { page_size: Math.min(pageSize, 100), ...(cursor ? { page_token: cursor } : {}) },
      });
      return {
        products: (data.products ?? []).map((p) => ({ sourceProductId: p.id })),
        nextCursor: data.next_page_token ?? null,
      };
    } catch (err) {
      rethrowMarketplace(err, "TikTok Shop");
    }
  },

  async getProduct(connectionId, sourceProductId): Promise<NormalizedProduct> {
    try {
      const conn = await getConnection(connectionId);
      await this.refreshIfNeeded(connectionId);
      const fresh = await getConnection(connectionId);
      const token = openSecret(fresh.accessTokenEnc);
      if (!token) throw new ApiError(502, "TOKEN_ERROR", "Stored TikTok token could not be read.");
      const p = await tiktokFetch<ProductDetail>(`/product/202309/products/${encodeURIComponent(sourceProductId)}`, {
        accessToken: token,
        shopCipher: fresh.shopCipher ?? undefined,
      });
      const warnings: string[] = [];
      const images = (p.main_images ?? [])
        .map((im, i) => ({ url: im.urls?.[0] ?? "", sortOrder: i, alt: p.title ?? null }))
        .filter((im) => im.url);
      if (images.length === 0) warnings.push("No images returned by the marketplace");
      const variants: NormalizedProduct["variants"] = (p.skus ?? []).map((sku, idx) => {
        const price = toMinor(sku.price?.sale_price ?? sku.price?.tax_exclusive_price);
        if (price === null) warnings.push("Variant price unavailable from marketplace");
        const original = toMinor(sku.price?.original_price);
        return {
          sourceModelId: sku.id ?? `${p.id}-sku${idx}`,
          sourceSku: sku.seller_sku ?? null,
          options: (sku.sales_attributes ?? [])
            .filter((a) => a.name && a.value_name)
            .map((a) => ({ name: a.name as string, value: a.value_name as string })),
          priceMinor: price ?? 0,
          compareAtPriceMinor: original && original > (price ?? 0) ? original : null,
          stock: (sku.inventory ?? []).reduce((s, inv) => s + (inv.quantity ?? 0), 0) || null,
          imageUrl: sku.sales_attributes?.map((a) => a.sku_img?.urls?.[0]).find(Boolean) ?? null,
          isAvailable: sku.status_info?.seller_status === "ACTIVE",
        };
      });
      const leaf = p.category_chains?.[0]?.categories?.filter((c) => c.is_leaf).at(-1)?.name;
      return {
        sourceProductId: p.id,
        title: p.title ?? `TikTok product ${p.id}`,
        descriptionHtml: p.description ?? null,
        brand: p.brand?.name ?? null,
        categoryHint: leaf ?? p.category_chains?.[0]?.categories?.at(-1)?.name ?? null,
        images,
        variants,
        currency: p.skus?.[0]?.price?.currency ?? "MYR",
        sourceStatus: p.status ?? "UNKNOWN",
        isAvailable: p.status === "ACTIVE" || p.status === "DRAFT",
        warnings,
      };
    } catch (err) {
      rethrowMarketplace(err, "TikTok Shop");
    }
  },
};
