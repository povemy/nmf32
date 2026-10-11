// Shared connector utilities: safe decimal→minor parsing, fetch with timeout,
// HTML → text extraction. Local to src/lib/marketplaces (do not touch core libs).
import { ApiError } from "@/lib/api";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 10 * 1024 * 1024; // 10 MB response guard
export const USER_AGENT = "ShopMeshImport/1.0 (+https://shopmesh.local; marketplace import connector)";

/**
 * Parse a decimal price string from a marketplace API into integer minor units
 * with rounding half-up. Avoids float drift by operating on the string
 * ("117.5" → 11750, "19.00" → 1900, 12 (number) → 1200).
 * Returns null when the value is absent/unparseable — callers must surface a
 * warning instead of inventing a price.
 */
export function parseDecimalToMinor(v: unknown): number | null {
  if (v == null) return null;
  let s: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    s = v.toFixed(2);
  } else if (typeof v === "string") {
    s = v.trim();
  } else {
    return null;
  }
  if (s === "" || s === "null" || s === "undefined") return null;
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const intPart = m[2] || "0";
  let frac = m[3] ?? "";
  // Round half-up on the 3rd decimal digit.
  let roundUp = false;
  if (frac.length > 2) {
    roundUp = Number(frac[2]) >= 5;
    frac = frac.slice(0, 2);
  }
  while (frac.length < 2) frac += "0";
  const minor = Number(intPart) * 100 + Number(frac || "0") + (roundUp ? 1 : 0);
  if (!Number.isSafeInteger(minor)) return null;
  return sign * minor;
}

/** Fetch JSON with timeout, User-Agent and a response-size guard. */
export async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": USER_AGENT, ...(init.headers ?? {}) },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "network error";
    throw new ApiError(504, "MARKETPLACE_TIMEOUT", `Marketplace request timed out or failed: ${msg}`);
  }
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > MAX_JSON_BYTES) {
    throw new ApiError(502, "MARKETPLACE_ERROR", "Marketplace response too large");
  }
  const text = await res.text();
  if (text.length > MAX_JSON_BYTES) {
    throw new ApiError(502, "MARKETPLACE_ERROR", "Marketplace response too large");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(502, "MARKETPLACE_ERROR", `Marketplace returned non-JSON response (HTTP ${res.status})`);
  }
  return body;
}

/** Strip tags → plain text (for SEO descriptions). */
export function textFromHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Prettify a slug: "lumine-home" → "Lumine Home". */
export function prettifySlug(slug: string): string {
  return slug
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Deterministic 32-bit string hash (FNV-1a) — seeds the fixture RNG. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 PRNG — deterministic across runs for a given seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

export function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}
