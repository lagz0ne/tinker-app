#!/usr/bin/env bash
# Run from the worktree root. Each job finishes before the next starts.
set -eu
export VITEST_MAX_WORKERS=1 VP_RUN_CONCURRENCY_LIMIT=1
node packages/start/scripts/check-entry-hmr.mjs apps/start-min
node packages/start/scripts/check-command-build.mjs apps/start-min
node packages/start/scripts/check-built-entry.mjs apps/start-min
node packages/start/scripts/check-entry-errors.mjs apps/start-min
node apps/start-scaffold/maintain/check-entry.mjs
if [[ "${1:-}" == --entry-only ]]; then exit 0; fi
vp check
vp run -r test
node apps/start-scaffold/maintain/check-app.mjs
node apps/start-scaffold/maintain/scaffold-proof.mjs
