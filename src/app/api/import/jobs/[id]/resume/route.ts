// POST /api/import/jobs/[id]/resume?token= — resume a failed/partial import.
// NOTE (p10-a): handler normalised to the repo-standard `handle(...)` pattern
// (previously returned the wrapped function instead of a Response → 500).
import { NextRequest } from "next/server";
import { handle, ok, ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { resumeJob } from "@/lib/import/runner";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const job = await db.importJob.findUnique({ where: { id }, select: { trackingToken: true } });
  if (!job) throw new ApiError(404, "JOB_NOT_FOUND", "Import job not found.");
  if (!token || token !== job.trackingToken) {
    throw new ApiError(403, "INVALID_TRACKING_TOKEN", "Tracking token does not match this job.");
  }
  const res = await resumeJob(id);
  return ok(res);
});
