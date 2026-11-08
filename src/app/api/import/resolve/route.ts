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
import {
  IMPORT_CAP_COOKIE,
  IMPORT_CAP_COOKIE_MAX_AGE,
  issueImportCap,
  verifyImportCap,
} from "@/lib/import-cap";
import type { AuthStatus } from "@/lib/marketplaces/types";
import type { SellerImportResolveBody, SellerImportResolveData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  rateLimit(req, "import", 5);
  const body = (await req.json().catch(() => ({}))) as SellerImportResolveBody;
  if (!body.url || typeof body.url !== "string") {
    return fail(400, "MISSING_URL", "Paste a marketplace URL first.");
  }
  // Capability: sellers bypass; anonymous callers get a fresh cap when their
  // cookie is missing/invalid/expired. Issued BEFORE URL validation so a 400 on
  // the URL itself never eats the capability.
  const session = await getSession().catch(() => null);
  let setCap = false;
  if (session?.userType !== "seller") {
    if (!verifyImportCap(req.cookies.get(IMPORT_CAP_COOKIE)?.value)) {
      const store = await cookies();
      store.set(IMPORT_CAP_COOKIE, issueImportCap(), {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: IMPORT_CAP_COOKIE_MAX_AGE,
      });
      setCap = true;
    }
  }
  const resolved = await resolveMarketplaceUrl(body.url);
  const connector = getConnector(resolved.platform);
  const auth: AuthStatus = await connector.authStatus();
  const payload: SellerImportResolveData = {
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
  };
  return ok(payload);
});
