import { io, type Socket } from "socket.io-client";
const BASE = "http://localhost:3000";
let pass = 0, fail = 0;
const check = (n: string, c: boolean, e = "") => { console.log(`${c ? "PASS" : "FAIL"} — ${n}${e ? " (" + e + ")" : ""}`); c ? pass++ : fail++; };
const j = (r: Response) => r.json().catch(() => ({}));
const RELAY = "http://127.0.0.1:3103/broadcast";
const RS = { "Content-Type": "application/json", "x-chat-relay-secret": "sm_chat_relay_dev" };

const stamp = Date.now().toString(36);
let res = await fetch(`${BASE}/api/auth/shopper/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `lt-chat-a-${stamp}@probe.local`, password: "ProbePass123!", fullName: "LT Chat A" }) });
let body = await j(res);
const shopperA = { id: body?.data?.shopper?.id, token: body?.data?.token };
res = await fetch(`${BASE}/api/auth/shopper/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `lt-chat-b-${stamp}@probe.local`, password: "ProbePass123!", fullName: "LT Chat B" }) });
body = await j(res);
const shopperB = { id: body?.data?.shopper?.id, token: body?.data?.token };
res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "lumina@nomofee.io", password: "Seller123!" }) });
body = await j(res);
const seller = { id: body?.data?.seller?.id, token: body?.data?.token };
check("sessions established", !!shopperA.token && !!shopperB.token && !!seller.token);

res = await fetch(`${BASE}/api/chat/threads`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${shopperA.token}` }, body: JSON.stringify({ storeSlug: "lumina-living", message: "LT probe message" }) });
body = await j(res);
const threadId = body?.data?.thread?.id;
check("thread created (shopper A ↔ lumina)", !!threadId);

res = await fetch(RELAY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rooms: ["user:x"], event: "chat:message", payload: {} }) });
check("relay without secret → 401", res.status === 401);
res = await fetch(RELAY, { method: "POST", headers: { "Content-Type": "application/json", "x-chat-relay-secret": "wrong" }, body: JSON.stringify({ rooms: ["user:x"], event: "chat:message", payload: {} }) });
check("relay with wrong secret → 401", res.status === 401);

function client(token: string) {
  return io("http://localhost:3003", { path: "/", transports: ["websocket"], auth: { token }, reconnection: false, timeout: 5000 });
}
async function connect(sock: Socket, ms = 5000): Promise<boolean> {
  return new Promise((resolve) => { sock.on("connect", () => resolve(true)); setTimeout(() => resolve(sock.connected), ms); });
}
/** Listener FIRST (avoids the delivery race), then broadcast, then resolve. */
async function broadcastAndListen(sock: Socket, event: string, rooms: string[]): Promise<boolean> {
  const got = waitForEvent(sock, event, 4000);
  await new Promise((r) => setTimeout(r, 100)); // ensure listener attached
  const res = await fetch(RELAY, { method: "POST", headers: RS, body: JSON.stringify({ rooms, event, payload: { probe: event } }) });
  if (!res.ok) console.log("  (relay status", res.status + ")");
  return await got;
}
function waitForEvent(sock: Socket, event: string, ms = 3000): Promise<boolean> {
  return new Promise((resolve) => { const t = setTimeout(() => resolve(false), ms); sock.on(event, () => { clearTimeout(t); resolve(true); }); });
}
async function joined(sock: Socket, rooms: string[]): Promise<void> {
  sock.emit("join", { rooms });
  await new Promise((r) => setTimeout(r, 900));
}

// --- unauth / garbage sockets get disconnected ---
const unauth = client("");
await connect(unauth);
await new Promise((r) => setTimeout(r, 1500));
check("unauthenticated socket disconnected by hub", !unauth.connected);
unauth.disconnect();
const garbage = client("f".repeat(64));
await connect(garbage);
await new Promise((r) => setTimeout(r, 1500));
check("garbage-token socket disconnected by hub", !garbage.connected);
garbage.disconnect();

// --- shopper A: own room delivery + cross-user denial ---
const sockA = client(shopperA.token);
check("shopper A connects (authenticated)", await connect(sockA));
await new Promise((r) => setTimeout(r, 400));
await joined(sockA, [`user:${shopperA.id}`, `user:${shopperB.id}`, `thread:${threadId}`]);
check("shopper A receives OWN user-room events", await broadcastAndListen(sockA, "chat:activity", [`user:${shopperA.id}`]));
check("shopper A receives PARTICIPANT thread events", await broadcastAndListen(sockA, "chat:message", [`thread:${threadId}`]));
check("shopper A does NOT receive B's user room", !(await broadcastAndListen(sockA, "chat:read", [`user:${shopperB.id}`])));

// --- shopper B: non-participant thread denial ---
const sockB = client(shopperB.token);
await connect(sockB);
await joined(sockB, [`thread:${threadId}`]);
check("non-participant B does NOT receive thread events", !(await broadcastAndListen(sockB, "chat:read", [`thread:${threadId}`])));

// --- seller: participant via store ownership ---
const sockS = client(seller.token);
await connect(sockS);
await joined(sockS, [`thread:${threadId}`, `user:${seller.id}`]);
check("seller (participant) receives thread events", await broadcastAndListen(sockS, "chat:activity", [`thread:${threadId}`]));
check("seller receives OWN user-room events", await broadcastAndListen(sockS, "chat:message", [`user:${seller.id}`]));

// --- admin rejected by hub-auth ---
res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@nomofee.io", password: "Admin123!", portal: "admin" }) });
body = await j(res);
res = await fetch(`${BASE}/api/chat/hub-auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: body?.data?.token, rooms: [`user:${body?.data?.admin?.id}`] }) });
check("admin session rejected by hub-auth", res.status === 403);

sockA.disconnect(); sockB.disconnect(); sockS.disconnect();
console.log(`\n=== RESULT: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail > 0 ? 1 : 0);
