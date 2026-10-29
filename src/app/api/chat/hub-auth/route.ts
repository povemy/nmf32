import { db } from "@/lib/db";
import { handle, ok, fail } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";

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
  rateLimit(req, "chat-hub-auth", 120);
  const body = (await req.json().catch(() => ({}))) as { token?: string; rooms?: unknown };
  const token = typeof body.token === "string" ? body.token.trim().toLowerCase() : "";
  const rooms = Array.isArray(body.rooms)
    ? body.rooms.filter((r): r is string => typeof r === "string" && r.length > 0 && r.length <= 128).slice(0, MAX_ROOMS_PER_CALL)
    : [];
  if (!TOKEN_RE.test(token)) return fail(401, "UNAUTHORIZED", "A valid session token is required");

  // Session validation WITHOUT the request's own cookie/Bearer context — the
  // hub presents the socket's token explicitly.
  const session = await db.session.findUnique({ where: { token } });
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
