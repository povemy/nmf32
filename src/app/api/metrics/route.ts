// GET /api/metrics — LT load-test telemetry (token-gated, fail-closed).
// User rule #4: bounded, no secrets/PII/SQL params; /api/metrics traffic is
// EXCLUDED from the counters themselves (EXCLUDED_LABELS in lib/metrics).
// Requires header: X-Metrics-Token: <METRICS_TOKEN from .env>. 503 if unset,
// 401 on mismatch — never open by default.
import { snapshot } from "@/lib/metrics";
import { prismaBase } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const expected = process.env.METRICS_TOKEN;
  if (!expected) {
    return Response.json({ error: { code: "METRICS_UNCONFIGURED", message: "METRICS_TOKEN is not set; metrics are disabled (fail-closed)" } }, { status: 503 });
  }
  const got = req.headers.get("x-metrics-token");
  if (got !== expected) {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "Invalid or missing X-Metrics-Token" } }, { status: 401 });
  }
  const snap = await snapshot(async () => prismaBase.$metrics.json());
  return Response.json(
    { data: snap },
    { headers: { "Cache-Control": "no-store" } },
  );
}
