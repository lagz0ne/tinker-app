# Issue board: slices 1 and 2

Sign up, sign in, make a team, and add an existing user by email.
Team keys are unique. The creator is an admin. Members can read their teams.
Only admins can add people. Members can create and edit issues.
Issue numbers are ENG-1, ENG-2, and so on. A failed save uses no number.
Each execution ID saves once. State, priority, description, and assignee are saved together.
Assignees must be members of the team. Priorities run from 0 (none) to 4 (low); 1 is urgent.
Start sync updates the writer. The multi-user live board is slice 3.

App code is in `src/`. Commands in `cmds/` own the app and its settings.
The registry supplied `tinker/`; it has no trial patches.
No live board, comment, mail worker, digest, or CSV feature is built.
The starter's demo files and tests are kept as trial fixtures.

## Run

From this folder:

```bash
pnpm install
cp .env.example .env
PORT=4327 HOST=127.0.0.1 vp dev
```

The sample values need local Postgres on port 15433 and SMTP on port 11026.
Use your own values in `.env`. `cmds/server.ts` binds each one to a typed tag.
Migrations run at boot. Missing required tags fail start.
The packed Start CLI is kept in `vendor/` so this trial needs no published release.

## Checks

Run one command at a time:

```bash
VITEST_MAX_WORKERS=1 VP_RUN_CONCURRENCY_LIMIT=1 vp build
pnpm exec tsc --noEmit
VITEST_MAX_WORKERS=1 VP_RUN_CONCURRENCY_LIMIT=1 vp test --maxWorkers=1 --no-file-parallelism
node scripts/check-plain.mjs
pnpm exec tinker doctor
node scripts/check-schema.mjs
```

The plain check rejects Drizzle UUID/smallint declarations and the requested Zod pipe declaration.
The trial keeps the schema and logs this Start limit. It does not patch the check.

## Two-user and issue demo

With `vp dev` running and a fresh database:

```bash
node maintain/demo.mjs
```

The script uses `agent-browser` with two fresh Lightpanda sessions.
A signs up and makes ENG. B signs up. A adds B by email.
B sees ENG through sync, then reloads and still sees it.
A makes ENG-1 and ENG-2, sets their states and priorities, and assigns ENG-1 to B.
A reloads and checks the saved values.
The script checks the POST form method and fails on page errors.
`/home/paseo/.codex/AGENTS.md`, under “Browsers,” requires `agent-browser`
and forbids Playwright for page actions.
Use a fresh database before running it again: ENG must be free.

The full spec and limits log live at `/home/paseo/plans/issue-board-spec.md`
and `/home/paseo/plans/issue-board-limits.md` on the trial machine.
