/**
 * instrumentation-node.ts — Node-runtime vault loader for NOMOFEE.
 *
 * ONLY imported dynamically from src/instrumentation.ts when
 * NEXT_RUNTIME === "nodejs" — never bundled for the Edge Runtime.
 *
 * Why this exists: this sandbox's harness resets `.env` to a stale
 * 50-byte SQLite-only file on session restarts, which removes
 * SUPABASE_DATABASE_URL and crashes Prisma (P1012). If those variables
 * are missing at server boot, this guard reloads them from the durable
 * vault so the server always starts with credentials — even when Next.js
 * is started directly (bypassing scripts/ensure-env.ts) or when a
 * mid-session `.env` reset triggers a Turbopack reload.
 *
 * Vault priority:
 *   1. $NOMOFEE_ENV_VAULT       — optional explicit override
 *   2. upload/.env.vault        — ossfs mount, survives sandbox resets/rsync
 *   3. /tmp/nomofee-env/.env    — tmp snapshot
 *   4. /tmp/my-project/.env     — legacy tmp snapshot
 *
 * Rules:
 *  - NEVER overrides a variable already present in process.env
 *    (explicit environment always wins).
 *  - NEVER logs secret values — only key names and vault paths.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REQUIRED = [
  "SUPABASE_DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

export async function registerNodeEnvGuard(): Promise<void> {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length === 0) return;

  console.warn(
    `[instrumentation] env guard: missing at boot: ${missing.join(", ")} — loading from vault`,
  );

  const candidates = [
    process.env.NOMOFEE_ENV_VAULT, // optional explicit override
    join(process.cwd(), "upload", ".env.vault"), // durable ossfs mount
    "/tmp/nomofee-env/.env",
    "/tmp/my-project/.env",
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const vault of candidates) {
    if (!existsSync(vault)) continue;

    let loaded = 0;
    try {
      const text = readFileSync(vault, "utf8");
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const m = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        const key = m[1];
        if (process.env[key] !== undefined) continue; // never override explicit env
        let value = m[2].trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        process.env[key] = value;
        loaded++;
      }
    } catch {
      continue; // unreadable vault — try next candidate
    }

    if (loaded > 0) {
      console.log(`[instrumentation] env guard: ${loaded} var(s) loaded from ${vault}`);
    }

    const stillMissing = REQUIRED.filter((k) => !process.env[k]);
    if (stillMissing.length === 0) return;
    if (loaded > 0) {
      console.error(
        `[instrumentation] vault ${vault} lacked: ${stillMissing.join(", ")} — trying next`,
      );
    }
  }

  console.error(
    `[instrumentation] env guard FATAL: SUPABASE_* credentials unavailable at boot ` +
      `(checked vaults: ${candidates.join(", ")}). Database-backed routes will fail.`,
  );
}

/**
 * F-04/F-23 remediation → P2.3-7 (Phase 2.3 audit: "production boot should
 * FAIL CLEARLY when mandatory secrets are missing", not just warn):
 *
 *  MANDATORY (boot-fatal in production — these guard money/security surfaces
 *  and every one of them previously only WARNED while its endpoint failed
 *  closed per-request): PSP_WEBHOOK_SECRET, CRON_SECRET, MFA_ENCRYPTION_KEY,
 *  IMPORT_TOKEN_ENC_KEY, ORDER_ACCESS_SECRET, EMAIL_OTP_SECRET, plus the
 *  EMAIL_PROVIDER block (guest checkout + claiming REQUIRE transactional
 *  email — email is not a pre-launch optional). A missing entry THROWS from
 *  register() → the Next.js server boot aborts with a clear, actionable
 *  error listing every missing variable.
 *
 *  WARN-only (legitimately optional / degraded-mode surfaces): every one of
 *  these fails closed at its own endpoint when unset, but a deploy may
 *  deliberately run without them (read-only metrics disabled, chat relay
 *  down, shipping webhooks pending integration, import caps dev-only …).
 *
 *  Dev/sandbox: completely permissive (documented fallbacks keep the mock
 *  rails working — the running dev server never hits this branch).
 */
const PRODUCTION_MANDATORY_SECRETS = [
  { key: "PSP_WEBHOOK_SECRET", why: "HMAC signing for POST /api/webhooks/payments/[provider] — money events" },
  { key: "CRON_SECRET", why: "timing-safe auth for POST /api/cron/* (scheduler ticks) + GET /api/health/scheduler" },
  { key: "MFA_ENCRYPTION_KEY", why: "AES-GCM at-rest key for admin TOTP secrets (503 MFA_NOT_CONFIGURED without it)" },
  { key: "IMPORT_TOKEN_ENC_KEY", why: "AES-GCM key for marketplace OAuth token storage (503 SECRETBOX_NOT_CONFIGURED without it)" },
  { key: "ORDER_ACCESS_SECRET", why: "HMAC key for guest order-access grants on lookup/receipt" },
  { key: "EMAIL_OTP_SECRET", why: "HMAC key for email-OTP challenges (guest checkout + claiming)" },
] as const;

/** Provider-block validation: transactional email is REQUIRED in production
 *  (guest-order OTP + shopper email verification + claiming depend on it).
 *  Returns the fatal problem description, or null when configured correctly. */
function emailProviderProblem(env: NodeJS.ProcessEnv): string | null {
  const provider = (env.EMAIL_PROVIDER ?? "").trim().toLowerCase();
  if (!provider) {
    return "EMAIL_PROVIDER is not set — transactional email is REQUIRED in production (guest-order OTP, shopper email verification, order claiming). Configure a provider (see .env.example).";
  }
  if (provider === "resend") {
    if (!(env.RESEND_API_KEY ?? "").trim()) return "EMAIL_PROVIDER=resend requires RESEND_API_KEY (sending-access key from the Resend dashboard).";
    if (!(env.EMAIL_FROM ?? "").trim()) return "EMAIL_PROVIDER=resend requires EMAIL_FROM (verified sender identity).";
    return null;
  }
  if (provider === "mailpit") {
    return "EMAIL_PROVIDER=mailpit is a DEV-ONLY catcher (ignored in production). Select a production provider: EMAIL_PROVIDER=resend.";
  }
  return `EMAIL_PROVIDER="${provider}" has no adapter compiled in (implemented: resend, mailpit-dev-only). Email delivery would fail closed.`;
}

// NOT boot-fatal, but each one silently DOWNGRADES or disables a surface —
// surfaced loudly at boot so an operator cannot miss it.
const PRODUCTION_WARN_SECRETS = [
  { key: "SHIPPING_WEBHOOK_SECRET", note: "POST /api/shipping/webhook/[provider] (AWB state transitions) will FAIL CLOSED (503) until set" },
  { key: "CHAT_RELAY_SECRET", note: "chat relay :3103 /broadcast (room broadcasts) rejects every call (401) until set" },
  { key: "METRICS_TOKEN", note: "GET /api/metrics stays disabled (503) until set — monitoring honesty: no token, no metrics" },
  { key: "IMPORT_CAP_SECRET", note: "import job-creation caps fail closed (503 IMPORT_CAP_SECRET_UNSET) until set" },
  { key: "RESEND_WEBHOOK_SECRET", note: "POST /api/webhooks/email/resend (delivery events + suppression sync) fails closed (503) until set" },
] as const;

function isSet(v: string | undefined): boolean {
  return typeof v === "string" && v.trim() !== "";
}

/** Production boot gate. THROWS on missing mandatory secrets (P2.3-7);
 *  prints loud warnings for the degraded-mode ones. No-op outside production. */
export function enforceProductionSecrets(): void {
  if (process.env.NODE_ENV !== "production") return;

  const fatal: string[] = [];
  for (const s of PRODUCTION_MANDATORY_SECRETS) {
    if (!isSet(process.env[s.key])) fatal.push(`${s.key} — ${s.why}`);
  }
  const providerProblem = emailProviderProblem(process.env);
  if (providerProblem) fatal.push(providerProblem);
  if (fatal.length > 0) {
    throw new Error(
      `[instrumentation] FATAL: production boot aborted — mandatory secrets missing:\n` +
        fatal.map((f) => `  - ${f}`).join("\n") +
        `\n  Set them in the deployment environment (see .env.example — every key is documented there). ` +
        `Refusing to start with money/security surfaces unconfigured (Phase 2.3 audit: boot must fail clearly).`,
    );
  }

  for (const s of PRODUCTION_WARN_SECRETS) {
    if (!isSet(process.env[s.key])) {
      console.error(`[instrumentation] SECURITY: ${s.key} is NOT SET — ${s.note}.`);
    }
  }
}

/** Kept for external symmetry/tests: the loud boot reporter (non-throwing
 *  view of the same checks). Prefer enforceProductionSecrets() at boot. */
export function warnProductionSecrets(): void {
  if (process.env.NODE_ENV !== "production") return;
  const missing = PRODUCTION_MANDATORY_SECRETS.filter((s) => !isSet(process.env[s.key]));
  for (const s of missing) {
    console.error(
      `[instrumentation] SECURITY: ${s.key} is NOT SET — ${s.why} — BOOT WILL FAIL (see enforceProductionSecrets).`,
    );
  }
  const providerProblem = emailProviderProblem(process.env);
  if (providerProblem) console.error(`[instrumentation] SECURITY: ${providerProblem} — BOOT WILL FAIL.`);
  for (const s of PRODUCTION_WARN_SECRETS) {
    if (!isSet(process.env[s.key])) {
      console.error(`[instrumentation] SECURITY: ${s.key} is NOT SET — ${s.note}.`);
    }
  }
}
