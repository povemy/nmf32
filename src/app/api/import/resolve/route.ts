// POST /api/import/resolve — detect marketplace + validate a pasted URL (public).
// NOTE (p10-a): handler was previously `return handle(...)` (returned the wrapped
// function instead of a Response → 500). Normalised to the repo-standard
// `export const POST = handle(...)` pattern; logic unchanged.
import { NextRequest } from "next/server";
import { handle, ok, fail } from "@/lib/api";
import { resolveMarketplaceUrl, platformLabel } from "@/lib/marketplaces/resolver";
import { getConnector } from "@/lib/marketplaces";
import type { AuthStatus } from "@/lib/marketplaces/types";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  const body = (await req.json().catch(() => ({}))) as { url?: string };
  if (!body.url || typeof body.url !== "string") {
    return fail(400, "MISSING_URL", "Paste a marketplace URL first.");
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
    connector: {
      envConfigured: auth.envConfigured,
      connected: auth.connected,
      needsAuthorisation: auth.needsAuthorisation,
      missingEnv: auth.missing,
    },
  });
});
