// Marketplace connector contracts (Phase 5) — normalised types shared by all connectors.
// Research basis: docs/research-shopee.md, docs/research-tiktok.md (official API verification).
import type { ApiError } from "@/lib/api";

export type Platform = "shopee" | "tiktok" | "fixture";
export type UrlType = "shop" | "product" | "unknown";

export type ResolvedUrl = {
  platform: Platform;
  urlType: UrlType;
  shopId?: string;
  productId?: string;
  normalizedUrl: string;
  region?: string;
};

export type NormalizedVariant = {
  sourceModelId: string;
  sourceSku?: string | null;
  options: { name: string; value: string }[];
  priceMinor: number;
  compareAtPriceMinor?: number | null;
  stock?: number | null;
  imageUrl?: string | null;
  isAvailable: boolean;
};

export type NormalizedProduct = {
  sourceProductId: string;
  title: string;
  descriptionHtml?: string | null;
  brand?: string | null;
  categoryHint?: string | null;
  images: { url: string; sortOrder: number; alt?: string | null }[];
  variants: NormalizedVariant[];
  currency: string;
  sourceStatus: string;
  sourceUrl?: string;
  isAvailable: boolean;
  warnings: string[];
};

export type NormalizedShop = {
  sourceShopId: string;
  name: string;
  logoUrl?: string | null;
  region?: string | null;
  productCountHint?: number | null;
};

export type AuthStatus = {
  envConfigured: boolean;
  connected: boolean;
  needsAuthorisation: boolean;
  missing: string[];
  beginUrl?: string | null;
};

export interface MarketplaceConnector {
  platform: Platform;
  detect(url: URL): { platform: Platform } | null;
  resolve(url: URL): Promise<ResolvedUrl>;
  authStatus(): Promise<AuthStatus>;
  beginAuthorisation(opts: { redirectUri: string; state: string }): Promise<{ authorizeUrl: string } | null>;
  exchangeCode(opts: { code: string; redirectUri: string; shopIdParam?: string | null }): Promise<{
    shop: NormalizedShop;
    expiresAt: Date;
    scopes: string[];
  }>;
  refreshIfNeeded(connectionId: string): Promise<void>;
  getShop(connectionId: string): Promise<NormalizedShop>;
  listProductsPage(
    connectionId: string,
    cursor: string | null,
    pageSize: number
  ): Promise<{ products: { sourceProductId: string; updatedHint?: number | null }[]; nextCursor: string | null }>;
  getProduct(connectionId: string, sourceProductId: string): Promise<NormalizedProduct>;
}

export function rethrowMarketplace(err: unknown, platform: string): never {
  if (err && typeof err === "object" && "status" in err) throw err;
  const msg = err instanceof Error ? err.message : String(err);
  const e = new Error(`${platform} connector: ${msg}`) as Error & { status?: number; code?: string };
  e.status = 502;
  e.code = "MARKETPLACE_ERROR";
  throw e;
}

/** Parse a decimal price string/number to integer minor units (round half-up, no float drift). */
export function toMinor(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : parseFloat(String(value));
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export const apiErr = (status: number, code: string, message: string): ApiError => {
  const e = new Error(message) as Error & { status: number; code: string };
  e.status = status;
  e.code = code;
  return e as ApiError;
};
