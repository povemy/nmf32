# CI Activation Runbook (Task 22 / R6)

The verification workflow (`.github/workflows/ci.yml`) is **complete and valid** but
cannot self-activate inside this sandbox: the sandbox git repo has **no hosting
remote and no runner**. Activation is therefore a deployment-time step. This
runbook covers every way to turn it on, in order of preference.

## What the workflow proves (gates)

| Step | Command | Gate |
|---|---|---|
| Lint | `bun run lint` | ESLint 9 over the whole repo — hard gate |
| Financial unit tests | `bun scripts/fin-tests.ts` | 78 pure money-math tests (Int sen + Int bps), no DB — hard gate |
| Financial reconciliation | `bun scripts/fin-reconcile.ts` | 26 read-only invariant checks against a freshly seeded throwaway DB — hard gate |
| Type check | `bunx tsc --noEmit` | INFORMATIONAL only (`continue-on-error: true`) — tracked ~31-error pre-existing baseline, fixed separately |

Deliberately not run: `bun run build` (build gate is bypassed by
`next.config.ts → typescript.ignoreBuildErrors`; type coverage comes from the
tsc step). The job needs **zero secrets** — `DATABASE_URL` is synthesized to an
absolute throwaway SQLite path inside the runner workspace.

## Option A — GitHub-hosted runner (recommended, zero infrastructure)

1. Push this repository to a GitHub remote
   (`git remote add origin <url> && git push -u origin main`).
2. Nothing else. `on: push / pull_request / workflow_dispatch` means the very
   first push runs the workflow; the **Actions tab** shows the run.
3. Branch protection (recommended hardening, repo Settings → Branches):
   require the `verify` job's checks (`Lint`, `Financial unit tests (78, no
   DB)`, `Financial reconciliation (26 checks, seeded DB)`) to pass before
   merge, and require branches to be up to date.
4. Manual runs: Actions → CI → **Run workflow** (the `workflow_dispatch`
   trigger), choose the branch.

Runner cost: ubuntu-latest minutes; the job takes ~2–3 minutes
(install + prisma generate + db push + seed + 3 gates).

## Option B — Self-hosted runner (data stays on your hardware)

1. Repo Settings → Actions → Runners → **New self-hosted runner**; follow the
   token'd registration script on the host (Linux x64).
2. On the runner host install **bun** (`curl -fsSL https://bun.sh/install | bash`)
   and ensure it is on PATH for the runner service account.
3. Change `runs-on: ubuntu-latest` → `runs-on: self-hosted` in ci.yml (one
   line) — or add a labelled pool and use that label.
4. Re-run the workflow via `workflow_dispatch` to prove the label resolves.
5. Hygiene for self-hosters: run the runner as a non-interactive service user,
   keep the workspace on an ephemeral disk (the job writes a throwaway
   `db/custom.db` into the workspace each run), and do not expose the runner
   to the public internet (GitHub docs: self-hosted runners on public repos
   are dangerous — use a private repo or GitHub-hosted runners).

## Option C — Non-GitHub CI (GitLab/Jenkins/Gitea Actions)

The three gate commands are plain shell — port the step list verbatim:

```bash
bun install --frozen-lockfile
bunx prisma generate
DATABASE_URL="file:$PWD/db/custom.db" bunx prisma db push --accept-data-loss
bun prisma/seed.ts
bun run lint && bun scripts/fin-tests.ts && bun scripts/fin-reconcile.ts
```

(`DATABASE_URL` must be an ABSOLUTE `file:` URL — Prisma resolves relative
URLs against `prisma/`, not the workspace root; the workflow comment explains
this.)

## Validation performed in the sandbox (2026-10-18)

- YAML parses cleanly (`python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"`).
- Every gate command was executed in this workspace with the same inputs the
  runner would use: `bun run lint` (clean), `bun scripts/fin-tests.ts`
  (78/78), `bun scripts/fin-reconcile.ts` (26/26 against a seeded DB),
  `bunx tsc --noEmit` (informational, 31 pre-existing baseline errors).
- What could NOT be validated here: the actual runner execution (no remote,
  no runner). First push should start with a `workflow_dispatch` run and a
  green run before enabling branch protection.

## Failure triage quick list

- **Install fails on `--frozen-lockfile`** → `bun.lock` is out of date;
  regenerate locally (`bun install`) and commit it.
- **Seed fails** → `prisma/seed.ts` wipes + reseeds the throwaway DB; a
  failure here is a data-model/seed bug, not CI plumbing.
- **Reconcile fails only on CI, not locally** → the CI database is FRESHLY
  seeded; local runs may carry E2E rows (e.g. hold-override test orders)
  tolerated by section N's noted exceptions — align by running the suite
  against a fresh `db push` + seed locally.
- **tsc step red** → expected/informational while the ~31-error baseline
  exists; do not gate merges on it until the baseline cleanup task lands.
