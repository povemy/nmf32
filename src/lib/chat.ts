// Chat helpers — persistence happens in the Next API routes (authoritative),
// the socket.io mini service on port 3003 is a dumb broadcast hub. After a
// message is saved we ping the hub so everyone in the thread room gets the
// new message instantly.
//
// Room fan-out model:
//   thread:{threadId} → both parties' open conversation panels (instant bubbles)
//   user:{userId}     → per-user inbox feeds (thread-list refresh + NEW-thread
//                       push so a brand-new conversation appears without reload)
const CHAT_HUB_URL = "http://127.0.0.1:3103/broadcast";

/** F-06 remediation: the relay rejects broadcasts without the shared secret.
 *  Production without CHAT_RELAY_SECRET disables the relay call entirely
 *  (fail closed — live push is unavailable, HTTP routes stay authoritative);
 *  dev uses the documented public fallback so sandbox rails keep working. */
function relaySecret(): string | null {
  const s = process.env.CHAT_RELAY_SECRET;
  if (s && s.length > 0) return s;
  return process.env.NODE_ENV === "production" ? null : "sm_chat_relay_dev";
}

async function postBroadcast(rooms: string[], event: string, payload: unknown): Promise<void> {
  const secret = relaySecret();
  if (!secret) {
    console.error("[chat] hub relay disabled: CHAT_RELAY_SECRET is not configured (fail closed)");
    return;
  }
  try {
    const res = await fetch(CHAT_HUB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-chat-relay-secret": secret },
      body: JSON.stringify({ rooms, event, payload }),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) console.error("[chat] hub relay responded", res.status);
  } catch (e) {
    console.error("[chat] hub relay failed:", e instanceof Error ? e.message : e);
    // hub offline — clients still see the message on next load; non-fatal
  }
}

/** Broadcast `event` to the thread room plus any extra rooms (user feeds). */
export async function broadcastToThread(threadId: string, event: string, payload: unknown, extraRooms: string[] = []): Promise<void> {
  await postBroadcast([`thread:${threadId}`, ...extraRooms], event, payload);
}

/** Lightweight inbox-feed ping: tells a user's open clients that a thread
 *  changed (new message / new thread) so the list reloads and resorting +
 *  brand-new threads happen live. `snapshot` carries the fresh last-message
 *  preview so clients can update optimistically even before the reload. */
export async function notifyUserInbox(
  userIds: (string | null | undefined)[],
  input: { threadId: string; event: "chat:activity" | "chat:read"; at: string; preview?: string | null; senderType?: string | null }
): Promise<void> {
  const rooms = userIds.filter((u): u is string => !!u).map((u) => `user:${u}`);
  if (rooms.length === 0) return;
  await postBroadcast(rooms, input.event, { threadId: input.threadId, at: input.at, preview: input.preview ?? null, senderType: input.senderType ?? null });
}

/** Resolve the seller user id behind a store (for user-room fan-out). */
export async function sellerIdForStore(storeId: string): Promise<string | null> {
  const { db } = await import("./db");
  const store = await db.store.findUnique({ where: { id: storeId }, select: { sellerId: true } });
  return store?.sellerId ?? null;
}
