// POST /api/import/jobs — create an import job from a pasted URL (public).
// Real marketplaces require seller authorisation; the job honestly reports
// awaiting_authorisation when credentials/connection are missing. Fixture (demo)
// URLs run the full pipeline and are labelled as demo data.
// NOTE (p10-a): handler normalised to the repo-standard `handle(...)` pattern
// (previously returned the wrapped function instead of a Response → 500).
// B5 (SSRF hardening): 5/min/IP rate limit + import capability gate. Anonymous
// callers must present the signed `import_cap` cookie issued by
// POST /api/import/resolve (60-min TTL); sellers with a live session bypass.
// The accountless onboarding flow is unchanged for real browsers — resolve is
// always called first, so the cookie is present by the time a job is created;
// scripted job-spam now has to pass the resolve step (and its rate limit).
import { NextRequest } from "next/server";
import { handle, ok, fail, ApiError } from "@/lib/api";
import { createImportJob } from "@/lib/import/runner";
import { rateLimit } from "@/lib/rate-limit";
import { getSession } from "@/lib/auth";
import {
  IMPORT_CAP_COOKIE,
  enforceImportCapJobBudget,
  importCapSecret,
  verifyImportCap,
} from "@/lib/import-cap";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  rateLimit(req, "import", 5);
  const body = (await req.json().catch(() => ({}))) as { url?: string; allowFixture?: boolean };
  if (!body.url || typeof body.url !== "string") {
    return fail(400, "MISSING_URL", "Paste a marketplace URL first.");
  }
  const session = await getSession().catch(() => null);
  if (session?.userType !== "seller") {
    // fail-closed first (503 IMPORT_CAP_SECRET_UNSET in production when unset)
    importCapSecret();
    const cap = req.cookies.get(IMPORT_CAP_COOKIE)?.value;
    if (!verifyImportCap(cap)) {
      return fail(
        403,
        "IMPORT_CAPABILITY_REQUIRED",
        "Resolve the import URL first (POST /api/import/resolve) to obtain an import capability, or sign in as a seller."
      );
    }
    // PHASE 2.1 (§8): per-capability job budget — one capability cannot mint
    // unlimited jobs; exceeding it answers 429 with the reset time. Re-resolving
    // a URL after the 60-minute TTL issues a fresh capability (self-service).
    enforceImportCapJobBudget(cap);
  }
  const job = await createImportJob({ inputUrl: body.url, allowFixture: body.allowFixture !== false });
  return ok({
    jobId: job.jobId,
    trackingToken: job.trackingToken,
    status: job.status,
    pollUrl: `/api/import/jobs/${job.jobId}?token=${job.trackingToken}`,
  });
});
