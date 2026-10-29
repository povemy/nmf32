/**
 * Post-Remediation Verification Gate — Probe E (F-06 chat hub + relay).
 *
 *   • hub-auth: invalid/garbage token → 401; membership decisions for
 *     user rooms (own only) and thread rooms (participant only).
 *   • socket handshake: unauthenticated + garbage-token sockets are
 *     disconnected by the hub.
 *   • room authorization: shopper A receives OWN user-room + PARTICIPANT
 *     thread events; does NOT receive shopper B's user room; non-participant
 *     B does not receive thread events; store-owner seller does.
 *   • relay :3103 — no secret / wrong secret → 401.
 *
 * Logins: 1 (seller). Registers: 2 (shopper A/B — separate 5/min bucket).
 * Cleanup: thread, messages, both shoppers + sessions removed via DB.
 */
import { io, type Socket } from "socket.io-client";

const BASE = "http://127.0.0.1:3000";
const HUB = "http://127.0.0.1:3003";
const RELAY = "http://127.0.0.1:3103/broadcast";

let pass = 0, failCount = 0;
const fails: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { failCount++; fails.push(`${label}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}
const j = (r: Response) => r.json().catch(() => ({}));

console.log("=== Probe E — chat hub authentication + relay secret ===\n");

const stamp = Date.now().toString(36);

// principals ------------------------------------------------------------------
let res = await fetch(`${BASE}/api/auth/shopper/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `lt-gate-e-a-${stamp}@probe.local`, password: "ProbePass123!", fullName: "LT Gate E A" }) });
let body = await j(res);
const shopperA = { id: body?.data?.shopper?.id as string, token: body?.data?.token as string };
res = await fetch(`${BASE}/api/auth/shopper/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `lt-gate-e-b-${stamp}@probe.local`, password: "ProbePass123!", fullName: "LT Gate E B" }) });
body = await j(res);
const shopperB = { id: body?.data?.shopper?.id as string, token: body?.data?.token as string };
res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "lumina@nomofee.io", password: "Seller123!", portal: "seller" }) });
body = await j(res);
const seller = { id: body?.data?.seller?.id as string, token: body?.data?.token as string };
check("principals established (2 shoppers + 1 seller)", !!shopperA.token && !!shopperB.token && !!seller.token);

// thread ----------------------------------------------------------------------
res = await fetch(`${BASE}/api/chat/threads`, {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${shopperA.token}` },
  body: JSON.stringify({ storeSlug: "lumina-living", message: "LT gate probe message" }),
});
body = await j(res);
const threadId = body?.data?.thread?.id as string | undefined;
check("thread created (shopper A ↔ lumina-living)", !!threadId);

// hub-auth --------------------------------------------------------------------
console.log("\n-- hub-auth membership decisions --");
{
  const r1 = await fetch(`${BASE}/api/chat/hub-auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "deadbeef".repeat(8), rooms: [`user:${shopperA.id}`] }) });
  check("hub-auth: garbage token → 401", r1.status === 401, `got ${r1.status}`);

  const r2 = await fetch(`${BASE}/api/chat/hub-auth`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: shopperA.token, rooms: [`user:${shopperA.id}`, `user:${shopperB.id}`, `thread:${threadId}`, "thread:clx_totally_unknown"] }),
  });
  const b2 = await j(r2);
  const allowed: string[] = b2?.data?.allowed ?? [];
  check("hub-auth: own user room allowed", allowed.includes(`user:${shopperA.id}`), JSON.stringify(allowed));
  check("hub-auth: OTHER user's room denied", !allowed.includes(`user:${shopperB.id}`));
  check("hub-auth: participant thread allowed", allowed.includes(`thread:${threadId}`));
  check("hub-auth: unknown thread denied (no existence signal)", !allowed.includes("thread:clx_totally_unknown"));
}

// relay secret ----------------------------------------------------------------
console.log("\n-- relay :3103 shared secret --");
{
  const r1 = await fetch(RELAY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rooms: ["user:x"], event: "chat:message", payload: {} }) });
  check("relay without secret → 401", r1.status === 401, `got ${r1.status}`);
  const r2 = await fetch(RELAY, { method: "POST", headers: { "Content-Type": "application/json", "x-chat-relay-secret": "wrong-secret" }, body: JSON.stringify({ rooms: ["user:x"], event: "chat:message", payload: {} }) });
  check("relay with wrong secret → 401", r2.status === 401, `got ${r2.status}`);
}

// sockets ---------------------------------------------------------------------
console.log("\n-- socket handshake + room authorization --");
function client(token: string) {
  return io(HUB, { path: "/", transports: ["websocket"], auth: { token }, reconnection: false, timeout: 5000 });
}
async function connect(sock: Socket, ms = 5000): Promise<boolean> {
  return new Promise((resolve) => { sock.on("connect", () => resolve(true)); setTimeout(() => resolve(sock.connected), ms); });
}
function waitForEvent(sock: Socket, event: string, ms = 3000): Promise<boolean> {
  return new Promise((resolve) => { const t = setTimeout(() => resolve(false), ms); sock.on(event, () => { clearTimeout(t); resolve(true); }); });
}
async function joined(sock: Socket, rooms: string[]): Promise<void> {
  sock.emit("join", { rooms });
  await new Promise((r) => setTimeout(r, 900));
}
const RS = { "Content-Type": "application/json", "x-chat-relay-secret": "sm_chat_relay_dev" };
async function broadcastAndListen(sock: Socket, event: string, rooms: string[]): Promise<boolean> {
  const got = waitForEvent(sock, event, 4000);
  await new Promise((r) => setTimeout(r, 100));
  await fetch(RELAY, { method: "POST", headers: RS, body: JSON.stringify({ rooms, event, payload: { probe: event } }) });
  return await got;
}

{
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

  const sockA = client(shopperA.token);
  check("shopper A connects (authenticated handshake)", await connect(sockA));
  await new Promise((r) => setTimeout(r, 400));
  await joined(sockA, [`user:${shopperA.id}`, `user:${shopperB.id}`, `thread:${threadId}`]);
  check("shopper A receives OWN user-room events", await broadcastAndListen(sockA, "chat:activity", [`user:${shopperA.id}`]));
  check("shopper A receives PARTICIPANT thread events", await broadcastAndListen(sockA, "chat:message", [`thread:${threadId}`]));
  check("shopper A does NOT receive B's user room (join denied)", !(await broadcastAndListen(sockA, "chat:read", [`user:${shopperB.id}`])));

  const sockB = client(shopperB.token);
  await connect(sockB);
  await joined(sockB, [`thread:${threadId}`]);
  check("non-participant B does NOT receive thread events", !(await broadcastAndListen(sockB, "chat:read", [`thread:${threadId}`])));
  sockB.disconnect();

  const sockS = client(seller.token);
  await connect(sockS);
  await joined(sockS, [`thread:${threadId}`]);
  check("store-owner seller receives thread events (participant via ownership)", await broadcastAndListen(sockS, "chat:message", [`thread:${threadId}`]));
  sockS.disconnect();
  sockA.disconnect();
}

// cleanup ---------------------------------------------------------------------
{
  const { db } = await import("../src/lib/db");
  try {
    await db.chatMessage.deleteMany({ where: { threadId } });
    await db.chatThread.delete({ where: { id: threadId } });
    for (const sh of [shopperA, shopperB]) {
      await db.session.deleteMany({ where: { userId: sh.id } });
      await db.shopperUser.delete({ where: { id: sh.id } });
    }
    await db.session.deleteMany({ where: { userId: seller.id } });
    check("cleanup: thread + messages + probe shoppers removed", true);
  } catch (e: any) {
    check("cleanup: probe data removed", false, e?.message ?? String(e));
  }
  await (db as any).$disconnect?.();
}

console.log(`\n=== Probe E result: ${pass} PASS / ${failCount} FAIL ===`);
if (fails.length) { console.log("FAILURES:"); for (const f of fails) console.log("  - " + f); }
process.exit(failCount > 0 ? 1 : 0);
