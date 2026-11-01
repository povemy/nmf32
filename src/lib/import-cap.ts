// ============================================================================
// Import onboarding capability (Phase 1 / B5) — PHASE 2.1 consolidation +
// abuse controls. Previously byte-duplicated in api/import/resolve and
// api/import/jobs (both marked "keep in sync"); now the single source.
//
// Cookie:  import_cap = {nonce}.{issuedAtMs}.{hmac}
//   hmac   = hmacSHA256(IMPORT_CAP_SECRET, nonce + "." + issuedAtMs)
//   TTL    60 minutes, stateless verification (no server-side issuance record).
//
// Secret: IMPORT_CAP_SECRET resolved at CALL time; fail-closed in production
// (503 IMPORT_CAP_SECRET_UNSET — a public demo constant must never mint
// production capabilities). Sandbox/dev falls back to the documented demo
// constant so accountless onboarding works without env setup. Startup
// validation in src/instrumentation-node.ts warns loudly.
//
// PHASE 2.1 (§8) — capability-abuse controls ON TOP of the stateless cookie:
//   • PER-CAPABILITY JOB BUDGET: anonymous job creation is keyed by the
//     capability NONCE (rateLimitKey, 15 jobs / capability / hour) — one
//     cookie can no longer mint unlimited jobs within the IP throttle.
//   • Scope: a capability authorizes ONLY /api/import/jobs creation; it grants
//     no store access, no session, and cannot be presented to any other route.
//   • Replay across IPs is bounded by the nonce-keyed budget + the 5/min/IP
//     route throttle + the 60-minute TTL.
//   • Revocation: stateless MAC → no revocation list; rotation of
//     IMPORT_CAP_SECRET invalidates every outstanding capability instantly
//     (acceptable: 60-minute window, issuance is cheap and re-issued on the
//     next resolve call).
// ============================================================================
import { NextRequest } from "next/server";
import { ApiError } from "./api";
import { randomToken, safeEqual } from "./secretbox";
import { hmacSha256Hex } from "./password";
import { rateLimitKey } from "./rate-limit";

export const IMPORT_CAP_COOKIE = "import_cap";
export const IMPORT_CAP_TTL_MS = 60 * 60 * 1000;
/** PHASE 2.1: anonymous import jobs per capability nonce per hour. Legitimate
 *  onboarding needs a handful of attempts; 15 leaves comfortable headroom for
 *  retries/multi-product imports while capping scripted spam 20× below the
 *  previous effective ceiling (5/min/IP × 60 min). */
export const IMPORT_CAP_JOB_BUDGET = 15;
export const IMPORT_CAP_JOB_BUDGET_WINDOW_MS = 60 * 60 * 1000;

export function importCapSecret(): string {
  const secret = process.env.IMPORT_CAP_SECRET;
  if (secret && secret.length > 0) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new ApiError(
      503,
      "IMPORT_CAP_SECRET_UNSET",
      "IMPORT_CAP_SECRET is not configured — import capability issuance is disabled (fail closed)"
    );
  }
  return "sm_import_cap_dev";
}

export function issueImportCap(): string {
  const secret = importCapSecret();
  const nonce = randomToken(24);
  const issuedAtMs = String(Date.now());
  const mac = hmacSha256Hex(secret, `${nonce}.${issuedAtMs}`);
  return `${nonce}.${issuedAtMs}.${mac}`;
}

export function verifyImportCap(raw: string | undefined | null): boolean {
  if (!raw) return false;
  const parts = raw.split(".");
  if (parts.length !== 3) return false;
  const [nonce, issuedAtMs, mac] = parts;
  if (!nonce || !/^\d{1,16}$/.test(issuedAtMs) || !/^[0-9a-f]{64}$/.test(mac)) return false;
  const issuedAt = Number(issuedAtMs);
  const now = Date.now();
  if (issuedAt > now + 60_000) return false; // issued in the future → reject (60s skew tolerance)
  if (now - issuedAt > IMPORT_CAP_TTL_MS) return false; // expired
  let secret: string;
  try {
    secret = importCapSecret();
  } catch {
    return false; // production without the secret → nothing can verify
  }
  return safeEqual(mac, hmacSha256Hex(secret, `${nonce}.${issuedAtMs}`));
}

/** The nonce segment of a capability cookie (or null when malformed) — the
 *  per-capability identity for job-budget accounting. */
export function importCapNonce(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const parts = raw.split(".");
  return parts.length === 3 && parts[0] ? parts[0] : null;
}

/** PHASE 2.1 (§8): enforce the per-capability job budget BEFORE creating an
 *  anonymous import job. Throws 429 RATE_LIMITED (rateLimitKey semantics) when
 *  the capability's hourly budget is exhausted — the caller must NOT fall back
 *  to capability-less creation; re-solving a URL after the TTL mints a fresh
 *  capability (the documented self-service path). */
export function enforceImportCapJobBudget(rawCap: string | undefined | null): void {
  const nonce = importCapNonce(rawCap);
  if (!nonce) return; // malformed caps never reach job creation (verifyImportCap gates first)
  rateLimitKey(nonce, "import-cap-jobs", IMPORT_CAP_JOB_BUDGET, IMPORT_CAP_JOB_BUDGET_WINDOW_MS);
}

/** Cookie flags for issuance — httpOnly, SameSite=Lax (same-site navigation +
 *  the proxy.ts CSRF gate cover cross-site abuse), Secure in production. */
export const IMPORT_CAP_COOKIE_MAX_AGE = IMPORT_CAP_TTL_MS / 1000;
