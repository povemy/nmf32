// Seller Insights — pseudonymous visitor identity (first-party cookies).
//
// Design (see docs/seller-insights/metric-definitions.md):
//  - `nm_ins_vid` (visitor id): random token, 365-day cookie. "Unique visitors"
//    is an ESTIMATE keyed on this cookie — cookie deletion resets identity.
//  - `nm_ins_sid` (session id): `{token}.{mintedAtMs}`, 24h cookie refreshed on
//    every tracked event; the SESSION itself is server-side defined: a new id is
//    minted after 30 minutes of inactivity (GA-style session window). "Visits"
//    = distinct session ids.
//  - httpOnly + SameSite=None + Secure — identical posture to the app's session
//    and cart cookies (survives the cross-site iframe preview panel; localhost
//    is a trustworthy origin for Chromium/Firefox so dev still works).
//  - NO IP addresses, NO user-agent, NO fingerprinting, NO PII. Authenticated
//    shopperId is attached only to cart events (where the route already knows it).
import { cookies } from "next/headers";
import { randomToken } from "@/lib/password";

const VISITOR_COOKIE = "nm_ins_vid";
const SESSION_COOKIE = "nm_ins_sid";
const VISITOR_TTL_S = 365 * 24 * 60 * 60; // 1 year
const SESSION_TTL_S = 24 * 60 * 60; // cookie life (id rotates sooner via window)
/** A session ends after 30 minutes without a tracked event (documented rule). */
export const SESSION_WINDOW_MS = 30 * 60 * 1000;

const TOKEN_RE = /^[a-f0-9]{8,64}$/i;

export type InsightsIdentity = {
  visitorId: string;
  sessionId: string;
  sessionMintedAt: number;
};

const cookieOptions = {
  httpOnly: true,
  sameSite: "none" as const,
  secure: true,
  path: "/",
};

function parseSessionCookie(raw: string | undefined): { token: string; mintedAt: number } | null {
  if (!raw) return null;
  const idx = raw.lastIndexOf(".");
  if (idx <= 0) return null;
  const token = raw.slice(0, idx);
  const mintedAt = Number(raw.slice(idx + 1));
  if (!TOKEN_RE.test(token) || !Number.isFinite(mintedAt) || mintedAt <= 0) return null;
  return { token, mintedAt };
}

/**
 * Resolve (and lazily mint/rotate) the pseudonymous analytics identity for the
 * CURRENT request. Must be called inside a route handler (uses `cookies()`).
 * Never throws — on any cookie-access problem it returns a per-call ephemeral
 * identity so the host request is never endangered (events still dedup safely
 * per process call; see queue.ts).
 */
export async function resolveInsightsIdentity(): Promise<InsightsIdentity> {
  try {
    const store = await cookies();
    const now = Date.now();

    let visitorId = store.get(VISITOR_COOKIE)?.value ?? "";
    if (!TOKEN_RE.test(visitorId)) {
      visitorId = randomToken(16);
      store.set(VISITOR_COOKIE, visitorId, { ...cookieOptions, maxAge: VISITOR_TTL_S });
    }

    let sess = parseSessionCookie(store.get(SESSION_COOKIE)?.value);
    if (!sess || now - sess.mintedAt > SESSION_WINDOW_MS) {
      // No prior session, or the 30-minute inactivity window elapsed → new id.
      sess = { token: randomToken(16), mintedAt: now };
    } else {
      // Sliding window (documented semantics): a tracked event refreshes the
      // inactivity window — the SAME visit token continues. (Audit fix: the
      // previous code never re-set the cookie in this branch, so mintedAt
      // never advanced and a continuously-active visitor was fragmented into
      // a new session every 30 minutes of elapsed time.)
      sess = { token: sess.token, mintedAt: now };
    }
    // Cookie re-set on every tracked event: keeps mintedAt sliding and the
    // 24 h cookie life refreshed for active visits.
    store.set(SESSION_COOKIE, `${sess.token}.${sess.mintedAt}`, { ...cookieOptions, maxAge: SESSION_TTL_S });

    return { visitorId, sessionId: sess.token, sessionMintedAt: sess.mintedAt };
  } catch {
    // Cookie access unavailable (e.g. static render) — ephemeral identity.
    const now = Date.now();
    return { visitorId: `eph_${randomToken(8)}`, sessionId: `eph_${randomToken(8)}`, sessionMintedAt: now };
  }
}
