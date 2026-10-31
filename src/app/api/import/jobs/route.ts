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
import { randomToken, safeEqual } from "@/lib/secretbox";
import { hmacSha256Hex } from "@/lib/password";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Import capability (B5) — DELIBERATELY DUPLICATED byte-identically in
// ../resolve/route.ts (a shared src/lib/import-cap.ts is the natural home but
// is outside this task's file scope). Keep both copies in sync.
//
// Cookie:  import_cap = {nonce}.{issuedAtMs}.{hmac}
//   hmac   = hmacSHA256(secret, nonce + "." + issuedAtMs)
// The issuedAtMs is carried in the cookie so the 60-minute age can be verified
// statelessly (a MAC over nonce+timestamp alone could not be re-checked).
//
// Secret: IMPORT_CAP_SECRET, resolved at CALL time. Fail-closed in production —
// 503 IMPORT_CAP_SECRET_UNSET, mirroring the PSP webhook secret pattern in
// api/webhooks/payments/process.ts. Sandbox/dev falls back to the documented
// public demo constant so accountless onboarding works without env setup.
// ---------------------------------------------------------------------------
const CAP_COOKIE = "import_cap";
const CAP_TTL_MS = 60 * 60 * 1000;

function importCapSecret(): string {
  const secret = process.env.IMPORT_CAP_SECRET;
  if (secret && secret.length > 0) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new ApiError(
      503,
      "IMPORT_CAP_SECRET_UNSET",
      "IMPORT_CAP_SECRET is not configured — import capability issuance is disabled (fail closed)"
    );
  }
  return "sm_import_cap_dev";
}

function issueImportCap(): string {
  const secret = importCapSecret();
  const nonce = randomToken(24);
  const issuedAtMs = String(Date.now());
  const mac = hmacSha256Hex(secret, `${nonce}.${issuedAtMs}`);
  return `${nonce}.${issuedAtMs}.${mac}`;
}

function verifyImportCap(raw: string | undefined | null): boolean {
  if (!raw) return false;
  const parts = raw.split(".");
  if (parts.length !== 3) return false;
  const [nonce, issuedAtMs, mac] = parts;
  if (!nonce || !/^\d{1,16}$/.test(issuedAtMs) || !/^[0-9a-f]{64}$/.test(mac)) return false;
  const issuedAt = Number(issuedAtMs);
  const now = Date.now();
  if (issuedAt > now + 60_000) return false; // issued in the future → reject (60s skew tolerance)
  if (now - issuedAt > CAP_TTL_MS) return false; // expired
  let secret: string;
  try {
    secret = importCapSecret();
  } catch {
    return false; // production without the secret → nothing can verify
  }
  return safeEqual(mac, hmacSha256Hex(secret, `${nonce}.${issuedAtMs}`));
}

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
    if (!verifyImportCap(req.cookies.get(CAP_COOKIE)?.value)) {
      return fail(
        403,
        "IMPORT_CAPABILITY_REQUIRED",
        "Resolve the import URL first (POST /api/import/resolve) to obtain an import capability, or sign in as a seller."
      );
    }
  }
  const job = await createImportJob({ inputUrl: body.url, allowFixture: body.allowFixture !== false });
  return ok({
    jobId: job.jobId,
    trackingToken: job.trackingToken,
    status: job.status,
    pollUrl: `/api/import/jobs/${job.jobId}?token=${job.trackingToken}`,
  });
});
