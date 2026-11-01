/**
 * instrumentation.ts — server-boot environment guard for NOMOFEE (entry).
 *
 * Next.js calls `register()` once at server boot (dev AND production),
 * BEFORE any route handler or lib module (including src/lib/db.ts, which
 * instantiates PrismaClient) is imported.
 *
 * IMPORTANT: this file is ALSO compiled for the Edge Runtime, where
 * node:fs / process.cwd() are unavailable. Therefore all Node-only vault
 * loading lives in ./instrumentation-node and is imported ONLY inside the
 * nodejs runtime branch (the pattern recommended by Next.js docs).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerNodeEnvGuard, enforceProductionSecrets } = await import("./instrumentation-node");
  await registerNodeEnvGuard();
  // P2.3-7 (Phase 2.3 audit): production boot now FAILS CLOSED when mandatory
  // secrets are missing (money/security surfaces: PSP webhook signing, cron
  // auth, MFA + token encryption keys, OTP/order-access HMAC keys, email
  // provider). Dev/sandbox stays fully permissive — this call is a no-op
  // outside NODE_ENV=production, so the running dev server is unaffected.
  enforceProductionSecrets();
}
