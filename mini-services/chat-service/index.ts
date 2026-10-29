// SHOPMESH chat hub — socket.io broadcast mini service (port 3003).
// Persistence lives in the Next.js API routes; this service only relays
// events to rooms so shoppers & sellers see new messages instantly.
// Next API POSTs to /broadcast after saving a message.
//
// Room model:
//   thread:{threadId} — every open conversation (message fan-out to both parties)
//   user:{userId}     — per-user inbox feed (thread list refresh + NEW-thread push,
//                       so a seller sees a brand-new conversation without a reload)
//
// SPLIT-BRAIN GUARD: this process owns BOTH the public socket port (3003) and
// the internal relay port (3103). If either port is taken (a stale duplicate
// instance), the servers emit "error" and we EXIT immediately — a half-alive
// instance (relay without sockets, or sockets without relay) silently drops
// every message, which is exactly the "messages only arrive after refresh"
// bug a duplicate `bun --hot` process caused. Loud failure beats silent loss.
//
// ---------------------------------------------------------------------------
// F-06 REMEDIATION — authenticated connections, authorized rooms, sealed relay.
// ---------------------------------------------------------------------------
//   • CONNECTION AUTH: every socket must present a session token in the
//     handshake (auth: { token }); the AUTHORITATIVE app validates it via
//     POST {APP_BASE}/api/chat/hub-auth. Unauthenticated sockets are
//     disconnected immediately — room-id secrecy is no longer the only
//     confidentiality control.
//   • ROOM AUTHORIZATION: every "join" batch is validated the same way
//     (user rooms: own id only; thread rooms: participant only). The hub
//     joins the socket ONLY to the rooms the app allows.
//   • RELAY SECRET: POST /broadcast on :3103 requires the x-chat-relay-secret
//     header matching CHAT_RELAY_SECRET (timing-safe). Production without the
//     secret rejects every broadcast (fail closed); dev uses the documented
//     public fallback so sandbox rails keep working.
//   • The hub stays persistence-free on purpose (the Next API remains the
//     single source of truth); authorization is delegated to it.
// ---------------------------------------------------------------------------
import { createServer } from "http";
import { createHash, timingSafeEqual } from "crypto";
import { Server } from "socket.io";

/** Authoritative app base (the Next server). Server-to-server on localhost. */
const APP_BASE = process.env.CHAT_APP_BASE_URL ?? "http://127.0.0.1:3000";
const TOKEN_RE = /^[a-f0-9]{16,128}$/i;
/** Per-socket join-event throttle: burst of 30, then 1 per 500 ms sustained. */
const JOIN_BURST = 30;

/** F-06 fail-closed relay secret (see header). */
function relaySecret(): string | null {
  const s = process.env.CHAT_RELAY_SECRET;
  if (s && s.length > 0) return s;
  return process.env.NODE_ENV === "production" ? null : "sm_chat_relay_dev";
}

function secretMatches(presented: string, secret: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

/** Ask the authoritative app: is this token a live session, and which of these
 *  rooms may it join? Never throws — network failures DENY (fail closed). */
async function authorizeRooms(token: string, rooms: string[]): Promise<{ ok: boolean; allowed: string[] }> {
  try {
    const res = await fetch(`${APP_BASE}/api/chat/hub-auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, rooms }),
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return { ok: false, allowed: [] };
    const body = (await res.json().catch(() => ({}))) as { data?: { allowed?: string[] } };
    return { ok: true, allowed: Array.isArray(body.data?.allowed) ? body.data!.allowed! : [] };
  } catch {
    return { ok: false, allowed: [] };
  }
}

const httpServer = createServer();

const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: "/",
  cors: {
    // Reflect the caller's Origin instead of "*": browser XHR/WebSocket
    // handshakes are credentialed, and wildcard ACAO is invalid with
    // credentials. Reflection accepts all origins — the hub itself carries no
    // secrets, and since F-06 every socket must authenticate with a valid
    // session token before it can join (let alone receive) any room.
    origin: true,
    credentials: true,
    methods: ["GET", "POST"],
  },
  // NOTE (F-06): authentication happens in the `connection` handler via the
  // socket.io CONNECT packet's auth payload (socket.handshake.auth.token) —
  // the engine-level allowRequest hook cannot see it (the payload is not a
  // query parameter). Unauthenticated sockets are disconnected in the
  // connection handler before they can join a single room, and joins are
  // independently authorized, so an unauthenticated socket is inert.
  pingTimeout: 60000,
  pingInterval: 25000,
});

function allowedRoom(r: unknown): r is string {
  return typeof r === "string" && (r.startsWith("thread:") || r.startsWith("user:"));
}

io.on("connection", (socket) => {
  console.log("[chat-hub] socket connected:", socket.id);
  const tokenRaw = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
  const token = typeof tokenRaw === "string" ? tokenRaw.trim().toLowerCase() : "";

  // F-06: an unauthenticated socket may not stay connected even without joins.
  if (!TOKEN_RE.test(token)) {
    socket.disconnect(true);
    return;
  }
  // Validate the session against the authoritative app (fail closed).
  void authorizeRooms(token, []).then(({ ok }) => {
    if (!ok) {
      console.log("[chat-hub] handshake token rejected by app:", socket.id);
      socket.disconnect(true);
    }
  });

  // Per-socket join throttle (abuse guard so one socket cannot hammer the
  // authorization endpoint through the hub).
  let joinBudget = JOIN_BURST;
  const refill = setInterval(() => {
    if (joinBudget < JOIN_BURST) joinBudget += 1;
  }, 500);
  socket.data.joinBudget = () => {
    if (joinBudget <= 0) return false;
    joinBudget -= 1;
    return true;
  };

  // client subscribes to its conversation + user rooms — membership is
  // AUTHORIZED BY THE APP; only allowed rooms are actually joined.
  socket.on("join", async (data: { rooms?: string[]; room?: string }) => {
    try {
      if (!socket.data.joinBudget?.()) return; // throttled — silently ignored
      const rooms = (data.rooms ?? (data.room ? [data.room] : [])).filter(allowedRoom).slice(0, 100);
      if (rooms.length === 0) return;
      const { allowed } = await authorizeRooms(token, rooms);
      for (const r of allowed) {
        socket.join(r);
      }
      if (allowed.length < rooms.length) {
        console.log(`[chat-hub] join denied ${rooms.length - allowed.length} room(s) for socket ${socket.id}`);
      }
    } catch {
      /* authorization failures deny by construction */
    }
  });

  socket.on("leave", (data: { room: string }) => {
    if (allowedRoom(data?.room)) socket.leave(data.room);
  });

  socket.on("error", (err) => {
    console.error("[chat-hub] socket error:", err?.message ?? err);
  });

  socket.on("disconnect", () => {
    clearInterval(refill);
  });
});

// Port conflicts must kill THIS process, not linger half-alive.
httpServer.on("error", (err: NodeJS.ErrnoException) => {
  console.error(`[chat-hub] FATAL public listener :3003 — ${err.code ?? err.message}. Exiting so the supervisor restarts a clean instance.`);
  process.exit(1);
});

// internal relay on a SEPARATE port — socket.io owns the public listener's
// request handler, so the Next API calls this relay instead of the main server.
const relay = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/broadcast") {
    // F-06: the relay is authenticated with the shared secret (fail closed in
    // production without CHAT_RELAY_SECRET; dev uses the documented fallback).
    const secret = relaySecret();
    const presented = req.headers["x-chat-relay-secret"];
    const presentedStr = typeof presented === "string" ? presented : Array.isArray(presented) ? String(presented[0]) : "";
    if (!secret || !presentedStr || !secretMatches(presentedStr, secret)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized relay" }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy(); // abuse guard
    });
    req.on("end", () => {
      try {
        const body = JSON.parse(raw) as { room?: string; rooms?: string[]; event: string; payload: unknown };
        const rooms = (body.rooms ?? (body.room ? [body.room] : [])).filter(allowedRoom);
        if (rooms.length === 0 || typeof body.event !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "bad room/event" }));
          return;
        }
        for (const r of rooms) io.to(r).emit(body.event, body.payload);
        console.log("[chat-hub] broadcast to", rooms.join(","), body.event);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "bad json" }));
      }
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not found" }));
});
relay.on("error", (err: NodeJS.ErrnoException) => {
  console.error(`[chat-hub] FATAL relay listener :3103 — ${err.code ?? err.message}. Exiting so the supervisor restarts a clean instance.`);
  process.exit(1);
});
relay.listen(3103, () => {
  console.log("[chat-hub] internal broadcast relay on port 3103 (secret required)");
});

const PORT = 3003;
httpServer.listen(PORT, () => {
  console.log(`[chat-hub] socket.io broadcast hub on port ${PORT} (authenticated)`);
});

process.on("SIGTERM", () => {
  httpServer.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  httpServer.close(() => process.exit(0));
});
