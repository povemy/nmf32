/**
 * Admin-driven homepage content update (desktop homepage revamp).
 *
 * Uses ONLY the real admin APIs — the exact flow an admin performs in the
 * console — so this doubles as an end-to-end validation of the
 * admin-driven-homepage requirement:
 *   1. superadmin login + MFA enroll/confirm/verify (the account had an
 *      unconfirmed enrollment, i.e. it was locked out of admin functions)
 *   2. PATCH /api/admin/campaigns/[id] — new teal/gold campaign creatives
 *   3. PUT  /api/admin/featured-stores — curated featured stores
 * Every mutation is audited + cache-busted by the routes themselves.
 *
 * Idempotent-ish: re-running re-applies the same values.
 */
import { base32Decode, totpCode, totpCounterAt } from "../src/lib/mfa";

const BASE = process.env.LT_BASE ?? "http://127.0.0.1:3000";
const EMAIL = "admin@nomofee.io";
const PASSWORD = "Admin123!"; // sandbox dev credential (prisma/seed.ts)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

function totp(secret: Uint8Array): string {
  return totpCode(secret, totpCounterAt(Math.floor(Date.now() / 1000)));
}

async function main() {
  // ── 1) superadmin session via the real MFA flow ──────────────────────────
  const li0 = await api("POST", "/api/auth/login", { body: { email: EMAIL, password: PASSWORD, portal: "admin" } });
  if (li0.status !== 200) throw new Error(`login failed: ${li0.status}`);
  let token: string | undefined = li0.json?.data?.token;
  let secretBase32: string | undefined;

  // Probe admin access; complete the enrollment if the gate is closed.
  const probe = await api("GET", "/api/admin/campaigns?perPage=1", { token });
  if (probe.status === 403 || li0.json?.data?.mfaRequired) {
    const enroll = await api("POST", "/api/admin/mfa/enroll", { token, body: { password: PASSWORD } });
    if (enroll.status !== 200) throw new Error(`mfa enroll failed: ${enroll.status} ${JSON.stringify(enroll.json)}`);
    secretBase32 = enroll.json?.data?.secretBase32;
    const secret = base32Decode(String(secretBase32 ?? ""));
    const confirm = await api("POST", "/api/admin/mfa/confirm", { token, body: { password: PASSWORD, code: totp(secret) } });
    if (confirm.status !== 200) throw new Error(`mfa confirm failed: ${confirm.status}`);
    // TOTP codes are single-use per 30 s window — wait for the next window.
    await sleep(Math.max(0, 30_100 - (Date.now() % 30_000)));
    const li1 = await api("POST", "/api/auth/login", { body: { email: EMAIL, password: PASSWORD, portal: "admin" } });
    const verify = await api("POST", "/api/auth/mfa/verify", {
      body: { challenge: li1.json?.data?.challenge, code: totp(secret) },
    });
    token = verify.json?.data?.token;
    if (!token) throw new Error("MFA verify failed — no token");
    console.log("[home-content] superadmin MFA completed + verified");
  } else {
    console.log("[home-content] superadmin session OK (no MFA gate)");
  }

  // ── 2) campaign creatives via the admin Campaigns API ────────────────────
  const listing = await api("GET", "/api/admin/campaigns?perPage=50", { token });
  const rows: any[] = listing.json?.data?.rows ?? listing.json?.data ?? [];
  const byName = new Map<string, any>(rows.map((c) => [c.name, c]));
  console.log("[home-content] campaigns visible:", rows.map((c) => c.name).join(" | "));

  const updates: { name: string; patch: Record<string, unknown> }[] = [
    {
      name: "Raya Mega Sale (demo)",
      patch: {
        bannerDesktopUrl: "/gen/campaigns/raya.png",
        bannerMobileUrl: null, // falls back to the desktop creative
        thumbnailUrl: "/gen/campaigns/raya.png",
      },
    },
    {
      name: "Ramadan Early-Bird (demo)",
      patch: { bannerDesktopUrl: "/gen/campaigns/ramadan-tile.png", bannerMobileUrl: null },
    },
    {
      name: "CNY Lantern Preview (demo)",
      patch: { thumbnailUrl: "/gen/campaigns/cny-tile.png" },
    },
    {
      name: "Merdeka Home Essentials (demo)",
      patch: { bannerDesktopUrl: "/gen/campaigns/merdeka-inline.png", bannerMobileUrl: null },
    },
  ];

  for (const u of updates) {
    const c = byName.get(u.name);
    if (!c) {
      console.warn(`[home-content] MISSING campaign: ${u.name}`);
      continue;
    }
    const r = await api("PATCH", `/api/admin/campaigns/${c.id}`, { token, body: u.patch });
    console.log(`[home-content] PATCH ${u.name}: ${r.status === 200 ? "ok" : `FAILED ${r.status} ${JSON.stringify(r.json)}`}`);
  }

  // ── 3) curated featured stores via the admin Featured Stores API ─────────
  const stores = await api("GET", "/api/admin/stores?perPage=100", { token });
  const storeRows: any[] = stores.json?.data?.rows ?? stores.json?.data ?? [];
  const curated = storeRows
    .filter((s) => ["Lumina Living", "ByteBazaar", "Glow Theory"].includes(s.name))
    .map((s) => ({ id: s.id, name: s.name }));
  console.log("[home-content] curating featured stores:", curated.map((s) => s.name).join(" | "));
  if (curated.length > 0) {
    const put = await api("PUT", "/api/admin/featured-stores", {
      token,
      body: { storeIds: curated.map((s) => s.id) },
    });
    console.log(`[home-content] PUT featured-stores: ${put.status === 200 ? "ok" : `FAILED ${put.status} ${JSON.stringify(put.json)}`}`);
  }

  console.log("[home-content] done");
}

main().catch((e) => {
  console.error("[home-content] FAILED:", e);
  process.exitCode = 1;
});
