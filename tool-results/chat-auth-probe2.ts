import { io, type Socket } from "socket.io-client";
const BASE = "http://localhost:3000";
let pass = 0, fail = 0;
const check = (n: string, c: boolean, e = "") => { console.log(`${c ? "PASS" : "FAIL"} — ${n}${e ? " (" + e + ")" : ""}`); c ? pass++ : fail++; };
const j = (r: Response) => r.json().catch(() => ({}));

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

res = await fetch(`${BASE}/api/chat/threads`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${shopperA.token}` }, body: JSON.stringify({ storeSlug: "lumina-living", message: "LT probe message" }) });
body = await j(res);
const threadId = body?.data?.thread?.id;
check("thread created (shopper A ↔ lumina)", !!threadId);

res = await fetch("http://127.0.0.1:3103/broadcast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rooms: ["user:x"], event: "chat:message", payload: {} }) });
check("relay without secret → 401", res.status === 401);
res = await fetch("http://127.0.0.1:3103/broadcast", { method: "POST", headers: { "Content-Type": "application/json", "x-chat-relay-secret": "wrong" }, body: JSON.stringify({ rooms: ["user:x"], event: "chat:message", payload: {} }) });
check("relay with wrong secret → 401", res.status === 401);

function client(token: string) {
  return io("http://localhost:3003", { path: "/", transports: ["websocket"], auth: { token }, reconnection: false, timeout: 5000 });
}
async function connect(sock: Socket, ms = 5000): Promise<boolean> {
  return new Promise((resolve) => { sock.on("connect", () => resolve(true)); setTimeout(() => resolve(sock.connected), ms); });
}
async function waitForEvent(sock: Socket, event: string, ms = 3000): Promise<boolean> {
  return new Promise((resolve) => { const t = setTimeout(() => resolve(false), ms); sock.on(event, () => { clearTimeout(t); resolve(true); }); });
}
async function joined(sock: Socket, rooms: string[]): Promise<void> {
  sock.emit("join", { rooms });
  await new Promise((r) => setTimeout(r, 800));
}

// --- unauthenticated socket: connects then gets DISCONNECTED by the auth check ---
const unauth = client("");
const sawConnect = await connect(unauth);
await new Promise((r) => setTimeout(r, 1500)); // give the auth round-trip time
check("unauthenticated socket is disconnected by the hub", !unauth.connected, `brieflyConnected=${sawConnect}`);
unauth.disconnect();

// --- garbage token: same ---
const garbage = client("f".repeat(64));
await connect(garbage);
await new Promise((r) => setTimeout(r, 1500));
check("garbage-token socket is disconnected by the hub", !garbage.connected);
garbage.disconnect();

// --- legit shopper A ---
const sockA = client(shopperA.token);
check("shopper A socket connects (authenticated)", await connect(sockA));
await new Promise((r) => setTimeout(r, 500));
check("shopper A STAYS connected (valid token)", sockA.connected);
await joined(sockA, [`user:${shopperA.id}`, `user:${shopperB.id}`]);
res = await fetch("http://127.0.0.1:3103/broadcast", { method: "POST", headers: { "Content-Type": "application/json", "x-chat-relay-secret": "sm_chat_relay_dev" }, body: JSON.stringify({ rooms: [`user:${shopperA.id}`], event: "chat:activity", payload: { probe: "A" } }) });
check("relay with correct dev secret → 200", res.status === 200);
check("shopper A receives event on OWN user room", await waitForEvent(sockA, "chat:activity"));
res = await fetch("http://127.0.0.1:3103/broadcast", { method: "POST", headers: { "Content-Type": "application/json", "x-chat-relay-secret": "sm_chat_relay_dev" }, body: JSON.stringify({ rooms: [`user:${shopperB.id}`], event: "chat:read", payload: { probe: "B-leak" } }) });
check("shopper A does NOT receive B's user-room events (join denied)", !(await waitForEvent(sockA, "chat:read", 1500)));

// --- thread rooms ---
await joined(sockA, [`thread:${threadId}`]);
res = await fetch("http://127.0.0.1:3103/broadcast", { method: "POST", headers: { "Content-Type": "application/json", "x-chat-relay-secret": "sm_chat_relay_dev" }, body: JSON.stringify({ rooms: [`thread:${threadId}`], event: "chat:message", payload: { probe: "thread" } }) });
check("thread PARTICIPANT (shopper A) receives thread events", await waitForEvent(sockA, "chat:message"));
const sockB = client(shopperB.token);
await connect(sockB);
await joined(sockB, [`thread:${threadId}`]);
res = await fetch("http://127.0.0.1:3103/broadcast", { method: "POST", headers: { "Content-Type": "application/json", "x-chat-relay-secret": "sm_chat_relay_dev" }, body: JSON.stringify({ rooms: [`thread:${threadId}`], event: "chat:read", payload: { probe: "B-thread-leak" } }) });
check("NON-participant (shopper B) does NOT receive thread events", !(await waitForEvent(sockB, "chat:read", 1800)));

// --- seller participant ---
const sockS = client(seller.token);
await connect(sockS);
await joined(sockS, [`thread:${threadId}`, `user:${seller.id}`]);
res = await fetch("http://127.0.0.1:3103/broadcast", { method: "POST", headers: { "Content-Type": "application/json", "x-chat-relay-secret": "sm_chat_relay_dev" }, body: JSON.stringify({ rooms: [`thread:${threadId}`], event: "chat:activity", payload: { probe: "seller" } }) });
check("thread PARTICIPANT (seller) receives thread events", await waitForEvent(sockS, "chat:activity"));

// --- admin rejected by hub-auth ---
res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@nomofee.io", password: "Admin123!", portal: "admin" }) });
body = await j(res);
res = await fetch(`${BASE}/api/chat/hub-auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: body?.data?.token, rooms: [`user:${body?.data?.admin?.id}`] }) });
check("admin session rejected by hub-auth (no chat surface)", res.status === 403);

sockA.disconnect(); sockB.disconnect(); sockS.disconnect();
console.log(`\n=== RESULT: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail > 0 ? 1 : 0);
