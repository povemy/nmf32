"use client";
// ============================================================================
// Client-side identity bridge — keeps device/session tokens in localStorage so
// the app keeps working in contexts where cookies are unavailable or dropped
// (e.g. cross-site iframes like embedded preview panels, where browsers reject
// SameSite=Lax cookies). Tokens travel via request headers:
//   - X-Cart-Token    → guest cart identity   (server: /api/cart/*)
//   - X-Shopper-Token → shopper device token  (server: /api/checkout/* addresses)
//   - Authorization:  → session for seller/admin portals (server: lib/auth.ts)
// Server routes still fall back to cookies, so top-level browsing keeps working.
// ============================================================================

export const SESSION_TOKEN_KEY = "sm_session_token";
export const CART_TOKEN_KEY = "sm_cart_token";
export const SHOPPER_TOKEN_KEY = "sm_shopper_token";
/** Cookie the server sets for the guest cart (must match CART_COOKIE in api/cart/cart.ts). */
export const CART_COOKIE_NAME = "sm_cart";

function randomHex32(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

/** In-memory token memo — the LAST line of defence. When localStorage AND cookies
 *  are both blocked (sandboxed cross-site iframe preview panels), storage access
 *  throws on every call. Without this memo each request used to mint a NEW random
 *  token, so "add to cart" (token A) and "get cart" (token B) hit different carts
 *  and the cart always looked empty. Memoising per page-load guarantees every API
 *  call in the same document shares one identity. */
const memoryTokens = new Map<string, string>();

/** Best-effort read of a first-party cookie — recovers the server-issued cart
 *  token across reloads when localStorage is blocked but cookies still work. */
function readCookieToken(name: string): string | null {
  if (typeof document === "undefined") return null;
  try {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

/** Read (or lazily mint) a stable per-device token.
 *  Resolution order: memory memo → localStorage → cart cookie → mint & memo. */
export function deviceToken(key: string): string {
  if (typeof window === "undefined") return "";

  const memoised = memoryTokens.get(key);
  if (memoised) return memoised;

  let token: string | null = null;
  try {
    token = window.localStorage.getItem(key);
  } catch {
    token = null; // storage blocked (sandboxed iframe / private mode)
  }
  // localStorage unavailable — try the server-issued cart cookie before minting,
  // so a cart built earlier in the session is still reachable across reloads.
  if (!token && key === CART_TOKEN_KEY) token = readCookieToken(CART_COOKIE_NAME);

  if (!token || !/^[A-Za-z0-9_-]{8,64}$/.test(token)) {
    token = randomHex32();
    try {
      window.localStorage.setItem(key, token);
    } catch {
      /* storage unavailable — the memory memo below keeps this page consistent */
    }
  }
  memoryTokens.set(key, token);
  return token;
}

/** Headers carrying the guest cart + shopper device identity. */
export function deviceHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  return {
    "X-Cart-Token": deviceToken(CART_TOKEN_KEY),
    "X-Shopper-Token": deviceToken(SHOPPER_TOKEN_KEY),
  };
}

export function getSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string | null | undefined): void {
  if (typeof window === "undefined" || !token) return;
  try {
    window.localStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    /* storage unavailable — cookie fallback still applies */
  }
}

export function clearSessionToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** Authorization header for portal APIs when a session token is stored. */
export function authHeaders(): Record<string, string> {
  const t = getSessionToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}
