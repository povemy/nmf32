import { db } from "@/lib/db";
import { handle, ok, fail } from "@/lib/api";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { sha256Hex } from "@/lib/secretbox";

export const dynamic = "force-dynamic";

// POST /api/chat/hub-auth { token, rooms: string[] } — F-06 remediation.
//
// AUTHORITATIVE socket-handshake authorization for the chat hub mini-service
// (:3003). The hub deliberately stays persistence-free; on every socket
// connection and every room-join batch it calls THIS endpoint, which validates
// the presented session token and each requested room against the real
// membership rules:
//   • user:{userId}      → only the authenticated principal's own room
//   • thread:{threadId}  → only threads where the principal is a participant
//     (shopper side: ChatThread.shopperId; seller side: the thread's store's
//      sellerId)
// The hub joins the socket ONLY to the rooms returned in `allowed`.
//
// No secrets are returned — just membership decisions for the caller's own
// identity. Rate-limited (the hub is expected to call this at connection +
// join cadence, both bounded by the hub's own per-socket guards).
const MAX_ROOMS_PER_CALL = 100;
const TOKEN_RE = /^[a-f0-9]{16,128}$/i;

export const POST = handle(async (req: Request) => {
  // C2.4 — two-tier rate limiting. The chat hub mini-service calls this
  // endpoint over loopback WITHOUT forwarding any client IP header, so the
  // per-IP bucket below is ONE shared bucket ("chat-hub-auth:unknown") for
  // the entire platform. At the old 120/min, an ordinary browser reconnect
  // storm (reconnectionAttempts: Infinity, ~60 sockets/min) exhausted it →
  // 429 → hub disconnect → infinite retry loop → platform-wide chat outage.
  // Tier 1 raises that shared bucket to a 600/min platform-wide backstop: it
  // bounds the session lookups a token-spray attacker (unlimited unique
  // tokens, each landing in its own Tier 2 bucket) can force, without
  // throttling legitimate aggregate reconnect load.
  rateLimit(req, "chat-hub-auth", 600);
  const body = (await req.json().catch(() => ({}))) as { token?: string; rooms?: unknown };
  const token = typeof body.token === "string" ? body.token.trim().toLowerCase() : "";
  const rooms = Array.isArray(body.rooms)
    ? body.rooms.filter((r): r is string => typeof r === "string" && r.length > 0 && r.length <= 128).slice(0, MAX_ROOMS_PER_CALL)
    : [];
  // C2.4 Tier 2 — identity-based: one bucket PER CREDENTIAL, keyed by the
  // first 24 hex chars of sha256(token) — never the raw secret, and never a
  // client-supplied identity header (the hub is not trusted to forward
  // identity; the hub also does NOT forward client IPs, which is why the
  // identity must come from the presented credential itself). 120/min per
  // credential means one shopper's reconnect loop can no longer consume
  // another's quota — the shared-"unknown" outage above becomes structurally
  // impossible. Applied before the session lookup so repeated identical
  // tokens (valid or not) are bounded before any DB work. The same full hash
  // doubles as the Session.token lookup key below.
  const tokenHash = sha256Hex(token);
  rateLimitKey(tokenHash.slice(0, 24), "chat-hub-auth:t", 120);
  if (!TOKEN_RE.test(token)) return fail(401, "UNAUTHORIZED", "A valid session token is required");

  // Session validation WITHOUT the request's own cookie/Bearer context — the
  // hub presents the socket's token explicitly. Phase 1 (C2): the token is
  // hashed before lookup — Session.token stores sha256(raw), never the raw.
  const session = await db.session.findUnique({ where: { token: tokenHash } });
  if (!session || session.expiresAt < new Date()) {
    return fail(401, "UNAUTHORIZED", "Session not found or expired");
  }

  // Status enforcement mirrors lib/auth.ts: suspended/terminated sellers and
  // non-active shoppers lose chat access with their store/account access.
  if (session.userType === "seller") {
    const seller = await db.seller.findUnique({ where: { id: session.userId }, select: { status: true } });
    if (!seller || seller.status === "suspended" || seller.status === "terminated") {
      return fail(403, "FORBIDDEN", "Seller account is not eligible for chat");
    }
  } else if (session.userType === "shopper") {
    const shopper = await db.shopperUser.findUnique({ where: { id: session.userId }, select: { status: true } });
    if (!shopper || shopper.status !== "active") {
      return fail(403, "FORBIDDEN", "Shopper account is not eligible for chat");
    }
  } else {
    // Admins have no chat surface (shopper↔seller conversations only).
    return fail(403, "FORBIDDEN", "Admin sessions have no chat rooms");
  }

  const allowed: string[] = [];
  const threadIds: string[] = [];
  for (const room of rooms) {
    if (room.startsWith("user:")) {
      if (room.slice(5) === session.userId) allowed.push(room);
    } else if (room.startsWith("thread:")) {
      const id = room.slice(7);
      if (id) threadIds.push(id);
    }
  }

  if (threadIds.length > 0) {
    // One query resolves participant membership for every requested thread.
    const threads = await db.chatThread.findMany({
      where: { id: { in: threadIds } },
      select: { id: true, shopperId: true, store: { select: { sellerId: true } } },
    });
    const byId = new Map(threads.map((t) => [t.id, t]));
    for (const id of threadIds) {
      const t = byId.get(id);
      if (!t) continue; // unknown thread → not joined (no existence signal back)
      const participant =
        (session.userType === "shopper" && t.shopperId === session.userId) ||
        (session.userType === "seller" && t.store.sellerId === session.userId);
      if (participant) allowed.push(`thread:${id}`);
    }
  }

  return ok({ ok: true, user: { userType: session.userType, userId: session.userId }, allowed, denied: rooms.length - allowed.length });
});
