import type { NextConfig } from "next";

// ============================================================================
// Phase 2.3 (P2.3-6) — security response headers.
// ----------------------------------------------------------------------------
// LAYER CHOICE: every header below is set HERE (next.config.ts headers()),
// NOT in the Caddyfile. Reasons:
//   • next.config headers() apply to ALL responses this app emits — HTML
//     pages, /_next/static assets, and /api/* JSON — regardless of which
//     proxy fronts us, so the policy travels with the app.
//   • The Caddyfile in this repo listens on :81 in PLAIN HTTP (no tls
//     directive) — it is not the TLS terminator. In the sandbox TLS is
//     terminated upstream at the platform edge, which this repo cannot
//     configure; in a self-hosted deployment Caddy would gain a TLS site
//     block (a commented template is left in the Caddyfile). Setting the
//     headers at the app layer means exactly ONE authoritative source and
//     zero duplicate/conflicting values if the edge changes.
//   • Browsers ignore HSTS delivered over plain HTTP, so emitting it from
//     the app is safe even for the http://127.0.0.1:3000 dev surface — it
//     only takes effect behind the TLS-terminating edge.
// ============================================================================

const isProd = process.env.NODE_ENV === "production";

// --- Content-Security-Policy ------------------------------------------------
// ENFORCED (not report-only) but deliberately conservative so the documented
// app architecture keeps working:
//   • script-src 'unsafe-inline' — Next.js App Router streams its bootstrap
//     payload as INLINE <script> chunks (self.__next_f.push(...)) on every
//     page; without 'unsafe-inline' the app renders blank. In dev only,
//     'unsafe-eval' is added for React Refresh / HMR (Next.js docs: dev mode
//     requires it; production React never evaluates).
//   • style-src 'unsafe-inline' — Tailwind ships as a compiled stylesheet,
//     but Radix/shadcn position popovers/dialogs via inline style=""
//     attributes (verified across src/components), and storefront/builder
//     render computed inline heights/radii.
//   • img-src https: — marketplace product images and avatars are arbitrary
//     external https hosts persisted by the import pipeline; data: covers
//     inline SVG placeholders, blob: covers local File/preview objects
//     (delivery proof, shipment labels, CSV/receipt downloads).
//   • connect-src ws:/wss: — the chat hub is a socket.io websocket that
//     connects SAME-ORIGIN via /?XTransformPort=3003 (Caddy re-forwards it),
//     i.e. wss://<public-origin>; older CSP implementations do not match
//     ws/wss schemes against 'self', so they are listed explicitly. ws: also
//     covers the dev HMR socket (ws://localhost:3000).
//   • NO frame-ancestors / X-Frame-Options (DELIBERATE — see comment at the
//     header list below): this app is DESIGNED to be embeddable by the
//     platform's cross-site preview panel (session-client.ts Bearer bridge,
//     SameSite=None cookie posture in lib/auth.ts + api/cart/cart.ts). A
//     frame-ancestors 'self' (or X-Frame-Options SAMEORIGIN) would make the
//     preview panel render a blank frame — verified against every "iframe"
//     mention in src/: the app renders ZERO <iframe> elements itself (only
//     sanitizer regexes that STRIP iframes from imported HTML); it is always
//     the EMBEDDEE, never the embedder.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' ws: wss:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-src 'self' blob:",
].join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Verified unused across src/ (no getUserMedia / geolocation / mediaDevices):
  // nothing regresses by disabling these capabilities at the policy level.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy", value: csp },
  // HSTS — meaningful ONLY behind TLS. The repo Caddyfile proxies plain HTTP
  // (:81); TLS is terminated by the fronting edge (sandbox platform edge, or
  // a future Caddy tls site block — see the comment template in the Caddyfile).
  // Browsers ignore this header over plain HTTP, so the dev surface is
  // unaffected; behind https it pins the origin for one year. includeSubDomains
  // and preload are intentionally omitted: the public origin shares host
  // infrastructure with other platform surfaces we do not control.
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  // NOTE (documented decision): X-Frame-Options / CSP frame-ancestors are
  // intentionally NOT set. The platform preview panel embeds this app as a
  // cross-site iframe (that is why sessions have a localStorage Bearer bridge
  // and cookies use SameSite=None — see src/lib/session-client.ts,
  // src/lib/auth.ts, src/app/api/cart/cart.ts). Locking framing to 'self'
  // would break the mandated preview. Clickjacking exposure is mitigated
  // operationally: every state-changing /api/* request must pass the F-01
  // origin gate (src/proxy.ts: Bearer / X-SM-Client marker / Sec-Fetch-Site
  // evidence), so a hidden-frame "clickjack" cannot issue authenticated
  // mutations it isn't already able to issue as a plain cross-site page.
  // FUTURE HARDENING: once the embedder origin is a known deployment
  // parameter, add `frame-ancestors 'self' https://<embedder-origin>`.
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Type-safety gate: production builds FAIL on type errors instead of
  // silently ignoring them. The build's type program is scoped to
  // tsconfig.ci.json (src/ + next.config + generated .next/types) — the SAME
  // scope as the CI typecheck gate, so the two gates can never disagree, and
  // the pre-existing out-of-src tsc baseline (tool-results/, scripts/,
  // examples/) cannot fail the build (see .github/workflows/ci.yml header).
  // Phase 2 final remediation (W-1): paired with the removal of the CI build
  // step's continue-on-error flag. ignoreBuildErrors stays false — errors
  // WITHIN src/ still hard-fail the build.
  typescript: {
    ignoreBuildErrors: false,
    tsconfigPath: "./tsconfig.ci.json",
  },
  reactStrictMode: false,
  async headers() {
    // Applies to pages, static assets AND /api/* responses (harmless for JSON,
    // and keeps a single source of truth — the Caddyfile adds none of these).
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
