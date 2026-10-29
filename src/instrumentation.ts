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
  const { registerNodeEnvGuard, warnProductionSecrets } = await import("./instrumentation-node");
  await registerNodeEnvGuard();
  warnProductionSecrets(); // F-04/F-23: loud boot-time validation (production only)
}
