// Chat helpers — persistence happens in the Next API routes (authoritative),
// the socket.io mini service on port 3003 is a dumb broadcast hub. After a
// message is saved we ping the hub so everyone in the thread room gets the
// new message instantly.
const CHAT_HUB_URL = "http://127.0.0.1:3103/broadcast";

export async function broadcastToThread(threadId: string, event: string, payload: unknown): Promise<void> {
  try {
    const res = await fetch(CHAT_HUB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: `thread:${threadId}`, event, payload }),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) console.error("[chat] hub relay responded", res.status);
  } catch (e) {
    console.error("[chat] hub relay failed:", e instanceof Error ? e.message : e);
    // hub offline — clients still see the message on next load; non-fatal
  }
}
