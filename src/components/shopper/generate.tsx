"use client";
// ============================================================================
// Shopper — "GENERATE YOUR STORE" + CLAIM FLOW (Phase 10a).
// Nexova-style landing experience: paste a marketplace URL → auto-detect →
// live import job timeline (real statuses, polled) → result → claim flow
// (ownership verification → seller account → bind) → seller portal.
// Also exports ClaimView for deep-links (?claim_job=…&claim_token=…).
//
// API shapes verified against the route files (Phase 6/7):
//   POST /api/import/resolve            → {platform, platformLabel, urlType, …, connector}
//   POST /api/import/jobs               → {jobId, trackingToken, status, pollUrl}
//   GET  /api/import/jobs/:id?token=    → job + items + progress + summary
//   POST /api/import/jobs/:id/resume    → {status}   (runs/resumes the pipeline)
//   POST /api/claim/bind                → {store:{id,name,slug}, nextStep}
//   POST /api/auth/register|login       → {userType, seller}
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles,
  Store,
  Link2,
  ShieldCheck,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  ExternalLink,
  Eye,
  ArrowRight,
  AlertTriangle,
  KeyRound,
  UserPlus,
  LogIn,
  Rocket,
  Minimize2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApp } from "@/lib/app-store";
import { setSessionToken } from "@/lib/session-client";
import { cn } from "@/lib/utils";
import { ApiFail, fetchJson, postJson, type ShopperCtx } from "./ui-bits";

// ---------------------------------------------------------------------------
// API types (mirror the route handlers exactly — no invented fields)
// ---------------------------------------------------------------------------

type ResolveResult = {
  platform: "shopee" | "tiktok" | "fixture";
  platformLabel: string;
  urlType: "shop" | "product" | "unknown";
  shopId: string | null;
  productId: string | null;
  normalizedUrl: string;
  isFixture: boolean;
  connector: {
    envConfigured: boolean;
    connected: boolean;
    needsAuthorisation: boolean;
    missingEnv: string[];
  };
};

type CreateJobResult = {
  jobId: string;
  trackingToken: string;
  status: string;
  pollUrl: string;
};

type JobItemT = {
  id: string;
  sourceProductId: string;
  title: string | null;
  status: string; // pending | importing | ok | skipped | failed
  error: string | null;
  warnings: string[];
};

type JobSummaryT = {
  shop: { name: string; sourceShopId: string; region?: string | null } | null;
  authorisationRequired: boolean;
  beginUrl: string | null;
  missingEnv: string[];
  claimToken: string | null;
  claimExpiresAt: string | null;
  claimMethod: string | null;
  warnings: string[];
  productsOk: number | null;
  productsFailed: number | null;
};

type JobT = {
  id: string;
  platform: string;
  platformLabel: string;
  urlType: string;
  inputUrl: string;
  status: string;
  phaseDetail: string | null;
  isFixture: boolean;
  progress: Record<string, number>;
  error: { code?: string; message?: string } | null;
  summary: JobSummaryT;
  store: { id: string; name: string; slug: string; status: string } | null;
  items: JobItemT[];
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

type BindResult = {
  store: { id: string; name: string; slug: string };
  nextStep: string;
};

type SellerT = {
  id: string;
  email: string;
  fullName: string;
  displayName: string;
  status: string;
  storeId: string | null;
  storeSlug: string | null;
  storeName: string | null;
};

type AuthResult = { userType: string; token?: string; seller?: SellerT };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEMO_URL = "https://demo.shopmesh.fixture/shop/aurora-test";

const TERMINAL_STATUSES = ["completed", "completed_with_warnings", "failed"];

/** Canonical pipeline timeline (real ImportJob.status values, in execution order). */
const PHASES: { key: string; label: string }[] = [
  { key: "queued", label: "Job queued" },
  { key: "validating", label: "Validating link" },
  { key: "fetching_shop", label: "Fetching shop details" },
  { key: "importing_products", label: "Importing products" },
  { key: "importing_variants", label: "Importing variants" },
  { key: "processing_images", label: "Processing images" },
  { key: "generating_seo", label: "Generating SEO metadata" },
  { key: "generating_storefront", label: "Generating storefront" },
  { key: "awaiting_claim", label: "Preparing secure claim link" },
  { key: "completed", label: "Store ready" },
];

const ITEM_STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  importing: "Importing…",
  ok: "Imported",
  skipped: "Skipped (already imported)",
  failed: "Failed",
};

/** Instant client-side hint while typing (server /api/import/resolve is the truth). */
function detectHint(raw: string): { label: string; tone: "teal" | "amber" } | null {
  const u = raw.trim().toLowerCase();
  if (!u) return null;
  if (u.includes("shopee.")) return { label: "Shopee link detected", tone: "teal" };
  if (u.includes("tiktok.com")) return { label: "TikTok Shop link detected", tone: "teal" };
  if (u.includes("demo.shopmesh.fixture") || u.includes(".fixture.import")) return { label: "Demo fixture link", tone: "teal" };
  try {
    const host = new URL(u.startsWith("http") ? u : `https://${u}`).hostname;
    if (host) return { label: "Marketplace auto-detect on submit", tone: "amber" };
  } catch {
    /* not a URL yet */
  }
  return null;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ---------------------------------------------------------------------------
// GenerateStoreView — the 4-step landing experience
// ---------------------------------------------------------------------------

type Step = "input" | "authorisation" | "progress" | "result";

export default function GenerateStoreView({ ctx }: { ctx: ShopperCtx }) {
  const [step, setStep] = useState<Step>("input");

  // step 1
  const [url, setUrl] = useState("");
  const [demo, setDemo] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resolveResult, setResolveResult] = useState<ResolveResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // job (persisted for polling / resume / claim)
  const [jobId, setJobId] = useState<string | null>(null);
  const [trackingToken, setTrackingToken] = useState<string | null>(null);
  const [job, setJob] = useState<JobT | null>(null);

  // kick-off (the pipeline executes inline via the resume endpoint)
  const [kickState, setKickState] = useState<"idle" | "running" | "failed">("idle");
  const [kickError, setKickError] = useState<string | null>(null);
  const kickedFor = useRef<string | null>(null);

  // step 4
  const [claimOpen, setClaimOpen] = useState(false);
  const [claimed, setClaimed] = useState<BindResult | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);

  const setSurface = useApp((s) => s.setSurface);
  const refreshMe = useApp((s) => s.refreshMe);

  /** Land in the seller portal with a freshly-hydrated session. */
  const openSellerPortal = useCallback(async () => {
    setPortalBusy(true);
    try {
      await refreshMe();
    } catch {
      /* session state is best-effort — the portal re-checks on mount */
    }
    setSurface("seller");
  }, [refreshMe, setSurface]);

  const kickOff = useCallback((id: string, token: string) => {
    if (kickedFor.current === id) return; // never kick the same job twice
    kickedFor.current = id;
    setKickState("running");
    setKickError(null);
    postJson<{ status: string }>(`/api/import/jobs/${id}/resume?token=${encodeURIComponent(token)}`, {})
      .then(() => setKickState("idle"))
      .catch((e) => {
        setKickState("failed");
        setKickError(e instanceof Error ? e.message : "Could not start the import pipeline.");
      });
  }, []);

  const retryKick = useCallback(() => {
    if (!jobId || !trackingToken) return;
    kickedFor.current = null;
    kickOff(jobId, trackingToken);
  }, [jobId, trackingToken, kickOff]);

  // ---- submit: resolve → create job → branch ------------------------------
  async function handleSubmit() {
    const trimmed = url.trim();
    if (!trimmed) {
      setFormError("Paste a Shopee, TikTok Shop or demo link first.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    setResolveResult(null);
    try {
      const resolved = await postJson<ResolveResult>("/api/import/resolve", { url: trimmed });
      setResolveResult(resolved);
      const created = await postJson<CreateJobResult>("/api/import/jobs", {
        url: trimmed,
        allowFixture: demo,
      });
      setJobId(created.jobId);
      setTrackingToken(created.trackingToken);
      setJob(null);
      setClaimed(null);
      setClaimOpen(false);
      kickedFor.current = null;
      if (created.status === "awaiting_authorisation") {
        // fetch once so the panel has beginUrl + missingEnv from the job summary
        try {
          const j = await fetchJson<JobT>(`/api/import/jobs/${created.jobId}?token=${encodeURIComponent(created.trackingToken)}`);
          setJob(j);
        } catch {
          /* panel still renders from created.status */
        }
        setStep("authorisation");
      } else {
        setStep("progress");
        kickOff(created.jobId, created.trackingToken);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Something went wrong.";
      setFormError(msg);
      if (e instanceof ApiFail && (e.code === "FIXTURE_NOT_ALLOWED" || e.code === "UNSUPPORTED_MARKETPLACE")) {
        setFormError(
          e.code === "FIXTURE_NOT_ALLOWED"
            ? "Fixture imports are disabled — tick “Use demo data” to import a demo store, or paste a real marketplace URL."
            : msg
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  function startOver() {
    setStep("input");
    setUrl("");
    setDemo(false);
    setResolveResult(null);
    setFormError(null);
    setJobId(null);
    setTrackingToken(null);
    setJob(null);
    setKickState("idle");
    setKickError(null);
    setClaimOpen(false);
    setClaimed(null);
    kickedFor.current = null;
  }

  // ---- polling (step 2) ----------------------------------------------------
  useEffect(() => {
    if (step !== "progress" || !jobId || !trackingToken) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const tick = async () => {
      try {
        const j = await fetchJson<JobT>(`/api/import/jobs/${jobId}?token=${encodeURIComponent(trackingToken)}`);
        if (!alive) return;
        failures = 0;
        setJob(j);
        if (TERMINAL_STATUSES.includes(j.status)) {
          setStep("result");
          return; // terminal — stop polling
        }
      } catch {
        failures += 1;
        if (failures >= 5 && alive) {
          setKickError("Lost contact with the import job. Check your connection and retry.");
          setKickState("failed");
          return;
        }
      }
      if (alive) timer = setTimeout(tick, 1200);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [step, jobId, trackingToken]);

  const previewSlug = job?.store?.slug ?? null;

  // =========================================================================
  // CLAIMED success screen
  // =========================================================================
  if (claimed) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-16">
        <div className="rounded-2xl border border-emerald-200 bg-white p-8 text-center shadow-soft">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100">
            <CheckCircle2 className="h-9 w-9 text-emerald-600" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-teal-900">Store claimed!</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">{claimed.store.name}</span> ({claimed.store.slug}) is now bound to
            your seller account.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{claimed.nextStep}</p>
          <div className="mt-6 flex flex-col items-center justify-center gap-2.5 sm:flex-row">
            <Button
              onClick={() => void openSellerPortal()}
              disabled={portalBusy}
              className="min-h-[44px] bg-brand-gradient-deep text-white hover:opacity-90"
            >
              {portalBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Rocket className="h-4 w-4" aria-hidden="true" />}
              Open seller command centre <ArrowRight className="h-4 w-4" />
            </Button>
            {previewSlug ? (
              <Button
                variant="outline"
                className="min-h-[44px]"
                onClick={() => ctx.nav({ name: "storefront", slug: previewSlug })}
              >
                <Eye className="h-4 w-4" /> Preview storefront
              </Button>
            ) : null}
          </div>
          <p className="mt-4 text-[11px] text-muted-foreground">
            Configure and publish from the seller portal — the storefront goes live once published.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-12">
      {/* ---------- hero ---------- */}
      <div className="mb-8 text-center">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-teal-600/20 bg-teal-50 px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-teal-800">
          <Sparkles className="h-3.5 w-3.5" /> For sellers
        </span>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-teal-900 sm:text-4xl">
          Turn your marketplace shop into <span className="text-brand-gradient">your own store</span>
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
          Paste a Shopee or TikTok Shop link and NOMOFEE auto-builds a draft storefront with your catalogue. You then verify
          ownership, claim it and publish — your shop, your rules.
        </p>
      </div>

      {/* ---------- STEP 1 — input ---------- */}
      {step === "input" ? (
        <div className="rounded-2xl border border-teal-600/15 bg-white p-5 shadow-soft sm:p-7">
          <Label htmlFor="gen-url" className="text-sm font-semibold">
            Your marketplace shop or product link
          </Label>
          <div className="mt-2 flex flex-col gap-2.5 sm:flex-row">
            <div className="relative flex-1">
              <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="gen-url"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setFormError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !submitting) void handleSubmit();
                }}
                placeholder="https://shopee.com.my/your.shop  ·  demo links work too"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                className="pl-9 min-h-[44px]"
                aria-describedby="gen-url-hint"
              />
            </div>
            <Button
              onClick={() => void handleSubmit()}
              disabled={submitting}
              className="min-h-[44px] shrink-0 bg-brand-gradient-deep px-5 font-bold text-white hover:opacity-90"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Sparkles className="h-4 w-4" aria-hidden="true" />}
              {submitting ? "Detecting…" : "Import & Generate Store"}
            </Button>
          </div>

          {/* auto-detect hint */}
          <div id="gen-url-hint" className="mt-2 flex min-h-[22px] flex-wrap items-center gap-1.5" aria-live="polite">
            {detectHint(url) ? (
              <Badge variant={detectHint(url)!.tone === "teal" ? "default" : "outline"} className={cn(detectHint(url)!.tone === "teal" && "bg-teal-700 text-white")}>
                {detectHint(url)!.label}
              </Badge>
            ) : null}
            <span className="text-[11px] text-muted-foreground">Shopee · TikTok Shop · demo fixture links are auto-detected.</span>
          </div>

          {formError ? (
            <Alert variant="destructive" className="mt-3">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>That link didn&apos;t work</AlertTitle>
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}

          <Separator className="my-5" />

          <div className="flex items-start gap-2.5">
            <Checkbox
              id="gen-demo"
              checked={demo}
              onCheckedChange={(v) => setDemo(v === true)}
              className="mt-0.5"
            />
            <div>
              <Label htmlFor="gen-demo" className="text-sm font-medium leading-snug">
                Use demo data (no marketplace connection needed — creates a fully-labelled demo store)
              </Label>
              <button
                type="button"
                onClick={() => {
                  setUrl(DEMO_URL);
                  setDemo(true);
                  setFormError(null);
                }}
                className="mt-1 inline-flex min-h-[44px] items-center gap-1 text-xs font-semibold text-teal-700 underline-offset-2 hover:underline"
              >
                <Minimize2 className="h-3 w-3" /> Try a demo import (fills a demo shop link)
              </button>
            </div>
          </div>

          <p className="mt-4 rounded-lg bg-muted/60 p-3 text-[11px] leading-relaxed text-muted-foreground">
            <ShieldCheck className="mr-1 inline h-3.5 w-3.5 align-[-2px] text-teal-700" />
            Official marketplace APIs require seller authorisation — we&apos;ll ask you to connect your shop when importing a real
            marketplace URL. Demo data is clearly labelled and never presented as a live import.
          </p>
        </div>
      ) : null}

      {/* ---------- STEP 1.5 — awaiting authorisation (honest) ---------- */}
      {step === "authorisation" ? (
        <div className="rounded-2xl border border-amber-200 bg-white p-5 shadow-soft sm:p-7" role="status">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="bg-amber-100 text-amber-900 hover:bg-amber-100">
              <ShieldAlert className="h-3 w-3" /> AWAITING AUTHORISATION
            </Badge>
            {job?.platformLabel ? <Badge variant="outline">{job.platformLabel}</Badge> : null}
            {job?.isFixture ? <DemoBadge /> : null}
          </div>
          <h2 className="mt-3 flex items-center gap-2 text-xl font-extrabold text-teal-900">
            <ShieldAlert className="h-5 w-5 text-amber-600" /> Marketplace authorisation required
          </h2>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>
              The official Shopee / TikTok Shop APIs only release a seller&apos;s catalogue after the shop owner connects their
              account — NOMOFEE never scrapes marketplace pages.
            </li>
            {job && job.summary.missingEnv.length > 0 ? (
              <li>
                Platform credentials not yet configured:{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{job.summary.missingEnv.join(", ")}</code>{" "}
                (server env). The sandbox may not have marketplace app credentials configured yet.
              </li>
            ) : null}
            {job?.phaseDetail ? <li className="text-foreground">{job.phaseDetail}</li> : null}
          </ul>
          {job?.summary.beginUrl ? (
            <div className="mt-4">
              <a href={job.summary.beginUrl} target="_blank" rel="noopener noreferrer" className="inline-block">
                <Button className="min-h-[44px] bg-brand-gradient-deep font-bold text-white hover:opacity-90">
                  <ExternalLink className="h-4 w-4" /> Connect {job.platformLabel}
                </Button>
              </a>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Opens the official {job.platformLabel} authorisation page in a new tab. After connecting, come back and retry the
                import.
              </p>
            </div>
          ) : (
            <p className="mt-4 text-xs text-muted-foreground">
              Once the platform credentials are configured on the server, a “Connect {job?.platformLabel ?? "marketplace"}” button
              will appear here and in the seller portal.
            </p>
          )}
          <div className="mt-6 flex flex-wrap gap-2.5">
            <Button variant="outline" className="min-h-[44px]" onClick={startOver}>
              <RefreshCw className="h-4 w-4" /> Start over
            </Button>
            <Button
              variant="ghost"
              className="min-h-[44px] text-teal-700"
              onClick={() => {
                setUrl(DEMO_URL);
                setDemo(true);
                setStep("input");
              }}
            >
              Use demo data instead
            </Button>
          </div>
        </div>
      ) : null}

      {/* ---------- STEP 2 — live progress ---------- */}
      {step === "progress" ? (
        <ProgressPanel job={job} kickState={kickState} kickError={kickError} onRetry={retryKick} />
      ) : null}

      {/* ---------- STEP 3 — result ---------- */}
      {step === "result" && job ? (
        <ResultPanel
          job={job}
          onClaim={() => setClaimOpen(true)}
          onPreview={() => previewSlug && ctx.nav({ name: "storefront", slug: previewSlug })}
          onStartOver={startOver}
          onRetry={() => {
            setStep("progress");
            if (jobId && trackingToken) {
              kickedFor.current = null;
              kickOff(jobId, trackingToken);
            }
          }}
        />
      ) : null}

      {/* ---------- STEP 4 — claim flow ---------- */}
      {claimOpen && job ? (
        <div className="mt-8">
          <Separator className="mb-8" />
          <ClaimFlow
            job={job}
            initialClaimCode={job.summary.claimToken ?? ""}
            onBack={() => setClaimOpen(false)}
            onClaimed={(r) => setClaimed(r)}
            onSellerPortal={() => void openSellerPortal()}
          />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Demo badge
// ---------------------------------------------------------------------------

function DemoBadge() {
  return (
    <Badge className="border border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-50">
      <AlertTriangle className="h-3 w-3" /> Demo data — not from a live marketplace
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — live progress timeline (real statuses polled every 1.2s)
// ---------------------------------------------------------------------------

function ProgressPanel({
  job,
  kickState,
  kickError,
  onRetry,
}: {
  job: JobT | null;
  kickState: "idle" | "running" | "failed";
  kickError: string | null;
  onRetry: () => void;
}) {
  if (!job) {
    return (
      <div className="rounded-2xl border bg-white p-6 shadow-soft" role="status" aria-live="polite">
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-teal-700" />
          <p className="text-sm text-muted-foreground">Creating import job…</p>
        </div>
        <div className="mt-5 space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="h-6 w-6 rounded-full bg-muted" />
              <div className="h-3.5 w-40 rounded bg-muted" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const status = job.status;
  const failed = status === "failed";
  const doneAll = status === "completed" || status === "completed_with_warnings";
  const curIdx = PHASES.findIndex((p) => p.key === (doneAll ? "completed" : status));

  const progress = job.progress ?? {};
  const counts: [string, number][] = (
    [
      ["discovered", "Discovered"],
      ["processed", "Processed"],
      ["succeeded", "Succeeded"],
      ["skipped", "Skipped"],
      ["failed", "Failed"],
    ] as [string, string][]
  )
    .map(([k, label]) => [label, progress[k]] as [string, number])
    .filter(([, v]) => typeof v === "number");

  const currentLabel = failed ? "Import failed" : (PHASES[curIdx]?.label ?? status);

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border bg-white p-5 shadow-soft sm:p-7" role="status" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-extrabold text-teal-900">
              {failed ? "Import failed" : doneAll ? "Store generated" : "Generating your store…"}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {job.platformLabel} · {job.urlType === "product" ? "product link" : "shop link"} ·{" "}
              <span className="break-all">{job.inputUrl}</span>
            </p>
          </div>
          {job.isFixture ? <DemoBadge /> : null}
        </div>

        {/* current status line */}
        <p className="mt-4 rounded-lg bg-muted/60 px-3 py-2 text-sm font-medium text-teal-900">
          {failed ? (
            <>
              <XCircle className="mr-1.5 inline h-4 w-4 align-[-3px] text-rose-600" />
              {job.error?.message ?? "The import pipeline failed."}
            </>
          ) : (
            <>
              {doneAll ? (
                <CheckCircle2 className="mr-1.5 inline h-4 w-4 align-[-3px] text-emerald-600" />
              ) : (
                <Loader2 className="mr-1.5 inline h-4 w-4 animate-spin align-[-3px] text-teal-700" />
              )}
              {currentLabel}
              {job.phaseDetail && !doneAll ? <span className="font-normal text-muted-foreground"> — {job.phaseDetail}</span> : null}
            </>
          )}
        </p>

        {/* timeline */}
        <ol className="mt-5 space-y-0" aria-label="Import progress timeline">
          {PHASES.map((phase, i) => {
            const isFailedRow = failed && phase.key !== "queued";
            const done = !failed && curIdx > i;
            const current = !failed && !doneAll && curIdx === i;
            const isLast = i === PHASES.length - 1;
            const warnDone = doneAll && isLast && status === "completed_with_warnings";
            return (
              <li key={phase.key} className="relative flex gap-3 pb-5 last:pb-0">
                {!isLast ? (
                  <span className={cn("absolute left-[11px] top-6 bottom-0 w-px", done ? "bg-teal-600" : "bg-border")} aria-hidden="true" />
                ) : null}
                <span
                  className={cn(
                    "relative z-10 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2",
                    done && "border-teal-600 bg-teal-600",
                    current && "border-teal-600 bg-white",
                    !done && !current && "border-muted-foreground/25 bg-white"
                  )}
                >
                  {done ? (
                    <CheckCircle2 className={cn("h-4 w-4", warnDone ? "text-amber-500" : "text-white")} aria-hidden="true" />
                  ) : current ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-700" aria-hidden="true" />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" aria-hidden="true" />
                  )}
                </span>
                <div className="min-w-0 pt-0.5">
                  <p className={cn("text-sm font-medium leading-5", done || current ? "text-foreground" : "text-muted-foreground/70")}>
                    {phase.label}
                    {isFailedRow ? <span className="text-muted-foreground/60"> — not reached</span> : null}
                  </p>
                  {current && job.phaseDetail ? <p className="text-xs text-muted-foreground">{job.phaseDetail}</p> : null}
                </div>
              </li>
            );
          })}
        </ol>

        {/* counts */}
        {counts.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-1.5" aria-label="Progress counts">
            {counts.map(([label, v]) => (
              <Badge key={label} variant="outline" className="tabular-nums">
                {label}: {v}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>

      {/* per-item results */}
      {job.items.length > 0 ? (
        <div className="rounded-2xl border bg-white p-4 shadow-soft sm:p-5">
          <h3 className="text-sm font-bold text-teal-900">Catalogue items ({job.items.length})</h3>
          <ul className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
            {job.items.map((it) => (
              <li key={it.id} className="flex items-start justify-between gap-3 rounded-lg border bg-card/60 p-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium" title={it.title ?? it.sourceProductId}>
                    {it.title ?? it.sourceProductId}
                  </p>
                  {it.warnings.length > 0 ? (
                    <p className="mt-0.5 text-[11px] text-amber-700">{it.warnings.join(" · ")}</p>
                  ) : null}
                  {it.error ? <p className="mt-0.5 text-[11px] text-rose-700">{it.error}</p> : null}
                </div>
                <ItemStatusChip status={it.status} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* kick-off failure (pipeline could not be started) */}
      {kickState === "failed" && !TERMINAL_STATUSES.includes(job.status) ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Import pipeline did not start</AlertTitle>
          <AlertDescription>
            {kickError ?? "The server did not accept the start request."}
            <div className="mt-3">
              <Button size="sm" variant="outline" className="min-h-[44px]" onClick={onRetry}>
                <RefreshCw className="h-4 w-4" /> Retry
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function ItemStatusChip({ status }: { status: string }) {
  const map: Record<string, string> = {
    ok: "bg-emerald-100 text-emerald-800 border-emerald-200",
    failed: "bg-rose-100 text-rose-800 border-rose-200",
    skipped: "bg-muted text-muted-foreground border-border",
    importing: "bg-teal-100 text-teal-900 border-teal-200",
    pending: "bg-muted text-muted-foreground/70 border-border",
  };
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold", map[status] ?? map.pending)}>
      {status === "importing" ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
      {ITEM_STATUS_LABEL[status] ?? status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — result + claim CTA
// ---------------------------------------------------------------------------

function ResultPanel({
  job,
  onClaim,
  onPreview,
  onStartOver,
  onRetry,
}: {
  job: JobT;
  onClaim: () => void;
  onPreview: () => void;
  onStartOver: () => void;
  onRetry: () => void;
}) {
  const s = job.summary;
  const ok = job.status === "completed";
  const warnings = job.status === "completed_with_warnings";
  const failed = job.status === "failed";
  const failedItems = job.items.filter((i) => i.status === "failed");
  const claimable = Boolean(s.claimToken) && Boolean(job.store);

  return (
    <div className="space-y-5">
      {failed ? (
        <div className="rounded-2xl border border-rose-200 bg-white p-5 shadow-soft sm:p-7" role="alert">
          <h2 className="flex items-center gap-2 text-xl font-extrabold text-rose-900">
            <XCircle className="h-5 w-5 text-rose-600" /> Import failed
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">{job.error?.message ?? "The import pipeline failed."}</p>
          {job.error?.code ? (
            <Badge variant="outline" className="mt-2">
              {job.error.code}
            </Badge>
          ) : null}
          <div className="mt-5 flex flex-wrap gap-2.5">
            <Button onClick={onRetry} className="min-h-[44px] bg-brand-gradient-deep font-bold text-white hover:opacity-90">
              <RefreshCw className="h-4 w-4" /> Retry import
            </Button>
            <Button variant="outline" className="min-h-[44px]" onClick={onStartOver}>
              Start over
            </Button>
          </div>
        </div>
      ) : (
        <div className={cn("rounded-2xl border bg-white p-5 shadow-soft sm:p-7", ok ? "border-emerald-200" : "border-amber-200")} role="status">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className={cn("flex items-center gap-2 text-xl font-extrabold", ok ? "text-emerald-900" : "text-teal-900")}>
              {ok ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <AlertTriangle className="h-5 w-5 text-amber-500" />}
              {ok ? "Your store is generated" : "Generated with warnings"}
            </h2>
            {job.isFixture ? <DemoBadge /> : null}
          </div>

          {job.store ? (
            <div className="mt-4 rounded-xl border bg-muted/40 p-4">
              <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Store</p>
              <p className="mt-1 text-lg font-extrabold text-teal-900">{job.store.name}</p>
              <p className="text-xs text-muted-foreground">
                slug: <code className="rounded bg-muted px-1">{job.store.slug}</code> · status: {job.store.status.replace(/_/g, " ")}
              </p>
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-1.5">
            {typeof s.productsOk === "number" ? (
              <Badge variant="outline" className="tabular-nums">
                Products imported: {s.productsOk}
              </Badge>
            ) : null}
            {typeof s.productsFailed === "number" && s.productsFailed > 0 ? (
              <Badge variant="outline" className="border-rose-200 bg-rose-50 tabular-nums text-rose-800">
                Failed: {s.productsFailed}
              </Badge>
            ) : null}
            {s.shop ? (
              <Badge variant="outline">
                Source shop: {s.shop.name}
                {s.shop.region ? ` (${s.shop.region})` : ""}
              </Badge>
            ) : null}
          </div>

          {/* warnings */}
          {(warnings || s.warnings.length > 0) && (s.warnings.length > 0 || failedItems.length > 0) ? (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 p-4">
              <p className="flex items-center gap-1.5 text-sm font-bold text-amber-900">
                <AlertTriangle className="h-4 w-4" /> Warnings ({s.warnings.length + failedItems.length})
              </p>
              <ul className="mt-2 max-h-40 list-disc space-y-1 overflow-y-auto pl-5 text-xs text-amber-900">
                {s.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
                {failedItems.map((it) => (
                  <li key={it.id}>
                    {it.title ?? it.sourceProductId}: {it.error ?? "failed"}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* CTA row */}
          <div className="mt-5 flex flex-col gap-2.5 sm:flex-row sm:items-center">
            {claimable ? (
              <Button onClick={onClaim} className="min-h-[44px] bg-brand-gradient-deep px-6 font-bold text-white hover:opacity-90">
                <KeyRound className="h-4 w-4" /> Claim this store <ArrowRight className="h-4 w-4" />
              </Button>
            ) : (
              <div className="rounded-xl border bg-muted/50 p-3 text-xs text-muted-foreground">
                This store already has an owner — the claim step was skipped. Re-imports sync the catalogue into the owned store.
              </div>
            )}
            {job.store ? (
              <Button variant="outline" className="min-h-[44px]" onClick={onPreview}>
                <Eye className="h-4 w-4" /> Preview storefront
              </Button>
            ) : null}
            <Button variant="ghost" className="min-h-[44px] text-muted-foreground" onClick={onStartOver}>
              <RefreshCw className="h-4 w-4" /> Start over
            </Button>
          </div>
          {claimable ? (
            <p className="mt-3 text-[11px] text-muted-foreground">
              Preview note: unclaimed stores are only visible to you — the public storefront (with checkout) unlocks after you
              claim and publish.
            </p>
          ) : null}
        </div>
      )}

      {/* claim flow */}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — claim flow (panels: verify → account → bind → success)
// ---------------------------------------------------------------------------

type ClaimPanel = "verify" | "account" | "bind";

function ClaimFlow({
  job,
  initialClaimCode,
  onBack,
  onClaimed,
  onSellerPortal,
}: {
  job: JobT;
  initialClaimCode: string;
  onBack?: () => void;
  onClaimed: (r: BindResult) => void;
  onSellerPortal: () => void;
}) {
  const [panel, setPanel] = useState<ClaimPanel>("verify");
  const [claimCode, setClaimCode] = useState(initialClaimCode || (job.isFixture ? "" : ""));
  const [me, setMe] = useState<SellerT | null>(null);
  const [meLoading, setMeLoading] = useState(true);

  const [mode, setMode] = useState<"register" | "login">("register");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authCode, setAuthCode] = useState<string | null>(null);

  const [bindBusy, setBindBusy] = useState(false);
  const [bindError, setBindError] = useState<{ code: string; message: string } | null>(null);

  const method = job.summary.claimMethod ?? (job.isFixture ? "claim_code" : "pending");
  const isDemoClaim = method === "claim_code";

  // detect an existing seller session ("Continue as …")
  useEffect(() => {
    let alive = true;
    fetchJson<AuthResult>("/api/auth/me")
      .then((d) => {
        if (alive && d.userType === "seller" && d.seller) setMe(d.seller);
      })
      .catch(() => undefined)
      .finally(() => alive && setMeLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const bind = useCallback(async () => {
    setBindBusy(true);
    setBindError(null);
    try {
      const r = await postJson<BindResult>("/api/claim/bind", {
        jobId: job.id,
        claimToken: claimCode,
        method,
        evidence: {},
      });
      toast.success("Store claimed!");
      onClaimed(r);
    } catch (e) {
      setBindError({
        code: e instanceof ApiFail ? e.code : "ERROR",
        message: e instanceof Error ? e.message : "Claim failed.",
      });
    } finally {
      setBindBusy(false);
    }
  }, [job.id, claimCode, method, onClaimed]);

  async function submitAccount() {
    setAuthBusy(true);
    setAuthError(null);
    setAuthCode(null);
    try {
      if (mode === "register") {
        if (!fullName.trim()) throw new Error("Your name is required.");
        if (!email.includes("@")) throw new Error("A valid email is required.");
        if (password.length < 8) throw new Error("Password must be at least 8 characters.");
        const res = await postJson<AuthResult>("/api/auth/register", {
          email: email.trim(),
          password,
          fullName: fullName.trim(),
          displayName: fullName.trim(),
        });
        setSessionToken(res?.token);
      } else {
        if (!email.includes("@") || !password) throw new Error("Email and password are required.");
        const res = await postJson<AuthResult>("/api/auth/login", { email: email.trim(), password, portal: "seller" });
        setSessionToken(res?.token);
      }
      setPanel("bind");
      void bind();
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : "Could not sign you in.");
      if (e instanceof ApiFail && e.code === "EMAIL_TAKEN") {
        setAuthCode("An account with this email already exists — switch to “Log in” to continue claiming.");
        setMode("login");
      }
    } finally {
      setAuthBusy(false);
    }
  }

  const storeName = job.store?.name ?? job.summary.shop?.name ?? "your generated store";

  return (
    <div className="rounded-2xl border border-teal-600/20 bg-white p-5 shadow-soft sm:p-7" aria-label="Claim this store">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-xl font-extrabold text-teal-900">
          <ShieldCheck className="h-5 w-5 text-teal-700" /> Claim this store
        </h2>
        {job.isFixture ? <DemoBadge /> : null}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">{storeName}</span>
        {job.store ? (
          <>
            {" "}
            (<code className="rounded bg-muted px-1 text-[11px]">{job.store.slug}</code>)
          </>
        ) : null}{" "}
        is waiting for its owner.
      </p>

      {/* progress dots for the 3 panels */}
      <ol className="mt-4 flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-wide" aria-label="Claim steps">
        {(["verify", "account", "bind"] as ClaimPanel[]).map((p, i) => (
          <li key={p} className="flex items-center gap-2">
            <span
              className={cn(
                "rounded-full px-2.5 py-1",
                panel === p ? "bg-brand-gradient text-white" : i < ["verify", "account", "bind"].indexOf(panel) ? "bg-teal-100 text-teal-800" : "bg-muted text-muted-foreground"
              )}
            >
              {i + 1}. {p === "verify" ? "Verify ownership" : p === "account" ? "Seller account" : "Bind store"}
            </span>
            {i < 2 ? <span className="text-muted-foreground/50">→</span> : null}
          </li>
        ))}
      </ol>

      <Separator className="my-5" />

      {/* ---------- Panel 1 — verify ownership ---------- */}
      {panel === "verify" ? (
        <div>
          <p className="text-sm text-muted-foreground">To claim, verify you own the source shop.</p>
          {isDemoClaim ? (
            <div className="mt-4 space-y-2">
              <Label htmlFor="claim-code" className="text-sm font-semibold">
                Demo claim code
              </Label>
              <Input
                id="claim-code"
                value={claimCode}
                onChange={(e) => setClaimCode(e.target.value)}
                className="min-h-[44px] font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-[11px] text-muted-foreground">
                (Demo store — token-based claim; real marketplaces verify via official account authorisation.)
              </p>
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <p className="text-sm">
                Connect your <span className="font-semibold">{job.platformLabel}</span> account that owns this shop. NOMOFEE
                verifies server-side that the authorised shop matches the imported one.
              </p>
              {job.summary.beginUrl ? (
                <a href={job.summary.beginUrl} target="_blank" rel="noopener noreferrer" className="inline-block">
                  <Button variant="outline" className="min-h-[44px]">
                    <ExternalLink className="h-4 w-4" /> Connect {job.platformLabel}
                  </Button>
                </a>
              ) : (
                <p className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
                  No authorisation link is available yet — connect your {job.platformLabel} account from the seller portal
                  <span className="font-semibold"> Imports</span> page, then continue here.
                </p>
              )}
            </div>
          )}
          <div className="mt-6 flex flex-wrap items-center gap-2.5">
            <Button
              onClick={() => setPanel("account")}
              disabled={isDemoClaim && (!claimCode.trim() || bindBusy)}
              className="min-h-[44px] bg-brand-gradient-deep font-bold text-white hover:opacity-90"
            >
              Continue <ArrowRight className="h-4 w-4" />
            </Button>
            {onBack ? (
              <Button variant="ghost" className="min-h-[44px] text-muted-foreground" onClick={onBack}>
                Back to result
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* ---------- Panel 2 — seller account ---------- */}
      {panel === "account" ? (
        <div>
          <p className="text-sm text-muted-foreground">Create a seller account or log in — the claimed store binds to it.</p>

          {meLoading ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking your session…
            </div>
          ) : me ? (
            <div className="mt-4 rounded-xl border border-teal-600/20 bg-teal-50/60 p-4">
              <p className="text-sm">
                Signed in as <span className="font-bold">{me.displayName}</span>{" "}
                <span className="text-muted-foreground">({me.email})</span>
              </p>
              <div className="mt-3 flex flex-wrap gap-2.5">
                <Button
                  onClick={() => {
                    setPanel("bind");
                    void bind();
                  }}
                  disabled={bindBusy}
                  className="min-h-[44px] bg-brand-gradient-deep font-bold text-white hover:opacity-90"
                >
                  {bindBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  Continue as {me.displayName}
                </Button>
                <Button variant="outline" className="min-h-[44px]" onClick={() => setMe(null)}>
                  Use a different account
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-4">
              <Tabs value={mode} onValueChange={(v) => setMode(v === "login" ? "login" : "register")}>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="register" className="min-h-[44px] gap-1.5">
                    <UserPlus className="h-4 w-4" /> Create account
                  </TabsTrigger>
                  <TabsTrigger value="login" className="min-h-[44px] gap-1.5">
                    <LogIn className="h-4 w-4" /> Log in
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              <div className="mt-4 space-y-3.5">
                {mode === "register" ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="claim-name">Full name</Label>
                    <Input
                      id="claim-name"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="e.g. Aurora Test"
                      autoComplete="name"
                      className="min-h-[44px]"
                    />
                  </div>
                ) : null}
                <div className="space-y-1.5">
                  <Label htmlFor="claim-email">Email</Label>
                  <Input
                    id="claim-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    className="min-h-[44px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="claim-password">Password</Label>
                  <Input
                    id="claim-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === "register" ? "At least 8 characters" : "Your password"}
                    autoComplete={mode === "register" ? "new-password" : "current-password"}
                    className="min-h-[44px]"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !authBusy) void submitAccount();
                    }}
                  />
                </div>

                {authError || authCode ? (
                  <Alert variant={authError ? "destructive" : "default"} className={cn(!authError && "border-teal-600/30 bg-teal-50/60")}>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>{authError ? "Couldn&apos;t continue" : "Heads up"}</AlertTitle>
                    <AlertDescription>{authError ?? authCode}</AlertDescription>
                  </Alert>
                ) : null}

                <Button
                  onClick={() => void submitAccount()}
                  disabled={authBusy}
                  className="min-h-[44px] w-full bg-brand-gradient-deep font-bold text-white hover:opacity-90"
                >
                  {authBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : mode === "register" ? <UserPlus className="h-4 w-4" /> : <LogIn className="h-4 w-4" />}
                  {authBusy ? "Please wait…" : mode === "register" ? "Create account & claim" : "Log in & claim"}
                </Button>
              </div>
            </div>
          )}

          {onBack ? (
            <Button variant="ghost" className="mt-4 min-h-[44px] text-muted-foreground" onClick={() => setPanel("verify")}>
              Back to verification
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* ---------- Panel 3 — bind ---------- */}
      {panel === "bind" ? (
        <div role="status" aria-live="polite">
          {bindBusy ? (
            <div className="flex items-center gap-3 py-4">
              <Loader2 className="h-5 w-5 animate-spin text-teal-700" />
              <div>
                <p className="text-sm font-semibold">Binding the store to your account…</p>
                <p className="text-xs text-muted-foreground">Verifying the claim token and transferring ownership.</p>
              </div>
            </div>
          ) : bindError ? (
            <div>
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Claim failed ({bindError.code})</AlertTitle>
                <AlertDescription>{bindError.message}</AlertDescription>
              </Alert>
              <div className="mt-4 flex flex-wrap gap-2.5">
                <Button
                  onClick={() => {
                    setPanel(isDemoClaim ? "verify" : "account");
                    setBindError(null);
                  }}
                  variant="outline"
                  className="min-h-[44px]"
                >
                  <RefreshCw className="h-4 w-4" /> Try again
                </Button>
                {onBack ? (
                  <Button variant="ghost" className="min-h-[44px] text-muted-foreground" onClick={onBack}>
                    Back to result
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Preparing…
            </div>
          )}
        </div>
      ) : null}

    </div>
  );
}

// ---------------------------------------------------------------------------
// ClaimView — deep-link landing (?claim_job=…&claim_token=…)
// ---------------------------------------------------------------------------

export function ClaimView({ jobId, token, onExit }: { jobId: string; token: string; onExit?: () => void }) {
  const setSurface = useApp((s) => s.setSurface);
  const refreshMe = useApp((s) => s.refreshMe);
  const [job, setJob] = useState<JobT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<BindResult | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchJson<JobT>(`/api/import/jobs/${encodeURIComponent(jobId)}?token=${encodeURIComponent(token)}`)
      .then((j) => alive && setJob(j))
      .catch((e) => alive && setError(e instanceof Error ? e.message : "This claim link could not be opened."));
    return () => {
      alive = false;
    };
  }, [jobId, token]);

  const notReady = useMemo(
    () => job && !TERMINAL_STATUSES.includes(job.status) && !job.summary.claimToken,
    [job]
  );

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-14">
      {claimed ? (
        <div className="rounded-2xl border border-emerald-200 bg-white p-8 text-center shadow-soft">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100">
            <CheckCircle2 className="h-9 w-9 text-emerald-600" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-teal-900">Store claimed!</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">{claimed.store.name}</span> ({claimed.store.slug}) is now bound to
            your seller account.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{claimed.nextStep}</p>
          <Button
            onClick={() =>
              void (async () => {
                setPortalBusy(true);
                try {
                  await refreshMe();
                } catch {
                  /* best-effort */
                }
                setSurface("seller");
              })()
            }
            disabled={portalBusy}
            className="mt-6 min-h-[44px] bg-brand-gradient-deep font-bold text-white hover:opacity-90"
          >
            {portalBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Rocket className="h-4 w-4" aria-hidden="true" />}
            Open seller command centre <ArrowRight className="h-4 w-4" />
          </Button>
          {onExit ? (
            <div className="mt-3">
              <Button variant="ghost" className="min-h-[44px] text-muted-foreground" onClick={onExit}>
                Back to the marketplace
              </Button>
            </div>
          ) : null}
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-rose-200 bg-white p-6 shadow-soft" role="alert">
          <h1 className="flex items-center gap-2 text-lg font-extrabold text-rose-900">
            <XCircle className="h-5 w-5 text-rose-600" /> Claim link unavailable
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          {onExit ? (
            <Button variant="outline" className="mt-4 min-h-[44px]" onClick={onExit}>
              Back to the marketplace
            </Button>
          ) : null}
        </div>
      ) : !job ? (
        <div className="rounded-2xl border bg-white p-6 shadow-soft" role="status" aria-live="polite">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-teal-700" />
            <p className="text-sm text-muted-foreground">Opening your claim link…</p>
          </div>
          <div className="mt-5 space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-10 rounded-lg bg-muted" />
            ))}
          </div>
        </div>
      ) : notReady ? (
        <div className="rounded-2xl border border-amber-200 bg-white p-6 shadow-soft" role="status">
          <h1 className="flex items-center gap-2 text-lg font-extrabold text-amber-900">
            <AlertTriangle className="h-5 w-5 text-amber-500" /> Store not ready yet
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This import job is still <span className="font-semibold">{job.status.replace(/_/g, " ")}</span> — a claim link is
            issued once the store finishes generating. Reopen this link in a moment.
          </p>
          {onExit ? (
            <Button variant="outline" className="mt-4 min-h-[44px]" onClick={onExit}>
              Back to the marketplace
            </Button>
          ) : null}
        </div>
      ) : job ? (
        <ClaimFlow
          job={job}
          // NOTE: the deep-link token is the job TRACKING token (used to fetch the
          // job). The demo claim CODE comes from the job summary — never assume
          // they are the same value.
          initialClaimCode={job.summary.claimToken ?? ""}
          onBack={undefined}
          onClaimed={(r) => setClaimed(r)}
          onSellerPortal={() => setSurface("seller")}
          />
      ) : null}
    </div>
  );
}
