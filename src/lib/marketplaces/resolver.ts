// URL resolver (Phase 5) — strict validation + SSRF guard. No outbound fetch here:
// marketplace pages are never scraped (official APIs require seller authorisation —
// see docs/marketplace-integration-research.md §2.7/§3.8). This resolver only
// parses/validates the pasted URL and extracts identifiers.
import dns from "node:dns/promises";
import { ApiError } from "@/lib/api";
import type { Platform, ResolvedUrl, UrlType } from "./types";

const SHOPEE_HOSTS = new Set([
  "shopee.com.my",
  "shopee.sg",
  "shopee.co.id",
  "shopee.co.th",
  "shopee.th",
  "shopee.ph",
  "shopee.vn",
  "shopee.tw",
  "shopee.com.br",
  "shopee.cl",
  "shopee.mx",
]);

const TIKTOK_HOSTS = new Set(["tiktok.com", "www.tiktok.com", "vt.tiktok.com", "shop.tiktok.com"]);

const PRIVATE_V4 = [
  { ip: "127.0.0.0", bits: 8 },
  { ip: "10.0.0.0", bits: 8 },
  { ip: "172.16.0.0", bits: 12 },
  { ip: "192.168.0.0", bits: 16 },
  { ip: "169.254.0.0", bits: 16 },
  { ip: "0.0.0.0", bits: 8 },
  { ip: "100.64.0.0", bits: 10 },
  { ip: "198.18.0.0", bits: 15 },
  { ip: "224.0.0.0", bits: 4 },
];

function v4ToLong(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIp(ip: string): boolean {
  if (ip === "::1" || ip === "::" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) return true;
  const long = v4ToLong(ip);
  if (long === null) return false;
  for (const { ip: base, bits } of PRIVATE_V4) {
    const b = v4ToLong(base);
    if (b === null) continue;
    const mask = (~0 << (32 - bits)) >>> 0;
    if ((long & mask) === (b & mask)) return true;
  }
  return false;
}

/**
 * Reject private/loopback/link-local targets (SSRF). Exported for reuse by the
 * image copier in the import engine.
 */
export async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApiError(400, "INVALID_URL", "Only http(s) URLs are supported.");
  }
  if (url.username || url.password) {
    throw new ApiError(400, "INVALID_URL", "URLs with embedded credentials are not accepted.");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new ApiError(400, "INVALID_URL", "Non-standard ports are not accepted.");
  }
  let addresses: string[];
  try {
    addresses = await dns.lookup(url.hostname, { all: true, verbatim: true }).then((rs) => rs.map((r) => r.address));
  } catch {
    throw new ApiError(400, "INVALID_URL", "Could not resolve the host in this URL.");
  }
  if (addresses.length === 0 || addresses.some((ip) => isPrivateIp(ip))) {
    throw new ApiError(400, "INVALID_URL", "This host is not reachable from the platform (internal networks are blocked).");
  }
}

function shopeeParse(url: URL): ResolvedUrl | null {
  const host = url.hostname.replace(/^www\./, "");
  const isShopee = SHOPEE_HOSTS.has(host) || /^[\w-]+\.page\.shopee\.com\.my$/.test(host) || host.endsWith(".shopee.com.my");
  if (!isShopee) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  let urlType: UrlType = "shop";
  let shopId: string | undefined;
  let productId: string | undefined;
  // canonical product patterns: /product/{shopId}/{itemId} or /Name-i.{shopId}.{itemId}
  if (parts[0] === "product" && parts.length >= 3) {
    urlType = "product";
    shopId = parts[1];
    productId = parts[2];
  } else {
    const m = url.pathname.match(/-i\.(\d+)\.(\d+)/);
    if (m) {
      urlType = "product";
      shopId = m[1];
      productId = m[2];
    } else if (parts[0] === "shop" && parts[1]) {
      urlType = "shop";
      shopId = parts[1];
    }
  }
  return {
    platform: "shopee",
    urlType,
    shopId,
    productId,
    normalizedUrl: `${url.protocol}//${host}${url.pathname}`,
    region: host === "shopee.com.my" ? "MY" : undefined,
  };
}

function tiktokParse(url: URL): ResolvedUrl | null {
  const host = url.hostname;
  if (!TIKTOK_HOSTS.has(host) && !host.endsWith(".tiktok.com")) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  let urlType: UrlType = "shop";
  let shopId: string | undefined;
  let productId: string | undefined;
  const shopIdx = parts.indexOf("shop");
  const prodIdx = parts.indexOf("product");
  if (prodIdx >= 0 && parts[prodIdx + 1]) {
    urlType = "product";
    shopId = parts[prodIdx + 1];
    productId = parts[prodIdx + 2] ?? undefined;
  } else if (shopIdx >= 0 && parts[shopIdx + 1]) {
    urlType = "shop";
    shopId = parts[shopIdx + 1];
  } else if (parts.length === 1) {
    // @username or slug — treat as shop handle
    urlType = "shop";
    shopId = parts[0].replace(/^@/, "");
  }
  return {
    platform: "tiktok",
    urlType,
    shopId,
    productId,
    normalizedUrl: `${url.protocol}//${host}${url.pathname}`,
    region: "MY",
  };
}

function fixtureParse(url: URL): ResolvedUrl | null {
  if (url.hostname !== "demo.shopmesh.fixture" && !url.hostname.endsWith(".fixture.import")) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  let urlType: UrlType = "shop";
  let shopId: string | undefined;
  let productId: string | undefined;
  if (parts[0] === "shop" && parts[1]) {
    urlType = "shop";
    shopId = parts[1];
  } else if (parts[0] === "product" && parts[2]) {
    urlType = "product";
    shopId = parts[1];
    productId = parts[2];
  } else if (parts[0]) {
    shopId = parts[0];
  }
  return { platform: "fixture", urlType, shopId, productId, normalizedUrl: url.toString() };
}

/** Validate + detect + extract identifiers. Pure (DNS check only, no fetch). */
export async function resolveMarketplaceUrl(raw: string): Promise<ResolvedUrl> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ApiError(400, "INVALID_URL", "That does not look like a valid URL.");
  }
  const parsed = fixtureParse(url) ?? shopeeParse(url) ?? tiktokParse(url);
  if (!parsed) {
    throw new ApiError(
      400,
      "UNSUPPORTED_MARKETPLACE",
      "Unsupported link. Paste a Shopee shop/product URL, a TikTok Shop URL, or a demo fixture link."
    );
  }
  // fixture pseudo-hosts are never fetched — skip the SSRF DNS guard for them
  if (parsed.platform !== "fixture") {
    await assertPublicHost(url);
  }
  return parsed;
}

export function platformLabel(platform: string): string {
  return platform === "shopee" ? "Shopee" : platform === "tiktok" ? "TikTok Shop" : "Demo fixture";
}
