// GET /api/health/live — process LIVENESS only. NO database access by design
// (user rule #3). Reports process uptime, event-loop lag, memory, open FDs —
// all read from /proc and the in-process samplers. Cheap enough to poll at 1Hz.
import { lagP95 } from "@/lib/metrics";

export const dynamic = "force-dynamic";

export async function GET() {
  const mem = process.memoryUsage();
  let fd = 0;
  try {
    fd = (await import("fs")).readdirSync("/proc/self/fd").length;
  } catch {
    fd = -1;
  }
  return Response.json(
    {
      data: {
        status: "live",
        uptimeSec: Math.round(process.uptime()),
        eventLoopLagP95Ms: lagP95(),
        rssMb: Math.round((mem.rss / 1048576) * 10) / 10,
        heapUsedMb: Math.round((mem.heapUsed / 1048576) * 10) / 10,
        fdCount: fd,
        dbQueried: false,
        time: new Date().toISOString(),
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
