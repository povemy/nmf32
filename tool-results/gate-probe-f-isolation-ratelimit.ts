/**
 * Post-Remediation Verification Gate — Probe F (isolation + rate limits).
 *
 * Part 1 — live cross-tenant isolation (the audit verified this statically
 * only; NOT TESTED at runtime there): seller A (lumina) attempts to read/mutate
 * seller B's (glow) resources by id — orders, product PATCH, wallet activity —
 * expecting 404/401 (never data). Positive control: A reads OWN order.
 *
 * Part 2 — F-12 rate limits: 11 wrong-password logins → 429 on the 11th
 * (10/min bucket); 6 invalid shopper registrations → 429 on the 6th (5/min
 * bucket; missing-field bodies create no accounts).
 *
 * THIS PROBE EXHAUSTS THE AUTH BUCKETS FOR ~1 MIN — run LAST.
 */
const BASE = "http://127.0.0.1:3000";

let pass = 0, failCount = 0;
const fails: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { failCount++; fails.push(`${label}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}
const j = (r: Response) => r.json().catch(() => ({}));

async function req(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await j(res) };
}

console.log("=== Probe F — cross-tenant isolation + rate limits ===\n");

const { db } = await import("../src/lib/db");

// ---------------------------------------------------------------- Part 1: isolation
console.log("-- live cross-tenant isolation (seller A ↔ seller B) --");
{
  // logins: A + B (2 — inside the 10/min bucket)
  const la = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "lumina@nomofee.io", password: "Seller123!", portal: "seller" }) });
  const tokA = (await j(la))?.data?.token ?? null;
  check("seller A (lumina) login", !!tokA);
  const lb = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "glow@nomofee.io", password: "Seller123!", portal: "seller" }) });
  const tokB = (await j(lb))?.data?.token ?? null;
  check("seller B (glow) login", !!tokB);

  // B's resources: one of B's orders + one of B's products
  const orderB = await db.order.findFirst({
    where: { store: { slug: "glow-theory" } },
    orderBy: { createdAt: "desc" },
    select: { id: true, orderNumber: true },
  });
  const productB = await db.product.findFirst({ where: { store: { slug: "glow-theory" } }, select: { id: true, title: true } });
  const orderA = await db.order.findFirst({ where: { store: { slug: "lumina-living" }, orderNumber: "NM-103632" }, select: { id: true, orderNumber: true } });
  check("B-order + B-product + A-order located", !!orderB && !!productB && !!orderA, `B-order=${orderB?.orderNumber} B-product=${productB?.title}`);

  // A reads B's order by id → 404
  const r1 = await req("GET", `/api/store/orders/${orderB!.id}`, tokA);
  check("A GET B's order (by id) → 404 (tenant-scoped)", r1.status === 404, `got ${r1.status}`);
  // A reads B's order by orderNumber → 404
  const r1b = await req("GET", `/api/store/orders/${orderB!.orderNumber}`, tokA);
  check("A GET B's order (by orderNumber) → 404", r1b.status === 404, `got ${r1b.status}`);
  // A mutates B's product → 404 (ownProduct post-fetch check)
  const r2 = await req("PATCH", `/api/store/products/${productB!.id}`, tokA, { title: "hijacked" });
  check("A PATCH B's product → 404 (ownProduct check)", r2.status === 404, `got ${r2.status}`);
  // A reads B's product via variants route → 404
  const r3 = await req("GET", `/api/store/products/${productB!.id}`, tokA);
  check("A GET B's product detail → 404", r3.status === 404, `got ${r3.status}`);
  // Positive control: A reads OWN order → 200
  const r4 = await req("GET", `/api/store/orders/${orderA!.id}`, tokA);
  check("A GET OWN order → 200 (positive control)", r4.status === 200, `got ${r4.status}`);
  // B reads own order → 200 (control both ways)
  const r5 = await req("GET", `/api/store/orders/${orderB!.id}`, tokB);
  check("B GET OWN order → 200 (positive control)", r5.status === 200, `got ${r5.status}`);
  // A requests refund on B's order → 404 (guard scoped)
  const r6 = await req("POST", `/api/store/orders/${orderB!.id}/refund-request`, tokA, { amountMinor: 100 });
  check("A refund-request on B's order → 404", r6.status === 404, `got ${r6.status}`);
}

// ---------------------------------------------------------------- Part 2: rate limits
console.log("\n-- F-12 rate limits (buckets exhausted for ~1 min) --");
{
  // login: 10/min — 2 logins already used above → 8 more 401s, then 429
  let saw429 = false, codes: number[] = [];
  for (let i = 0; i < 9; i++) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nobody@probe.local", password: "wrong", portal: "admin" }),
    });
    codes.push(res.status);
    if (res.status === 429) { saw429 = true; break; }
  }
  check("login throttle fires (429 within 10 attempts/min)", saw429, `codes=${codes.join(",")}`);
  if (saw429) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nobody@probe.local", password: "wrong", portal: "admin" }),
    });
    const body = await j(res);
    check("429 body carries RATE_LIMITED code", res.status === 429 && body?.error?.code === "RATE_LIMITED", `status=${res.status} ${body?.error?.code ?? ""}`);
  }

  // register: 5/min (separate bucket) — 6 invalid bodies (no accounts created)
  let saw429r = false, codesR: number[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${BASE}/api/auth/shopper/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `x-${Date.now()}-${i}@probe.local` }), // missing password → 400, counts toward bucket
    });
    codesR.push(res.status);
    if (res.status === 429) { saw429r = true; break; }
  }
  check("register throttle fires (429 within 5 attempts/min)", saw429r, `codes=${codesR.join(",")}`);

  // verify no probe shoppers were created by the invalid bodies
  const created = await db.shopperUser.count({ where: { email: { startsWith: "x-" } } });
  check("invalid registrations created no accounts", created === 0, `created=${created}`);
}

await (db as any).$disconnect?.();
console.log(`\n=== Probe F result: ${pass} PASS / ${failCount} FAIL ===`);
if (fails.length) { console.log("FAILURES:"); for (const f of fails) console.log("  - " + f); }
process.exit(failCount > 0 ? 1 : 0);
