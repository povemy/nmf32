// POST /api/import/jobs — create an import job from a pasted URL (public).
// Real marketplaces require seller authorisation; the job honestly reports
// awaiting_authorisation when credentials/connection are missing. Fixture (demo)
// URLs run the full pipeline and are labelled as demo data.
// NOTE (p10-a): handler normalised to the repo-standard `handle(...)` pattern
// (previously returned the wrapped function instead of a Response → 500).
import { NextRequest } from "next/server";
import { handle, ok, fail } from "@/lib/api";
import { createImportJob } from "@/lib/import/runner";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  const body = (await req.json().catch(() => ({}))) as { url?: string; allowFixture?: boolean };
  if (!body.url || typeof body.url !== "string") {
    return fail(400, "MISSING_URL", "Paste a marketplace URL first.");
  }
  const job = await createImportJob({ inputUrl: body.url, allowFixture: body.allowFixture !== false });
  return ok({
    jobId: job.jobId,
    trackingToken: job.trackingToken,
    status: job.status,
    pollUrl: `/api/import/jobs/${job.jobId}?token=${job.trackingToken}`,
  });
});
