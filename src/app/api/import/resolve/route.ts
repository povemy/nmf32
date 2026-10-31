// POST /api/import/resolve — detect marketplace + validate a pasted URL (public).
// NOTE (p10-a): handler was previously `return handle(...)` (returned the wrapped
// function instead of a Response → 500). Normalised to the repo-standard
// `export const POST = handle(...)` pattern; logic unchanged.
// B5 (SSRF hardening): 5/min/IP rate limit + onboarding capability issuance.
// Anonymous (pre-registration) visitors import a product URL to create a
// claimable store — the accountless onboarding flow keeps working, but they now
// receive a short-lived signed `import_cap` cookie here (60 min) which
// POST /api/import/jobs requires. Sellers with a live session bypass it.
import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { handle, ok, fail, ApiError } from "@/lib/api";
import { resolveMarketplaceUrl, platformLabel } from "@/lib/marketplaces/resolver";
import { getConnector } from "@/lib/marketplaces";
import { rateLimit } from "@/lib/rate-limit";
import { getSession } from "@/lib/auth";
import { randomToken, safeEqual } from "@/lib/secretbox";
import { hmacSha256Hex } from "@/lib/password";
import type { AuthStatus } from "@/lib/marketplaces/types";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Import capability (B5) — DELIBERATELY DUPLICATED byte-identically in
// ../jobs/route.ts (a shared src/lib/import-cap.ts is the natural home but is
// outside this task's file scope). Keep both copies in sync.
//
// Cookie:  import_cap = {nonce}.{issuedAtMs}.{hmac}
//   hmac   = hmacSHA256(secret, nonce + "." + issuedAtMs)
// The issuedAtMs is carried in the cookie so the 60-minute age can be verified
// statelessly (a MAC over nonce+timestamp alone could not be re-checked).
//
// Secret: IMPORT_CAP_SECRET, resolved at CALL time. Fail-closed in production —
// 503 IMPORT_CAP_SECRET_UNSET, mirroring the PSP webhook secret pattern in
// api/webhooks/payments/process.ts (a public demo constant must never be able
// to mint production import capabilities). Sandbox/dev falls back to the
// documented public demo constant so accountless onboarding works without env
// setup. Startup validation in src/instrumentation-node.ts warns loudly.
// ---------------------------------------------------------------------------
const CAP_COOKIE = "import_cap";
const CAP_TTL_MS = 60 * 60 * 1000;

function importCapSecret(): string {
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

function issueImportCap(): string {
  const secret = importCapSecret();
  const nonce = randomToken(24);
  const issuedAtMs = String(Date.now());
  const mac = hmacSha256Hex(secret, `${nonce}.${issuedAtMs}`);
  return `${nonce}.${issuedAtMs}.${mac}`;
}

function verifyImportCap(raw: string | undefined | null): boolean {
  if (!raw) return false;
  const parts = raw.split(".");
  if (parts.length !== 3) return false;
  const [nonce, issuedAtMs, mac] = parts;
  if (!nonce || !/^\d{1,16}$/.test(issuedAtMs) || !/^[0-9a-f]{64}$/.test(mac)) return false;
  const issuedAt = Number(issuedAtMs);
  const now = Date.now();
  if (issuedAt > now + 60_000) return false; // issued in the future → reject (60s skew tolerance)
  if (now - issuedAt > CAP_TTL_MS) return false; // expired
  let secret: string;
  try {
    secret = importCapSecret();
  } catch {
    return false; // production without the secret → nothing can verify
  }
  return safeEqual(mac, hmacSha256Hex(secret, `${nonce}.${issuedAtMs}`));
}

export const POST = handle(async (req: NextRequest) => {
  rateLimit(req, "import", 5);
  const body = (await req.json().catch(() => ({}))) as { url?: string };
  if (!body.url || typeof body.url !== "string") {
    return fail(400, "MISSING_URL", "Paste a marketplace URL first.");
  }
  // Capability: sellers bypass; anonymous callers get a fresh cap when their
  // cookie is missing/invalid/expired. Issued BEFORE URL validation so a 400 on
  // the URL itself never eats the capability.
  const session = await getSession().catch(() => null);
  let setCap = false;
  if (session?.userType !== "seller") {
    if (!verifyImportCap(req.cookies.get(CAP_COOKIE)?.value)) {
      const store = await cookies();
      store.set(CAP_COOKIE, issueImportCap(), {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: CAP_TTL_MS / 1000,
      });
      setCap = true;
    }
  }
  const resolved = await resolveMarketplaceUrl(body.url);
  const connector = getConnector(resolved.platform);
  const auth: AuthStatus = await connector.authStatus();
  return ok({
    platform: resolved.platform,
    platformLabel: platformLabel(resolved.platform),
    urlType: resolved.urlType,
    shopId: resolved.shopId ?? null,
    productId: resolved.productId ?? null,
    normalizedUrl: resolved.normalizedUrl,
    isFixture: resolved.platform === "fixture",
    // true when this response carries a fresh import_cap cookie — the client
    // knows it may proceed straight to POST /api/import/jobs
    setCap,
    connector: {
      envConfigured: auth.envConfigured,
      connected: auth.connected,
      needsAuthorisation: auth.needsAuthorisation,
      missingEnv: auth.missing,
    },
  });
});
