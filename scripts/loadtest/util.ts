// ============================================================================
// loadtest/util.ts — shared machinery for the [LT] load-test harness.
// Rules (performance/REPORT.md + master prompt): isolated [LT]-owned data only,
// mock PSP via /simulate, no external side effects, honest classification of
// business rejections vs infrastructure failures.
// ============================================================================

export const BASE = process.env.LT_BASE ?? "http://127.0.0.1:3000";
export const LT_PASSWORD = "LtBuyer123!";

export type Lat = { ms: number; status: number; code?: string; ref?: string };

export function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

export function summarize(lats: Lat[]) {
  const ms = lats.map((l) => l.ms).sort((a, b) => a - b);
  return {
    n: lats.length,
    p50: pct(ms, 50),
    p95: pct(ms, 95),
    p99: pct(ms, 99),
    max: ms.length ? Math.round(ms[ms.length - 1]) : 0,
  };
}

/** Status classification per mission F2 Step 6: business rejections (4xx the
 *  app chose to return) are DISTINCT from infrastructure failures (5xx /
 *  network errors / timeouts). */
export function classify(status: number): "created" | "business" | "infra" | "network" {
  if (status === 201 || status === 200) return "created";
  if (status >= 400 && status < 500) return "business";
  if (status >= 500) return "infra";
  return "network";
}

export async function loginShopper(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/shopper/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: LT_PASSWORD }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (res.status !== 200 || !cookie) throw new Error(`login failed for ${email}: ${res.status}`);
  return cookie;
}

export async function createCheckout(opts: {
  cookie: string;
  variantId: string;
  qty: number;
  idemKey: string;
  email: string;
}): Promise<{ status: number; ms: number; body: { data?: { paymentRef?: string; orderNumbers?: string[]; duplicate?: boolean }; error?: { code?: string; message?: string } } }> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/api/checkout/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: opts.cookie, "Idempotency-Key": opts.idemKey },
      body: JSON.stringify({
        items: [{ variantId: opts.variantId, qty: opts.qty }],
        customer: { name: `[LT] ${opts.email}`, email: opts.email },
        shippingAddress: { line1: "1 Load Test Jalan", city: "Kuala Lumpur", postcode: "50000", state: "Kuala Lumpur" },
        provider: "fpx_toyyibpay",
      }),
    });
    const ms = performance.now() - t0;
    const body = (await res.json().catch(() => ({}))) as { data?: { paymentRef?: string }; error?: { code?: string } };
    return { status: res.status, ms, body };
  } catch (e) {
    return { status: 0, ms: performance.now() - t0, body: { error: { code: "NETWORK", message: String(e).slice(0, 120) } } };
  }
}

/** Mock-PSP confirmation via the sandbox simulate endpoint (PaymentGroup ref). */
export async function simulatePayment(ref: string): Promise<{ status: number; ms: number; code?: string }> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/api/checkout/payments/${encodeURIComponent(ref)}/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result: "succeeded" }),
    });
    const ms = performance.now() - t0;
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
    return { status: res.status, ms, code: body.error?.code };
  } catch (e) {
    return { status: 0, ms: performance.now() - t0, code: "NETWORK" };
  }
}

/** Bounded-concurrency map. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
