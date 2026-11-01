// GET /api/metrics — LT load-test telemetry (token-gated, fail-closed).
// User rule #4: bounded, no secrets/PII/SQL params; /api/metrics traffic is
// EXCLUDED from the counters themselves (EXCLUDED_LABELS in lib/metrics).
// Requires header: X-Metrics-Token: <METRICS_TOKEN from .env>. 503 if unset,
// 401 on mismatch — never open by default.
// Phase 2.4 (P2.4 cleanup §5.3): the token check is now CONSTANT-TIME
// (digest + timingSafeEqual, same posture as cron-auth) — it was a plain
// `!==` on the raw secret, a textbook timing oracle.
import { snapshot } from "@/lib/metrics";
import { db } from "@/lib/db";
import { safeEqual } from "@/lib/secretbox";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const expected = process.env.METRICS_TOKEN;
  if (!expected) {
    return Response.json({ error: { code: "METRICS_UNCONFIGURED", message: "METRICS_TOKEN is not set; metrics are disabled (fail-closed)" } }, { status: 503 });
  }
  const got = req.headers.get("x-metrics-token");
  if (!got || !safeEqual(got, expected)) {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "Invalid or missing X-Metrics-Token" } }, { status: 401 });
  }
  // $metrics is a runtime-only Prisma extension on this generated client —
  // typed access via the structural cast; if unavailable, fail CLOSED (503)
  // rather than 500-ing the telemetry endpoint.
  const metricsClient = db as unknown as { $metrics?: { json(): Promise<unknown> } };
  if (typeof metricsClient.$metrics?.json !== "function") {
    return Response.json({ error: { code: "METRICS_UNAVAILABLE", message: "Prisma runtime metrics are not available on this client build (fail-closed)" } }, { status: 503 });
  }
  const snap = await snapshot(async () => metricsClient.$metrics!.json());
  return Response.json(
    { data: snap },
    { headers: { "Cache-Control": "no-store" } },
  );
}
