// GET /api/health/ready — bounded readiness probe (user rule #3).
// ONE lightweight query (SELECT 1) raced against a 1.2s timeout. Never runs
// the full-ledger invariants — those stay in /api/health for ops/diagnostics
// and are excluded from routine load-test polling.
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const t0 = performance.now();
  try {
    const res = await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("READY_TIMEOUT")), 1200)),
    ]);
    void res;
    return Response.json(
      { data: { status: "ready", db: "up", dbProbeMs: Math.round((performance.now() - t0) * 10) / 10, time: new Date().toISOString() } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return Response.json(
      {
        error: {
          code: "NOT_READY",
          message: e instanceof Error ? e.message : "readiness probe failed",
          dbProbeMs: Math.round((performance.now() - t0) * 10) / 10,
        },
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
