// Shared OAuth callback + begin-authorisation plumbing for Shopee/TikTok.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseJson, toJson } from "@/lib/json";
import { randomToken } from "@/lib/secretbox";
import { ApiError } from "@/lib/api";
import { getConnector } from "@/lib/marketplaces";
import type { Platform } from "@/lib/marketplaces/types";

export const OAUTH_PLATFORMS = ["shopee", "tiktok"] as const;
export type OAuthPlatform = (typeof OAUTH_PLATFORMS)[number];

export function isOAuthPlatform(p: string): p is OAuthPlatform {
  return (OAUTH_PLATFORMS as readonly string[]).includes(p);
}

/** Env-registered redirect URI, falling back to this app's callback route. */
export function redirectUriFor(platform: OAuthPlatform, origin: string): string {
  const envName = platform === "shopee" ? "SHOPEE_REDIRECT_URI" : "TIKTOK_SHOP_REDIRECT_URI";
  return process.env[envName] ?? `${origin}/api/auth/callback/${platform}`;
}

/** Build the authorisation URL and persist the CSRF state (10-minute TTL row). */
export async function beginAuthorisation(platform: OAuthPlatform, origin: string) {
  const connector = getConnector(platform);
  const auth = await connector.authStatus();
  if (!auth.envConfigured) {
    throw new ApiError(409, "MARKETPLACE_NOT_CONFIGURED", `Platform credentials are missing: ${auth.missing.join(", ")}`);
  }
  const state = randomToken(16);
  const redirectUri = redirectUriFor(platform, origin);
  await db.setting.create({
    data: {
      key: `oauth_state_${state}`,
      valueJson: toJson({ platform, redirectUri, createdAt: new Date().toISOString() }),
      description: "OAuth CSRF state — single-use, 10 min TTL",
    },
  });
  const result = await connector.beginAuthorisation({ redirectUri, state });
  if (!result) {
    throw new ApiError(409, "MARKETPLACE_NOT_CONFIGURED", "This connector cannot start an authorisation flow (credentials missing)");
  }
  return result;
}

/** Validate + consume the state row. Returns null when valid, else an error message. */
async function consumeState(state: string, platform: OAuthPlatform): Promise<string | null> {
  const setting = await db.setting.findUnique({ where: { key: `oauth_state_${state}` } });
  if (!setting) return "Authorisation state is invalid or already used — start the connection again";
  await db.setting.delete({ where: { key: `oauth_state_${state}` } }).catch(() => undefined);
  const meta = parseJson<{ platform?: string; createdAt?: string }>(setting.valueJson, {});
  if (meta.platform && meta.platform !== platform) return "Authorisation state does not match this platform";
  if (meta.createdAt && Date.now() - new Date(meta.createdAt).getTime() > 10 * 60 * 1000) {
    return "Authorisation state expired — start the connection again";
  }
  return null;
}

/**
 * GET /api/auth/callback/{platform}?code=…&shop_id=…&state=…
 * Exchanges the code (connector seals tokens into MarketplaceConnection) and
 * 302-redirects back to the single-route app. Errors redirect with a message
 * param instead of an error envelope because this is a browser redirect target.
 */
export async function handleOAuthCallback(req: Request, platform: OAuthPlatform): Promise<NextResponse> {
  const url = new URL(req.url);
  const back = (params: Record<string, string>) => {
    const target = new URL("/", url.origin);
    target.hash = "claim=connected";
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
    return NextResponse.redirect(target, 302);
  };
  const failRedirect = (message: string) => back({ claim_error: message.slice(0, 180) });

  const code = url.searchParams.get("code");
  if (!code || code === "null") {
    return failRedirect(url.searchParams.get("error") ?? "Authorisation was cancelled");
  }
  const state = url.searchParams.get("state");
  if (state) {
    const stateError = await consumeState(state, platform);
    if (stateError) return failRedirect(stateError);
  }
  try {
    const connector = getConnector(platform);
    const shopIdParam = url.searchParams.get("shop_id") ?? url.searchParams.get("shop_id_param");
    const { shop } = await connector.exchangeCode({
      code,
      redirectUri: redirectUriFor(platform, url.origin),
      shopIdParam,
    });
    return back({ claim: "connected", shop: shop.name.slice(0, 80) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Token exchange failed";
    return failRedirect(message);
  }
}

export type { Platform };
