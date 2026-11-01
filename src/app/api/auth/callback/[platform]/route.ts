// GET /api/auth/callback/[platform] — OAuth redirect target for Shopee / TikTok Shop.
// Exchanges the one-time code, then redirects back to the app. The connection
// row written by exchangeCode carries no store binding (that is deferred to
// /api/claim/bind, which requires the single-use 192-bit claim token), but since
// PHASE 2.2 (C3 — OAuth ownership) it IS attributed to the initiating seller: the
// sellerId travels begin → signed `state` → this validation → exchangeCode, so
// the runner and claim/bind can scope by ownership instead of trusting the
// globally most-recent connection.
//
// F-22 (Phase 3): state validation now FAILS CLOSED. The CSRF nonce minted by
// GET /api/store/connections/[platform]/begin is REQUIRED, single-use
// (delete-first), platform-matched and TTL-bounded (10 min), and when it
// records the initiating sellerId it must match the seller session completing
// the flow — the classic OAuth cross-site-CSRF guard. Previously an absent,
// unknown, consumed or malformed state all proceeded (fail-open), and the
// sellerId stored in state was never compared, so a crafted callback could
// drive exchangeCode's global upsert (whose update branch overwrites tokens
// of an already-claimed shop) without any nonce at all.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getConnector } from "@/lib/marketplaces";
import { logActivity } from "@/lib/api";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

type StateMeta = { sellerId?: string; platform?: string; createdAt?: number | string };

/** begin route stores `Date.now()` (ms); tolerate an ISO string too. */
function parseCreatedAt(v: number | string | undefined): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

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

  // ---- F-22: strict, fail-closed nonce validation --------------------------------
  if (!state) {
    return NextResponse.redirect(`${origin}/?oauth=invalid_state`);
  }
  const key = `oauth_state_${state}`;
  const row = await db.setting.findUnique({ where: { key } });
  // Delete-first: single-use regardless of the validation outcome.
  await db.setting.delete({ where: { key } }).catch(() => undefined);
  if (!row) {
    return NextResponse.redirect(`${origin}/?oauth=invalid_state`);
  }
  let meta: StateMeta = {};
  try {
    meta = JSON.parse(row.valueJson) as StateMeta;
  } catch {
    return NextResponse.redirect(`${origin}/?oauth=invalid_state`);
  }
  if (meta.platform && meta.platform !== platform) {
    return NextResponse.redirect(`${origin}/?oauth=state_platform_mismatch`);
  }
  const created = parseCreatedAt(meta.createdAt);
  if (created == null || Date.now() - created > 10 * 60 * 1000) {
    return NextResponse.redirect(`${origin}/?oauth=expired_state`);
  }
  // Cross-seller CSRF guard: when the nonce records the initiating seller and
  // a seller session is completing the flow, they must match. Session-less
  // completion stays allowed — the cookie may legitimately be absent (iframe
  // Bearer-bridge surfaces), and final ownership is enforced by claim/bind's
  // hashed single-use token, not by this redirect.
  if (meta.sellerId) {
    const session = await getSession();
    if (session?.userType === "seller" && session.userId !== meta.sellerId) {
      return NextResponse.redirect(`${origin}/?oauth=state_seller_mismatch`);
    }
  }

  try {
    const connector = getConnector(platform);
    // PHASE 2.2 (C3): `meta.sellerId` was validated above (F-22 cross-seller
    // CSRF guard — it either matches the completing seller session or the flow
    // is session-less), so it is the trustworthy attribution for the connection
    // persisted by exchangeCode.
    const result = await connector.exchangeCode({
      code,
      redirectUri: `${origin}/api/auth/callback/${platform}`,
      shopIdParam,
      sellerId: meta.sellerId ?? null,
    });
    await logActivity({
      actorType: "seller",
      actorId: meta.sellerId ?? undefined,
      action: "connection.authorised",
      entityType: "marketplace_connection",
      entityId: `${platform}:${result.shop.sourceShopId}`,
      meta: { shop: result.shop.name, stateValidated: true },
    }).catch(() => undefined);
    return NextResponse.redirect(`${origin}/?oauth=connected&platform=${platform}`);
  } catch (err) {
    // Phase 2.3 (P2.3-6): production sanitization — connector exceptions can
    // embed upstream API payloads / internal request details; the redirect
    // reason (rendered by the front page) becomes a fixed code + ref id, and
    // the full error is logged server-side. Dev keeps the real message.
    if (process.env.NODE_ENV === "production") {
      const refId = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      console.error(`[oauth/callback:${platform}] ref=${refId} exchange failed:`, err);
      return NextResponse.redirect(`${origin}/?oauth=failed&reason=${encodeURIComponent(`exchange_failed (ref ${refId})`)}`);
    }
    const msg = err instanceof Error ? err.message : "exchange_failed";
    return NextResponse.redirect(`${origin}/?oauth=failed&reason=${encodeURIComponent(msg.slice(0, 120))}`);
  }
}
