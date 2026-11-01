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
    // Phase 2.3 (P2.3-6): production sanitization — a DB probe failure can
    // carry Prisma connection internals (server host/port, credentials shape);
    // clients get the generic reason + a short ref id, the details stay in the
    // server log. Dev keeps the full message for debugging.
    const isProd = process.env.NODE_ENV === "production";
    let refId = "";
    if (isProd) {
      refId = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      console.error(`[health/ready] ref=${refId} probe failed:`, e);
    }
    return Response.json(
      {
        error: {
          code: "NOT_READY",
          message: isProd ? "readiness probe failed" : e instanceof Error ? e.message : "readiness probe failed",
          dbProbeMs: Math.round((performance.now() - t0) * 10) / 10,
          ...(isProd ? { meta: { refId } } : {}),
        },
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
