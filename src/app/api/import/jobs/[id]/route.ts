// GET /api/import/jobs/[id]?token= — poll job progress + summary (public tracking).
// The claim token is included in the summary once generated (single-use, hashed at rest).
// NOTE (p10-a): handler normalised to the repo-standard `handle(...)` pattern
// (previously returned the wrapped function instead of a Response → 500).
import { NextRequest } from "next/server";
import { handle, ok, ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { parseJson } from "@/lib/json";
import type { JobSummary } from "@/lib/import/summary";
import type { SellerImportJobGetData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const job = await db.importJob.findUnique({
    where: { id },
    include: {
      items: { orderBy: { createdAt: "asc" } },
      store: { select: { id: true, name: true, slug: true, status: true } },
    },
  });
  if (!job) throw new ApiError(404, "JOB_NOT_FOUND", "Import job not found.");
  if (!token || token !== job.trackingToken) {
    throw new ApiError(403, "INVALID_TRACKING_TOKEN", "Tracking token does not match this job.");
  }
  const summary = parseJson<JobSummary>(job.summaryJson, {});
  const progress = parseJson<Record<string, number>>(job.progressJson, {});
  const error = parseJson<{ code?: string; message?: string }>(job.errorJson, {});
  const payload: SellerImportJobGetData = {
    id: job.id,
    platform: job.platform,
    platformLabel: summary.platformLabel ?? job.platform,
    urlType: job.urlType,
    inputUrl: job.inputUrl,
    status: job.status,
    phaseDetail: job.phaseDetail,
    isFixture: job.isFixture,
    progress,
    error: error.message ? error : null,
    summary: {
      shop: summary.shop ?? null,
      authorisationRequired: summary.authorisationRequired ?? false,
      beginUrl: summary.beginUrl ?? null,
      missingEnv: summary.missingEnv ?? [],
      claimToken: summary.claimToken ?? null,
      claimExpiresAt: summary.claimExpiresAt ?? null,
      claimMethod: summary.claimMethod ?? null,
      warnings: summary.warnings ?? [],
      productsOk: summary.productsOk ?? null,
      productsFailed: summary.productsFailed ?? null,
    },
    store: job.store ? { id: job.store.id, name: job.store.name, slug: job.store.slug, status: job.store.status } : null,
    items: job.items.map((it) => ({
      id: it.id,
      sourceProductId: it.sourceProductId,
      title: it.title,
      status: it.status,
      error: it.error,
      warnings: parseJson<string[]>(it.warningsJson, []),
    })),
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    createdAt: job.createdAt.toISOString(),
  };
  return ok(payload);
});
