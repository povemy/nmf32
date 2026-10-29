import { io } from "socket.io-client";
const BASE = "http://localhost:3000";
let pass = 0, fail = 0;
const check = (n: string, c: boolean, e = "") => { console.log(`${c ? "PASS" : "FAIL"} — ${n}${e ? " (" + e + ")" : ""}`); c ? pass++ : fail++; };
const j = (r: Response) => r.json().catch(() => ({}));

// --- sessions ---
const stamp = Date.now().toString(36);
let res = await fetch(`${BASE}/api/auth/shopper/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `lt-chat-a-${stamp}@probe.local`, password: "ProbePass123!", fullName: "LT Chat A" }) });
let body = await j(res);
const shopperA = { id: body?.data?.shopper?.id, token: body?.data?.token };
check("shopper A registered", !!shopperA.token);
res = await fetch(`${BASE}/api/auth/shopper/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `lt-chat-b-${stamp}@probe.local`, password: "ProbePass123!", fullName: "LT Chat B" }) });
body = await j(res);
const shopperB = { id: body?.data?.shopper?.id, token: body?.data?.token };
check("shopper B registered", !!shopperB.token);
res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "lumina@nomofee.io", password: "Seller123!" }) });
body = await j(res);
const seller = { id: body?.data?.seller?.id, token: body?.data?.token };
check("seller lumina login", !!seller.token);

// --- create a thread: shopper A ↔ lumina's store ---
res = await fetch(`${BASE}/api/chat/threads`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${shopperA.token}` }, body: JSON.stringify({ storeSlug: "lumina-living", message: "LT probe message" }) });
body = await j(res);
const threadId = body?.data?.thread?.id;
check("thread created (shopper A ↔ lumina)", !!threadId, `thread=${threadId?.slice(0, 12)}…`);

// --- relay secret gating (direct to :3103) ---
res = await fetch("http://127.0.0.1:3103/broadcast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rooms: ["user:x"], event: "chat:message", payload: {} }) });
check("relay without secret → 401", res.status === 401);
res = await fetch("http://127.0.0.1:3103/broadcast", { method: "POST", headers: { "Content-Type": "application/json", "x-chat-relay-secret": "wrong" }, body: JSON.stringify({ rooms: ["user:x"], event: "chat:message", payload: {} }) });
check("relay with wrong secret → 401", res.status === 401);

// --- unauthenticated socket → handshake rejected ---
const unauth = io("http://localhost:3003", { path: "/", transports: ["websocket"], auth: { token: "" }, reconnection: false, timeout: 4000 });
const unauthRejected = await new Promise<boolean>((resolve) => {
  unauth.on("connect_error", () => resolve(true));
  unauth.on("connect", () => resolve(false));
  setTimeout(() => resolve(false), 4500);
});
unauth.disconnect();
check("unauthenticated socket handshake rejected", unauthRejected);

// --- garbage token → rejected by app validation ---
const garbage = io("http://localhost:3003", { path: "/", transports: ["websocket"], auth: { token: "f".repeat(64) }, reconnection: false, timeout: 4000 });
const garbageRejected = await new Promise<boolean>((resolve) => {
  garbage.on("connect_error", () => resolve(true));
  garbage.on("connect", () => { /* may connect, then get disconnected by app check */ });
  setTimeout(() => resolve(!garbage.connected), 4500);
});
garbage.disconnect();
check("garbage token socket not connected", garbageRejected);

// --- helper: authorized client ---
function client(token: string) {
  return io("http://localhost:3003", { path: "/", transports: ["websocket"], auth: { token }, reconnection: false, timeout: 5000 });
}
async function waitForEvent(sock: ReturnType<typeof client>, event: string, ms = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    sock.on(event, () => { clearTimeout(t); resolve(true); });
  });
}
async function joined(sock: ReturnType<typeof client>, rooms: string[]): Promise<void> {
  sock.emit("join", { rooms });
  await new Promise((r) => setTimeout(r, 700)); // allow auth round-trip
}

// --- shopper A: own user room allowed; B's room denied ---
const sockA = client(shopperA.token);
await new Promise<void>((r) => { sockA.on("connect", () => r()); setTimeout(() => r(), 5000); });
check("shopper A socket connects (authenticated)", sockA.connected);
await joined(sockA, [`user:${shopperA.id}`, `user:${shopperB.id}`]);
// broadcast to A's room via relay (with correct dev secret)
res = await fetch("http://127.0.0.1:3103/broadcast", { method: "POST", headers: { "Content-Type": "application/json", "x-chat-relay-secret": "sm_chat_relay_dev" }, body: JSON.stringify({ rooms: [`user:${shopperA.id}`], event: "chat:activity", payload: { probe: "A" } }) });
check("relay with correct dev secret → 200", res.status === 200);
check("shopper A receives event on OWN user room", await waitForEvent(sockA, "chat:activity"));
// broadcast to B's room — A must NOT receive
const gotBLeak = await waitForEvent(sockA, "chat:read", 1500).then(() => true).catch(() => false);
res = await fetch("http://127.0.0.1:3103/broadcast", { method: "POST", headers: { "Content-Type": "application/json", "x-chat-relay-secret": "sm_chat_relay_dev" }, body: JSON.stringify({ rooms: [`user:${shopperB.id}`], event: "chat:read", payload: { probe: "B-leak" } }) });
const leakReceived = await waitForEvent(sockA, "chat:read", 1500);
check("shopper A does NOT receive B's user-room events (join was denied)", !leakReceived);

// --- thread room: participant vs non-participant ---
await joined(sockA, [`thread:${threadId}`]);
res = await fetch("http://127.0.0.1:3103/broadcast", { method: "POST", headers: { "Content-Type": "application/json", "x-chat-relay-secret": "sm_chat_relay_dev" }, body: JSON.stringify({ rooms: [`thread:${threadId}`], event: "chat:activity", payload: { probe: "thread" } }) });
check("thread PARTICIPANT (shopper A) receives thread events", await waitForEvent(sockA, "chat:activity"));
const sockB = client(shopperB.token);
await new Promise<void>((r) => { sockB.on("connect", () => r()); setTimeout(() => r(), 5000); });
await joined(sockB, [`thread:${threadId}`]);
res = await fetch("http://127.0.0.1:3103/broadcast", { method: "POST", headers: { "Content-Type": "application/json", "x-chat-relay-secret": "sm_chat_relay_dev" }, body: JSON.stringify({ rooms: [`thread:${threadId}`], event: "chat:read", payload: { probe: "B-thread-leak" } }) });
const bThreadLeak = await waitForEvent(sockB, "chat:read", 1800);
check("NON-participant (shopper B) does NOT receive thread events", !bThreadLeak);

// --- seller participant ---
const sockS = client(seller.token);
await new Promise<void>((r) => { sockS.on("connect", () => r()); setTimeout(() => r(), 5000); });
await joined(sockS, [`thread:${threadId}`, `user:${seller.id}`]);
res = await fetch("http://127.0.0.1:3103/broadcast", { method: "POST", headers: { "Content-Type": "application/json", "x-chat-relay-secret": "sm_chat_relay_dev" }, body: JSON.stringify({ rooms: [`thread:${threadId}`], event: "chat:activity", payload: { probe: "seller" } }) });
check("thread PARTICIPANT (seller) receives thread events", await waitForEvent(sockS, "chat:activity"));

// --- admin token → no chat rooms (hub-auth rejects admin) ---
res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@nomofee.io", password: "Admin123!", portal: "admin" }) });
body = await j(res);
const adminTok = body?.data?.token;
res = await fetch(`${BASE}/api/chat/hub-auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: adminTok, rooms: [`user:${body?.data?.admin?.id}`] }) });
check("admin session rejected by hub-auth (no chat surface)", res.status === 403);

sockA.disconnect(); sockB.disconnect(); sockS.disconnect();
console.log(`\n=== RESULT: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail > 0 ? 1 : 0);
