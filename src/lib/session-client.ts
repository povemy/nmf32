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

/** CSRF origin-gate marker (src/proxy.ts rule 2): a custom header the app's
 * own JS attaches to EVERY request. Cross-site pages cannot set custom
 * headers without a CORS preflight — and this app never grants CORS — so its
 * presence proves "initiated by our own JavaScript" even when a proxy chain
 * rewrites the Host header (preview panels) or the frame origin is opaque
 * (sandboxed iframes). This is what keeps LOGIN (pre-Bearer) working in every
 * embed context. */
export const CLIENT_MARKER = "X-SM-Client" as const;
export const CLIENT_MARKER_VALUE = "web";

/** Marker-only headers — for raw fetch() sites that carry no identity tokens. */
export function webHeaders(): Record<string, string> {
  return { [CLIENT_MARKER]: CLIENT_MARKER_VALUE };
}

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

/** Adopt the server-issued GUEST cart token (Phase 2.2 guest checkout
 *  restoration). Every cart response from a guest-owned cart echoes its
 *  token; mirroring it here keeps the X-Cart-Token header pointing at the
 *  cart the server just returned (self-healing after the server's defensive
 *  stale-token rotation: a header naming an account-bound row makes the
 *  server mint a fresh guest token the client must adopt to stay in sync).
 *  Account carts never echo a token (shapeCart nulls it), so this can never
 *  latch a session-scoped row onto the guest identity. */
export function syncCartToken(token: string | null | undefined): void {
  if (typeof window === "undefined") return;
  // Same charset/length class the server accepts (randomToken hex output).
  if (!token || !/^[a-f0-9]{8,64}$/i.test(token)) return;
  memoryTokens.set(CART_TOKEN_KEY, token);
  try {
    window.localStorage.setItem(CART_TOKEN_KEY, token);
  } catch {
    /* storage unavailable - the memory memo above keeps this page consistent */
  }
}

/** Retire the device guest-cart token. PHASE 2.2 guest checkout restoration:
 *  the server merges the guest cart into the shopper's account cart at
 *  login/registration and retires ITS cookie token (clearCartToken) - the
 *  client-side twin retires the localStorage/memo copy so post-logout
 *  X-Cart-Token headers can never address the now account-bound cart row
 *  (a stale header would make GET /api/cart read empty forever and every
 *  add-to-cart mint an orphan row the client can never reach again). */
export function clearDeviceCartToken(): void {
  if (typeof window === "undefined") return;
  memoryTokens.delete(CART_TOKEN_KEY);
  try {
    window.localStorage.removeItem(CART_TOKEN_KEY);
  } catch {
    /* storage unavailable - the memo delete above is what matters */
  }
}

/** Headers carrying the guest cart + shopper device identity (plus the
 * CSRF origin-gate marker — see webHeaders above). */
export function deviceHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  return {
    [CLIENT_MARKER]: CLIENT_MARKER_VALUE,
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

/** Authorization header for portal APIs when a session token is stored.
 * ALWAYS carries the CSRF origin-gate marker — including pre-login requests
 * (login/register), where no Bearer exists yet. */
export function authHeaders(): Record<string, string> {
  const t = getSessionToken();
  return t ? { Authorization: `Bearer ${t}`, [CLIENT_MARKER]: CLIENT_MARKER_VALUE } : { [CLIENT_MARKER]: CLIENT_MARKER_VALUE };
}
