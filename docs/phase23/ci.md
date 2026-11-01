# CI workflow (Phase 2.3 — P2.3-7)

`.github/workflows/ci.yml` exists now — the Phase 2.3 audit found the workflow
**referenced but missing** (`docs/ops/ci-activation.md` describes a complete
`.github/workflows/ci.yml` that was never in the tree). Activation (GitHub
remote / self-hosted runner / non-GitHub CI port) is still covered by that
runbook. This file documents the workflow's **current scope decisions**.

## Gates

| Step | Command | Status on current tree |
|---|---|---|
| Install | `bun install --frozen-lockfile` | green |
| Prisma schema | `bunx prisma validate` | green (no DB needed) |
| Prisma client | `bunx prisma generate` | green (no DB needed) |
| Typecheck | `bunx tsc --noEmit -p tsconfig.ci.json` | green — **scoped to `src/`** |
| Lint | `bunx eslint src --max-warnings 50` | green (0 errors / 39 warnings baseline) |
| Build | `bun run build` | **needs-verification**, `continue-on-error` (see below) |

## Scope limitations (deliberate, all temporary)

- **Typecheck is scoped to `src/`** via `tsconfig.ci.json` (a separate config —
  the root `tsconfig.json` is untouched so dev-server/editor behavior cannot
  change). Full-repo `tsc --noEmit` carries a ~630-error pre-existing baseline
  in `tool-results/` (484), `scripts/` (145) and `examples/` (1); `src/` is
  clean (0). TODO: clean the stale scripts (`scripts/fin-tests.ts` already
  fails to import — `src/lib/money.ts` exports moved) and widen the scope.
- **Lint is scoped to `src/`** and the single rule
  `react-hooks/set-state-in-effect` is temporarily off in `eslint.config.mjs`
  (44 pre-existing errors across ~23 legacy admin/seller/shopper components —
  all the setState-in-effect data-fetch pattern; components are change-frozen
  this phase). TODO: migrate those components, remove the rule-off, then run
  `bun run lint` (whole repo) in CI instead.
- **Build step is `continue-on-error`** — `next build` could not be executed in
  the sandbox (it would interfere with the running dev server). Known risk:
  `next.config.ts` sets `typescript.ignoreBuildErrors: false` while the
  full-repo tsc baseline is not excluded from the build's type program, so the
  first real run may fail on the pre-existing baseline (that would be the
  honest outcome — see the step comment in `ci.yml` for the fix order).
- The financial gates from the old runbook (`fin-tests.ts`, `fin-reconcile.ts`)
  are **not** included: the former is stale (broken imports), the latter needs
  a seeded DB. TODO before re-adding.

No secrets: CI uses dummy env values only (documented in the workflow).
