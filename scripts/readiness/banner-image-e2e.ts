// ============================================================================
// DESKTOP HOMEPAGE WORK ORDER — focused E2E: banner image change propagation.
// Patches the LIVE hero campaign's desktop creative through the REAL admin
// API (ops role + MFA, same as the LT14 suite), polls the public homepage
// until the slide's imageUrl changes, then RESTORES the original and verifies
// restoration. Measures the propagation window (tag-bust ⇒ seconds; 60s TTL
// is the documented ceiling).
// @ts-nocheck
const BASE = "http://127.0.0.1:3000";
const RUN = Date.now().toString(36);
const PASSWORD = "LtW1Ops!pass";

const { db } = await import("../../src/lib/db");
const { hashPasswordAsync } = await import("../../src/lib/password");
const { base32Decode, totpCode, totpCounterAt } = await import("../../src/lib/mfa");

const HERO_CAMPAIGN_ID = "cmvizj0230000q7ocvgb3vh27"; // "Raya Mega Sale (demo)"
const ORIG_DESKTOP = "/api/img/campaign-raya-hero?w=1400&h=480&label=Raya%20Mega%20Sale";
const ORIG_MOBILE = "/api/img/campaign-raya-mobile?w=800&h=480&label=Raya%20Mega%20Sale";
const NEW_DESKTOP = "/api/img/campaign-raya-hero?w=1400&h=480&label=Raya%20Mega%20Sale%20v2";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function heroSlideOf(id) {
  const r = await api("GET", "/api/market/home");
  return (r.json?.data?.hero ?? []).find((s) => s.id === id) ?? null;
}
async function pollSlide(pred, label, timeoutMs = 70_000) {
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) {
    const slide = await heroSlideOf(HERO_CAMPAIGN_ID);
    if (slide && pred(slide)) return { slide, ms: Date.now() - t0 };
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const email = `ltw1-ops-${RUN}@nomofee.test`;
let results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };

try {
  await db.adminUser.create({
    data: { email, name: "LTW1 Ops", role: "ops", isActive: true, passwordHash: await hashPasswordAsync(PASSWORD) },
  });
  const li0 = await api("POST", "/api/auth/login", { body: { email, password: PASSWORD, portal: "admin" } });
  const enroll = await api("POST", "/api/admin/mfa/enroll", { token: li0.json?.data?.token, body: { password: PASSWORD } });
  const secret = base32Decode(String(enroll.json?.data?.secretBase32 ?? ""));
  await api("POST", "/api/admin/mfa/confirm", {
    token: li0.json?.data?.token,
    body: { password: PASSWORD, code: totpCode(secret, totpCounterAt(Math.floor(Date.now() / 1000))) },
  });
  // TOTP single-use: wait for the NEXT 30s window before the verify login.
  await sleep(Math.max(0, 30_100 - (Date.now() % 30_000)));
  const li1 = await api("POST", "/api/auth/login", { body: { email, password: PASSWORD, portal: "admin" } });
  const verify = await api("POST", "/api/auth/mfa/verify", {
    body: { challenge: li1.json?.data?.challenge, code: totpCode(secret, totpCounterAt(Math.floor(Date.now() / 1000))) },
  });
  const token = verify.json?.data?.token;
  check("admin login (ops, MFA-verified)", Boolean(token), `login=${li0.status} verify=${verify.status}`);
  if (!token) throw new Error("no admin token — aborting");

  // W1 — pre-state: hero slide shows the ORIGINAL desktop creative.
  const before = await heroSlideOf(HERO_CAMPAIGN_ID);
  check("W1 hero slide currently shows the original desktop creative", before?.imageUrl === ORIG_DESKTOP, `imageUrl=${before?.imageUrl}`);

  // W2 — PATCH the desktop banner image through the admin API.
  const patch = await api("PATCH", `/api/admin/campaigns/${HERO_CAMPAIGN_ID}`, { token, body: { bannerDesktopUrl: NEW_DESKTOP } });
  check("W2 banner image PATCH accepted", patch.status === 200, `status=${patch.status}`);

  // W3 — the public homepage picks up the NEW creative within the documented window.
  const { ms } = await pollSlide((s) => s.imageUrl === NEW_DESKTOP, "new creative");
  check("W3 new desktop creative reaches the public homepage", true, `propagated in ${ms}ms (ceiling 70s; 60s TTL worst case)`);

  // W4 — the mobile creative is UNCHANGED by a desktop-only patch (independence).
  const after = await heroSlideOf(HERO_CAMPAIGN_ID);
  check("W4 mobile creative untouched by desktop-only change", after?.mobileImageUrl === ORIG_MOBILE, `mobile=${after?.mobileImageUrl}`);

  // W5 — RESTORE the original creative and verify.
  await api("PATCH", `/api/admin/campaigns/${HERO_CAMPAIGN_ID}`, { token, body: { bannerDesktopUrl: ORIG_DESKTOP } });
  const { ms: ms2, slide } = await pollSlide((s) => s.imageUrl === ORIG_DESKTOP, "restore");
  check("W5 original creative restored", slide.imageUrl === ORIG_DESKTOP, `restored in ${ms2}ms`);
} finally {
  await db.campaign.update({ where: { id: HERO_CAMPAIGN_ID }, data: { bannerDesktopUrl: ORIG_DESKTOP } }).catch(() => {});
  await db.adminUser.delete({ where: { email } }).catch(() => {});
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? "\nBANNER-IMAGE E2E: ALL PASS" : `\nBANNER-IMAGE E2E: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
