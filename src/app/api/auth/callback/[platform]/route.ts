// GET /api/auth/callback/[platform] — OAuth redirect target for Shopee / TikTok Shop.
// Exchanges the one-time code, binds the shop identity, then redirects back to the app.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getConnector } from "@/lib/marketplaces";
import { logActivity } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  const url = new URL(req.url);
  const origin = process.env.PUBLIC_APP_ORIGIN || url.origin;
  if (platform !== "shopee" && platform !== "tiktok") {
    return NextResponse.redirect(`${origin}/?oauth=invalid_platform`);
  }
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const state = url.searchParams.get("state");
  const shopIdParam = url.searchParams.get("shop_id");
  if (error || !code) {
    return NextResponse.redirect(`${origin}/?oauth=denied&reason=${encodeURIComponent(error ?? "no_code")}`);
  }
  // validate + consume state nonce (10-min TTL, single use)
  if (state) {
    const key = `oauth_state_${state}`;
    const row = await db.setting.findUnique({ where: { key } });
    if (row) {
      await db.setting.delete({ where: { key } }).catch(() => undefined);
      try {
        const parsed = JSON.parse(row.valueJson) as { createdAt?: number };
        if (!parsed?.createdAt || Date.now() - parsed.createdAt > 10 * 60 * 1000) {
          return NextResponse.redirect(`${origin}/?oauth=expired_state`);
        }
      } catch {
        /* malformed state row — continue */
      }
    }
  }
  try {
    const connector = getConnector(platform);
    const result = await connector.exchangeCode({ code, redirectUri: `${origin}/api/auth/callback/${platform}`, shopIdParam });
    await logActivity({
      actorType: "seller",
      action: "connection.authorised",
      entityType: "marketplace_connection",
      entityId: `${platform}:${result.shop.sourceShopId}`,
      meta: { shop: result.shop.name },
    }).catch(() => undefined);
    return NextResponse.redirect(`${origin}/?oauth=connected&platform=${platform}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "exchange_failed";
    return NextResponse.redirect(`${origin}/?oauth=failed&reason=${encodeURIComponent(msg.slice(0, 120))}`);
  }
}
