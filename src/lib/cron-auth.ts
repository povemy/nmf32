// ============================================================================
// CRON AUTH — shared guard for scheduler endpoints (mission: final operational
// gaps, Phase 1 req 2/3).
// ----------------------------------------------------------------------------
// WHY THIS EXISTS: /api/cron/expiry-sweep previously accepted requests with a
// plain `!==` string compare and — critically — treated a MISSING CRON_SECRET
// as "unauthenticated access allowed". In production that is fail-OPEN: a
// publicly callable scheduler surface. Contract required by the mission:
//
//   1. If CRON_SECRET is missing in production, the endpoint FAILS CLOSED
//      (503 CRON_NOT_CONFIGURED) instead of becoming publicly callable.
//   2. When a secret is configured, the presented `x-cron-secret` header is
//      compared TIMING-SAFELY (sha256-digest-normalised then
//      crypto.timingSafeEqual — no length leak, no early-exit).
//   3. The secret (or the presented value) is never logged, echoed, or
//      included in any response — failures say only "invalid or missing".
//
// Modes:
//   secret-required — CRON_SECRET set (any NODE_ENV): header must match.
//   fail-closed     — no secret AND (NODE_ENV=production OR CRON_REQUIRE_SECRET=1):
//                     refuse everything until an operator configures the secret.
//                     CRON_REQUIRE_SECRET exists so the fail-closed branch is
//                     TESTABLE in a dev deployment without booting a production
//                     server (scheduler-e2e.ts exercises it).
//   dev-open        — no secret in plain dev: sandbox tests tick the endpoints
//                     directly. This mode exists ONLY outside production.
// ============================================================================
import { createHash, timingSafeEqual } from "node:crypto";
import { ApiError } from "./api";

export const CRON_SECRET_HEADER = "x-cron-secret";

export type CronAuthMode = "secret-required" | "fail-closed" | "dev-open";

/** Pure decision function (unit-testable without a server). */
export function cronAuthMode(env: NodeJS.ProcessEnv = process.env): CronAuthMode {
  if (env.CRON_SECRET) return "secret-required";
  const failClosed = env.NODE_ENV === "production" || env.CRON_REQUIRE_SECRET === "1";
  return failClosed ? "fail-closed" : "dev-open";
}

/** Timing-safe equality for secrets of arbitrary length.
 *  Both sides are sha256-digested first so `timingSafeEqual` always compares
 *  equal-length buffers and neither the length nor an early mismatch leaks. */
export function secretMatches(presented: string, secret: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

/** Guard for scheduler endpoints. Throws ApiError on denial — never logs the
 *  presented value or the secret. Returns the active mode for observability. */
export function assertCronAuth(req: Request): { mode: CronAuthMode } {
  const mode = cronAuthMode();
  if (mode === "fail-closed") {
    throw new ApiError(
      503,
      "CRON_NOT_CONFIGURED",
      "Scheduler endpoints are disabled: CRON_SECRET is not configured (fail-closed). Configure CRON_SECRET to enable scheduled access.",
    );
  }
  if (mode === "secret-required") {
    const presented = req.headers.get(CRON_SECRET_HEADER) ?? "";
    if (!presented || !secretMatches(presented, process.env.CRON_SECRET as string)) {
      // Deliberately identical message for missing and wrong secrets.
      throw new ApiError(403, "CRON_FORBIDDEN", "Invalid or missing scheduler secret");
    }
  }
  return { mode };
}
