import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Type-safety gate: the repo is tsc-clean (2026-10-27 — all 53 pre-existing
  // errors fixed, `bunx tsc --noEmit` = 0 errors). Production builds now FAIL
  // on type errors instead of silently ignoring them; CI re-checks the same
  // gate (.github/workflows/ci.yml).
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
};

export default nextConfig;
