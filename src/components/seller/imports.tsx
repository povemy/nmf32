"use client";
// Phase 10b — Seller IMPORT CENTRE: marketplace connections, import jobs with real
// progress/errors, retry/resume, and the publish gate for import-generated stores.
import { useCallback, useEffect, useState } from "react";
import {
  Cable,
  CheckCircle2,
  Clock3,
  CloudOff,
  DatabaseZap,
  ExternalLink,
  Loader2,
  RefreshCw,
  Rocket,
  ShieldAlert,
  Store,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { apiGet, apiSend, runMutation, type SellerNav } from "./ui-bits";

type Connection = {
  platform: string;
  status: string;
  envConfigured: boolean;
  shopName: string | null;
  expiresAt: string | null;
};

type Job = {
  id: string;
  trackingToken: string;
  platform: string;
  urlType: string;
  inputUrl: string;
  status: string;
  phaseDetail: string | null;
  isFixture: boolean;
  storeId: string | null;
  createdAt: string;
  finishedAt: string | null;
  itemCount: number;
  productsOk: number | null;
  productsFailed: number | null;
  progress: Record<string, number>;
  errorMessage: string | null;
};

type Payload = {
  jobs: Job[];
  connections: Connection[];
  env: { shopee: boolean; tiktok: boolean };
};

const JOB_LABEL: Record<string, string> = {
  queued: "Queued",
  validating: "Validating URL",
  awaiting_authorisation: "Awaiting authorisation",
  connecting: "Connecting",
  fetching_shop: "Fetching shop",
  importing_products: "Importing products",
  importing_variants: "Importing variants",
  processing_images: "Processing images",
  generating_seo: "Generating SEO",
  generating_storefront: "Generating storefront",
  awaiting_claim: "Awaiting claim",
  completed: "Completed",
  completed_with_warnings: "Completed with warnings",
  failed: "Failed",
};

const PLATFORM_LABEL: Record<string, string> = { shopee: "Shopee", tiktok: "TikTok Shop", fixture: "Demo fixture" };

export default function SellerImports({ onNavigate }: { onNavigate: (nav: SellerNav) => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishBlockers, setPublishBlockers] = useState<string[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const d = await apiGet<Payload>("/api/store/imports");
      setData(d);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional initial data fetch
    refresh();
    const t = setInterval(refresh, 8000); // live progress for running jobs
    return () => clearInterval(t);
  }, [refresh]);

  async function resume(job: Job) {
    setBusyJob(job.id);
    const ok = await runMutation(
      () => apiSend("POST", `/api/import/jobs/${job.id}/resume?token=${encodeURIComponent(job.trackingToken)}`),
      "Import resumed"
    );
    if (ok) await refresh();
    else toast.error("Could not resume the import");
    setBusyJob(null);
  }

  async function disconnect(platform: string) {
    const ok = await runMutation(
      () => apiSend("DELETE", `/api/store/connections/disconnect?platform=${platform}`),
      `${PLATFORM_LABEL[platform] ?? platform} disconnected`
    );
    if (ok) await refresh();
  }

  async function beginAuth(platform: string) {
    try {
      const r = await apiGet<{ authorizeUrl: string | null; envConfigured: boolean }>(
        `/api/store/connections/${platform}/begin`
      );
      if (r.authorizeUrl) {
        window.open(r.authorizeUrl, "_blank", "noopener");
        toast.info("Complete the authorisation in the opened tab, then refresh this page.");
      } else {
        toast.error(`${PLATFORM_LABEL[platform]} app credentials are not configured on the server (env).`);
      }
    } catch {
      toast.error("Could not start the authorisation flow.");
    }
  }

  async function publish() {
    setPublishing(true);
    setPublishBlockers(null);
    try {
      await apiSend("POST", "/api/store/publish");
      toast.success("Store published! Your storefront is live.");
      await refresh();
      onNavigate({ view: "dashboard" });
    } catch (err) {
      // parse blockers from the 422 details envelope
      let blockers: string[] | null = null;
      try {
        const res = await fetch("/api/store/publish", { method: "POST" });
        const body = (await res.json()) as { error?: { details?: { blockers?: string[] }; message?: string } };
        blockers = body.error?.details?.blockers ?? [body.error?.message ?? "Store cannot be published yet."];
      } catch {
        blockers = [err instanceof Error ? err.message : "Store cannot be published yet."];
      }
      setPublishBlockers(blockers);
      toast.error("Publication blocked — see the checklist");
    }
    setPublishing(false);
  }

  if (failed) {
    return (
      <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
        <CloudOff className="mx-auto mb-2 h-6 w-6" /> Could not load imports.{" "}
        <Button variant="outline" size="sm" onClick={refresh} className="ml-2">
          Retry
        </Button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ------------------------------------------------ connections */}
      <section aria-label="Marketplace connections" className="rounded-xl border bg-card p-4 sm:p-5">
        <header className="flex items-center gap-2 pb-3">
          <Cable className="h-4.5 w-4.5 text-teal-700" />
          <h2 className="text-sm font-bold">Marketplace connections</h2>
          <span className="text-xs text-muted-foreground">— official APIs require the shop owner to authorise NOMOFEE once</span>
        </header>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {(["shopee", "tiktok"] as const).map((p) => {
            const conn = data.connections.find((c) => c.platform === p && c.status !== "disconnected");
            const envOk = p === "shopee" ? data.env.shopee : data.env.tiktok;
            return (
              <div key={p} className="rounded-lg border p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{PLATFORM_LABEL[p]}</p>
                  {conn?.status === "connected" ? (
                    <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200 hover:bg-emerald-100">Connected</Badge>
                  ) : envOk ? (
                    <Badge className="bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-100">Authorisation needed</Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">
                      <ShieldAlert className="mr-1 h-3 w-3" /> Server credentials missing
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {conn?.status === "connected"
                    ? `Shop: ${conn.shopName ?? conn.platform}${conn.expiresAt ? ` · token expires ${new Date(conn.expiresAt).toLocaleString()}` : ""}`
                    : envOk
                      ? "Connect the shop account that owns the catalogue you want to import."
                      : "Set the platform env keys on the server to enable live imports (see README → Marketplace configuration)."}
                </p>
                <div className="mt-2.5 flex gap-2">
                  {conn?.status === "connected" ? (
                    <Button variant="outline" size="sm" onClick={() => disconnect(p)} className="min-h-[36px]">
                      Disconnect
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => beginAuth(p)}
                      disabled={!envOk}
                      className={cn("min-h-[36px]", envOk && "bg-brand-gradient-deep hover:brightness-110")}
                    >
                      Connect {PLATFORM_LABEL[p]}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ------------------------------------------------ publish gate */}
      <section aria-label="Publication" className="rounded-xl border bg-card p-4 sm:p-5">
        <header className="flex flex-wrap items-center justify-between gap-3 pb-1">
          <div className="flex items-center gap-2">
            <Rocket className="h-4.5 w-4.5 text-teal-700" />
            <h2 className="text-sm font-bold">Publish your store</h2>
          </div>
          <Button
            onClick={publish}
            disabled={publishing}
            className="min-h-[44px] bg-brand-gradient-deep hover:brightness-110"
          >
            {publishing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Rocket className="mr-1.5 h-4 w-4" />}
            Run publication checks & publish
          </Button>
        </header>
        <p className="text-xs text-muted-foreground">
          A generated store goes live only after it is claimed, has active products, support email and SEO title. Checkout stays
          disabled for unclaimed or unpublished stores — enforced server-side.
        </p>
        {publishBlockers ? (
          <ul className="mt-3 space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            {publishBlockers.map((b, i) => (
              <li key={i} className="flex gap-1.5">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {b}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {/* ------------------------------------------------ import jobs */}
      <section aria-label="Import jobs" className="rounded-xl border bg-card p-4 sm:p-5">
        <header className="flex items-center gap-2 pb-3">
          <DatabaseZap className="h-4.5 w-4.5 text-teal-700" />
          <h2 className="text-sm font-bold">Import jobs</h2>
          <span className="text-xs text-muted-foreground">— newest first, auto-refreshing</span>
        </header>
        {data.jobs.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <Store className="mx-auto mb-2 h-7 w-7 text-muted-foreground" />
            <p className="text-sm font-medium">No imports yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Paste a Shopee or TikTok Shop link on the “Generate store” page, or run a labelled demo import to explore the flow.
            </p>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {data.jobs.map((job) => {
              const total = job.progress.discovered ?? job.itemCount ?? 0;
              const processed = job.progress.processed ?? 0;
              const running = !["completed", "completed_with_warnings", "failed", "awaiting_authorisation", "awaiting_claim"].includes(job.status);
              return (
                <li key={job.id} className="rounded-lg border p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">
                        {PLATFORM_LABEL[job.platform] ?? job.platform} · {job.urlType} import
                        {job.isFixture ? <Badge className="ml-2 border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-50">Demo data</Badge> : null}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">{job.inputUrl}</p>
                    </div>
                    <StatusPill status={job.status} />
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Clock3 className="h-3 w-3" /> {new Date(job.createdAt).toLocaleString("en-MY", { dateStyle: "medium", timeStyle: "short" })}
                    </span>
                    {total > 0 ? (
                      <span className="tabular-nums">
                        {processed}/{total} products · {job.progress.succeeded ?? 0} ok · {job.progress.failed ?? 0} failed · {job.progress.skipped ?? 0} skipped
                      </span>
                    ) : null}
                    {job.phaseDetail ? <span className="italic">{job.phaseDetail}</span> : null}
                  </div>

                  {running && total > 0 ? <Progress value={Math.round((processed / Math.max(total, 1)) * 100)} className="mt-2 h-1.5" /> : null}

                  {job.errorMessage ? (
                    <p className="mt-2 flex items-start gap-1.5 rounded-md bg-rose-50 p-2 text-xs text-rose-800">
                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {job.errorMessage}
                    </p>
                  ) : null}

                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {job.status === "failed" || job.status === "completed_with_warnings" ? (
                      <Button variant="outline" size="sm" disabled={busyJob === job.id} onClick={() => resume(job)} className="min-h-[36px]">
                        {busyJob === job.id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                        Retry / resume import
                      </Button>
                    ) : null}
                    {job.storeId && (job.status === "completed" || job.status === "completed_with_warnings" || job.status === "awaiting_claim") ? (
                      <>
                        <Button variant="outline" size="sm" onClick={() => onNavigate({ view: "products" })} className="min-h-[36px]">
                          Review imported products
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => onNavigate({ view: "seo" })} className="min-h-[36px]">
                          SEO settings
                        </Button>
                      </>
                    ) : null}
                    {job.status === "awaiting_authorisation" ? (
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <ShieldAlert className="h-3.5 w-3.5" /> Connect the marketplace above, then re-submit the link from the Generate page.
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "completed"
      ? "bg-emerald-100 text-emerald-800 border-emerald-200"
      : status === "completed_with_warnings" || status === "awaiting_claim" || status === "awaiting_authorisation"
        ? "bg-amber-100 text-amber-800 border-amber-200"
        : status === "failed"
          ? "bg-rose-100 text-rose-800 border-rose-200"
          : "bg-teal-50 text-teal-800 border-teal-200";
  return (
    <Badge variant="outline" className={cn("shrink-0 gap-1 font-semibold", tone)}>
      {["completed", "completed_with_warnings", "failed"].includes(status) ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : (
        <Loader2 className="h-3 w-3 animate-spin" />
      )}
      {JOB_LABEL[status] ?? status}
    </Badge>
  );
}

void ExternalLink;
