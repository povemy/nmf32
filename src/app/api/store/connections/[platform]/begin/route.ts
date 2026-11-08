// GET /api/store/connections/[platform]/begin — start the OAuth authorisation flow.
// Returns the marketplace authorise URL; state nonce is persisted (Setting table, 10-min TTL).
import { NextRequest } from "next/server";
import { handle, ok, fail } from "@/lib/api";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { randomToken } from "@/lib/secretbox";
import { getConnector } from "@/lib/marketplaces";
import type { Platform } from "@/lib/marketplaces/types";
import type { SellerConnectionBeginData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

export const GET = handle(async function (_req: NextRequest, ctx: { params: Promise<{ platform: string }> }) {
    const { platform } = await ctx.params;
    if (platform !== "shopee" && platform !== "tiktok") return fail(400, "INVALID_PLATFORM", "Platform must be shopee or tiktok.");
    const session = await getSession();
    if (!session || session.userType !== "seller") return fail(401, "UNAUTHENTICATED", "Seller session required.");

    const state = randomToken(16);
    await db.setting.upsert({
      where: { key: `oauth_state_${state}` },
      create: { key: `oauth_state_${state}`, valueJson: JSON.stringify({ sellerId: session.userId, platform, createdAt: Date.now() }) },
      update: { valueJson: JSON.stringify({ sellerId: session.userId, platform, createdAt: Date.now() }) },
    });

    // The sandbox single-origin gateway proxies /api/*; the marketplace redirect lands on
    // /api/auth/callback/{platform} which completes the exchange. redirectUri uses the
    // configured public origin when provided (marketplaces require pre-registered domains).
    const origin = process.env.PUBLIC_APP_ORIGIN ?? "";
    const redirectUri = `${origin || ""}/api/auth/callback/${platform}`.replace(/^\/api/, "/api");
    const connector = getConnector(platform as Platform);
    const begin = await connector.beginAuthorisation({ redirectUri, state });
    const payload: SellerConnectionBeginData = {
      authorizeUrl: begin?.authorizeUrl ?? null,
      state,
      envConfigured: Boolean(begin),
    };
    return ok(payload);
});
