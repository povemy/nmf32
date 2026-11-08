import { defineConfig } from "@playwright/test";

// ============================================================================
// Playwright — E2E contract-conformance harness.
// ----------------------------------------------------------------------------
// These tests are NOT UI smoke tests: they drive the real shopper surface on
// the live dev server (already running on :3000 — no webServer here, starting
// a second Next.js instance would corrupt the shared dev state), intercept
// every JSON response under /api/, and assert each payload against the
// RUNTIME mirrors of src/lib/types/api-contract.ts in tests/e2e/contract.ts.
//
// workers=1 / fullyParallel=false: one browser at a time against one dev
// server — no rate-limit contention (login, search suggest) and no interleaved
// guest-cart writes. retries=0: a conformance failure must be reported, never
// retried away.
// ============================================================================
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    headless: true,
    screenshot: "only-on-failure",
  },
  outputDir: "tests/e2e/.results",
});
