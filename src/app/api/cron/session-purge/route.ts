import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { toJson } from "@/lib/json";
import { assertCronAuth } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

// ============================================================================
// Phase 1 (C3 / F-32) — expired-session purge (cron tick).
// ----------------------------------------------------------------------------
// Before this route, Session rows were only deleted on logout / revocation —
// expired rows accumulated forever (unbounded table growth). This bounded job:
//   • deletes ONLY rows with expiresAt < now — an ACTIVE session can never
//     match, so authentication, expiry checks and revocation are untouched
//     (revocation deletes by principal; purge deletes by time — disjoint).
//   • is idempotent and safe to run concurrently (deleteMany is set-based).
//   • throttles to at most one purge per 10 minutes per process (the scheduler
//     ticks every 30 s — the route answers {throttled:true} in between).
//   • records its outcome in Setting `cron.session_purge.last` for ops.
// FINAL CLOSURE: the same tick now also sweeps EXPIRED EmailOtpChallenge rows
// (purpose "guest-order" — TTL-bounded garbage after 10 minutes). Rows with
// verifiedAt set are KEPT: they are the durable email-ownership proofs that
// gate guest-order claiming. P2021-tolerant: a missing table sweeps 0.
// AUTH: assertCronAuth — fail-closed in production without CRON_SECRET.
// Scheduled by mini-services/expiry-scheduler ("sessions" job).
// ============================================================================
const PURGE_THROTTLE_MS = 10 * 60 * 1000;

export const POST = handle(async (req: Request) => {
  const auth = assertCronAuth(req);
  const g = globalThis as Record<string, unknown>;
  const last = typeof g.__sessionPurgeAt === "number" ? (g.__sessionPurgeAt as number) : 0;
  const now = Date.now();
  if (now - last < PURGE_THROTTLE_MS) {
    return ok({ throttled: true, purged: 0, auth: auth.mode });
  }
  g.__sessionPurgeAt = now;

  const t0 = performance.now();
  // Set-based delete of EXPIRED rows only — never an active session.
  const res = await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  // FINAL CLOSURE: expired guest-order OTP challenges are garbage after their
  // 10-minute TTL (successful ones are already deleted at consume-time).
  // Verified shopper-email rows survive — they are the claiming proofs.
  let otpPurged = 0;
  try {
    const otp = await db.emailOtpChallenge.deleteMany({
      where: { verifiedAt: null, expiresAt: { lt: new Date() } },
    });
    otpPurged = otp.count;
  } catch {
    // Migration 20261104000000 not applied yet — nothing to sweep.
    otpPurged = 0;
  }
  const outcome = {
    purged: res.count,
    otpChallengesPurged: otpPurged,
    durationMs: Math.round(performance.now() - t0),
    at: new Date().toISOString(),
    auth: auth.mode,
  };

  await db.setting.upsert({
    where: { key: "cron.session_purge.last" },
    create: { key: "cron.session_purge.last", valueJson: toJson(outcome), description: "Last expired-session purge outcome (Phase 1 C3)" },
    update: { valueJson: toJson(outcome) },
  });

  return ok(outcome);
});

// GET — observability without triggering a purge.
export const GET = handle(async (req: Request) => {
  const auth = assertCronAuth(req);
  const [expiredBacklog, lastSetting] = await Promise.all([
    db.session.count({ where: { expiresAt: { lt: new Date() } } }),
    db.setting.findUnique({ where: { key: "cron.session_purge.last" } }),
  ]);
  return ok({
    expiredBacklog,
    lastRun: lastSetting ? JSON.parse(lastSetting.valueJson) : null,
    auth: auth.mode,
  });
});
