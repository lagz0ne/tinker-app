# Loop on Tinker

Date: 2026-10-20. Status: proposed.
Builds on: [start-decompose.md](start-decompose.md), loop T1 to T4.
Decided by: Duke picked "full app".
Duke, 2026-10-20: the port is graph-first;
pure helpers only when the graph needs them.
Start's CLI gaps are fixed first.
Then tinker-loop is rebuilt as a real Tinker app.

## Context

tinker-loop is a plain Node tool today.
It lives in `packages/loop` on `next` at `7321d6c`.
It has 99 tests that run the command as a user would.
T3 (`tinker-loop review`) waits on branch
`loop/t3-review` at `ac35e5d`, with 11 more tests.

Start ships a CLI entry only as an extra on a web app.
A tool with only `cmds/cli.ts` cannot be a Start app today.
The items below fix that first, then port the loop.

Each item gives the problem with evidence,
the precedent we borrow, the change, and what we keep simpler.
Line numbers are on `next` at `7321d6c`
unless a branch is named.

## S1 A CLI-only app

### Problem

- `tinker()` throws when `src/routes` is missing.
  `packages/start/vite.mjs:112`
- `vite.mjs` imports TanStack Start and the React
  plugin at the top, so loading it needs both.
  `packages/start/vite.mjs:6-7`
- `tinker()` always calls TanStack Start.
  `packages/start/vite.mjs:134`
- Router, start, and server entries are required.
  `packages/start/lib/named.mjs:8-10`
  `packages/start/vite.d.mts:10-12`
- React and TanStack are required peers of Start,
  with no `peerDependenciesMeta`.
  `packages/start/package.json`, `peerDependencies`
- `tinker prepare` stops without a server entry,
  then writes a route tree.
  `packages/start/bin/tinker.mjs:100-108`
- Doctor's `routes` check stops the build.
  `packages/start/lib/doctor.mjs:15`, `:21`
- The registry's `base` item copies `main.ts`
  together with the router, server, and start entries,
  and depends on React and TanStack.
  `apps/start-scaffold/registry.json`, item `base`
- The contract says Vite names the server, router,
  and start entries.
  `docs/decisions/start-decompose.md:131-133`

### Precedent

- Go's `cmd/<name>/main.go`:
  a module can hold only commands, no server.
- Cargo: a crate can be only `src/main.rs`.

### Change

- An app is CLI-only when `tinker()` names
  `cliEntry` and no `serverEntry`.
- In a CLI-only app, router, start, and server
  entries are not required.
- `vite.mjs` loads TanStack Start and the React
  plugin only when there is a `serverEntry`.
- React, React DOM, `@tinker/react`, and the two
  TanStack packages become optional peers.
- `tinker()` skips the `src/routes` check.
- `tinker prepare` writes `.tinker/` files
  but no route tree.
- Doctor skips `routes` and the generated
  route checks.
  It keeps imports, style, boundary, and named files.
- `gate:commands` builds and checks the CLI entry,
  as it does today.
- The registry gets a `base-main` item with only
  `tinker/base/main.ts`.
  The web `base` item requires `base-main`.
- The contract at `start-decompose.md:131-133`
  says a CLI-only app names only `cliEntry`.
- The root README's mutation line is fixed:
  tooling's floor is 85, as in
  `packages/start/stryker.config.json:11`.
  `README.md:93` says 75 today.

### Keep simpler

- CLI-only means one role: `cli`.
  No worker without a server for now.
- No new option: a missing `serverEntry` is the switch.

## S2 Ship an app's CLI as a package `bin`

### Problem

- The `tinker` bin knows only
  `prepare`, `doctor`, and `serve`.
  `packages/start/bin/tinker.mjs:128`
- The one CLI example runs through an app script.
  `apps/issue-board/package.json:20`
  `apps/issue-board/maintain/cli.mjs:3-8`
- No pattern lets another app run a built CLI
  with `vp exec`.

### Precedent

- npm's `bin` field: a file with a shebang,
  listed in `files`.
- Go's `go install ./cmd/name`:
  the build makes the command.

### Change

- The app's `package.json` names a bin file
  and lists `bin` and `dist-cli` in `files`.
- The bin file is three lines after the shebang:

  ```js
  #!/usr/bin/env node
  import { runMain } from "@tinker/start/main-host";
  import main from "../dist-cli/cli.js";
  await runMain(main);
  ```

- `build` runs `vp build` with
  `vite.cli.config.ts`.
- A Vite SSR build inlines linked workspace
  packages unless told not to.
  So `vite.cli.config.ts` sets `ssr.external` to
  `@tinker/start` and `@tinker/core`.
  Both are runtime `dependencies` of the tool:
  the bin imports `main-host`, and the app needs Core.
- Other linked workspace packages
  are inlined into `dist-cli`.
  They stay dev dependencies.
- `dist-cli` is built only to publish:
  the pack step runs `pnpm --dir <tool> run build`.
- Doctor checks that each `bin` file exists,
  is in `files`, and imports the built CLI.

### Runner in the repo (Duke, 2026-10-20)

- In the repo, the tool's TypeScript source runs
  with tsx, a devDependency of the tool.
  Not `pnpm dlx`.
- tsx runs the source for dev and for the app's
  own tests (`tests-app/`).
- The bin runs built JS: `dist-cli`, with plain
  node, in the repo and when published.
  So the frozen tests that start the bin need one
  build first: a vitest global setup runs
  `vp build` once (Duke, 2026-10-22 23:53).
  No frozen test body builds.
- The loop's `prepare` script runs `vp build`,
  so an install builds `dist-cli`, and the
  scaffold's `tinker-loop` works from the
  workspace.
- Why tsx: Node 24 strips types, but it ignores
  tsconfig `paths`. So plain node cannot load
  `~/` and `@/` imports (checked 2026-10-20).
  tsx resolves them; so does bun, which the
  repo does not use.

### Keep simpler

- No `tinker run` subcommand and no bin generator.
  The app owns its bin.
- No separate host package for now.
  `@tinker/start/main-host` already exports `runMain`
  (`packages/start/package.json:26`).

## S3 SIGHUP and EPIPE in `runMain`

### Problem

- `runMain` stops on SIGINT and SIGTERM only.
  `packages/start/lib/main-host.mjs:181-182`
- A closed terminal sends SIGHUP.
  The host does not stop the command, and the
  command's child groups live on.
- The loop handles SIGHUP in its own bin today.
  `packages/loop/bin/tinker-loop.mjs:7`
- A reader that quits early, such as `head`,
  closes stdout.
  The host's output flush then fails and sets
  the run as failed.
  `packages/start/lib/main-host.mjs:85-87`
- The loop's bin ignores EPIPE today, and a test
  checks it.
  `packages/loop/tests/rules.test.mjs:377`
  on `loop/t3-review`

### Precedent

- POSIX shells: a process killed by signal n
  exits 128 + n.
- SIGHUP is 1, so it exits 129.
  `nohup` exists because SIGHUP stops work.
- Unix filters such as `cat` and `yes` end
  quietly when the reader closes the pipe.

### Change

- `runMain` stops on SIGHUP with code 129.
- The host ignores EPIPE on stdout:
  the reader is gone, and the command's
  exit code stands.
- The contract at `start-decompose.md:127-129`
  lists SIGHUP 129, SIGINT 130, and SIGTERM 143.
  The same ticket adds S5's line.

### Keep simpler

- No SIGQUIT, SIGPIPE, or SIGUSR handling.
- EPIPE on stderr is not special.

## S4 Child groups and the hard stop

### Problem

- After a stop, the host waits 10 seconds,
  then sends SIGKILL to its own process.
  `packages/start/lib/main-host.mjs:13-14`, `:59`
- The loop runs each gate in its own
  process group.
  `packages/loop/lib/gates.mjs:149-152`
- A SIGKILL of the tool does not reach
  those groups, so they live on.
- The host has no list of groups to kill.
- The contract calls the 10 seconds
  "the only hard stop".
  `docs/decisions/start-decompose.md:127`
- No test stops the tool while a gate ignores
  SIGTERM.
  "a gate that ignores SIGTERM is killed 5 seconds
  later" (`check.test.mjs:333`) is a timeout test
  with exit 1.
  The stop test with exit 130 (`check.test.mjs:346`)
  uses a gate that obeys SIGTERM.

### Precedent

- `setsid`: a child in its own session and group.
- `kill(-pgid, sig)`: one call signals
  the whole group.
- `docker stop`: SIGTERM, wait 10 seconds,
  then SIGKILL.

### Change

- The process resource owns every group it starts.
  The host does not.
- On stop or close, the resource sends SIGTERM
  to each live group, waits up to 5 seconds,
  then sends SIGKILL and waits up to 1 second.
- That is at most 6 seconds.
  It fits inside the host's 10 seconds,
  with 4 seconds left to flush output.
- The contract line at `start-decompose.md:127`
  becomes: a command's own kill sequence must end
  inside the 10-second grace; the host's SIGKILL
  is the last resort.
- A new test, added before the freeze:
  stop the tool while a gate ignores SIGTERM.
  The exit code is 130, and the gate's pid is gone
  within 6 seconds.

### Keep simpler

- No cgroups and no child subreaper.
- No host registry of child groups.
- The 10 seconds stay. `runMain` can already
  pass another `graceMs` if one tool needs it.

## S5 Exit 2 "needs a person"

### Problem

- The contract lists 0, 1, 64, 65, 75, and 78,
  plus 130 and 143.
  `docs/decisions/start-decompose.md:127-129`
- `tinker-loop status` exits 2 when a person
  must check the work.
- Exit 2 is not in the contract.

### Precedent

- `grep` and `diff` put an answer in the exit code:
  0 and 1 are answers.
  For them, 2 means trouble.
  We share the shape of the codes, not the meaning.
- `sysexits.h` keeps 64 to 78 for errors.

### Change

- A command may give 2 one meaning of its own.
  It documents that meaning in its usage
  and its README.
- 1 stays the plain failure.
  For `status`, 1 is "not done".
  A crash also exits 1, so a crash never
  reads as done.
- 64 to 78 stay the sysexits errors.

### Keep simpler

- Only 2 is added.
  No range of free answer codes.

## S6 Where the process-group resource lives

### Options

- Core: no.
  Core stays at 0.8.0 and is not patched.
  `docs/decisions/start-decompose.md:7`
- A Start component: not yet.
  A component is a copied registry item.
  It needs registry, template, and proof updates.
  No app other than the loop runs child groups.
- App-local in the loop: yes.

### Pick: app-local

- One user today.
  Precedent: YAGNI, "you aren't gonna need it".
- It moves to a Start component when
  a second app needs child groups.
- Its start is T3's `lib/process.mjs` on
  `loop/t3-review`: `runProcess`, the timeout,
  and the TERM then KILL sequence.
- Its tests stay with it, so the move
  is a copy plus a registry item.

## S7 The working folder in `MainContext`

This gap was found while planning the port.

### Problem

- `MainContext` has env, args, signal,
  stdout, stderr, and exit, but no folder.
  `docs/decisions/start-decompose.md:104-111`
- Commands may read no process globals.
  `docs/decisions/start-decompose.md:115`
- The loop works on "the app in this folder".
  It needs the folder the user ran it in.
- `MainContext` is a type in each app's copied
  base, not in Start.
  `apps/start-scaffold/tinker/base/main.ts:4`
  `apps/start-min/tinker/base/main.ts:4`
  `apps/issue-board/tinker/base/main.ts:4`
  The registry ships it in the `base` item.

### Precedent

- `posix_spawn_file_actions_addchdir`:
  the spawner sets the child's working folder.
- Node's `child_process` takes `cwd`
  next to `env`.

### Change

- `MainContext` gets `cwd: string`.
- `runMain` fills it from `process.cwd()`.
- `createMainHost` takes it as an option,
  so tests pass a folder.
- This is a copied-runtime change:
  - update the golden `tinker/base/main.ts`;
  - run `registry:build`;
  - sync start-min and issue-board;
  - update the contract block at
    `start-decompose.md:104-111`;
  - add an UPGRADE.md note;
  - run the template and registry proofs.

### Keep simpler

- No `chdir`: the command reads `cwd` only.

## P The port

### Layout

The loop stays at `packages/loop`.
Its name stays `@tinker/loop`, its bin `tinker-loop`.
It becomes a CLI-only Start app (S1).

```text
packages/loop
  cmds/cli.ts
    parse args, bind tags,
    run one operation,
    map its result to an exit code
  tinker/base/main.ts
    copied base-main: defineMain,
    checkClosed
  src/tags.ts
    appDir, baseRef, childEnv,
    reviewModel, print, warn, stop
  src/report.ts
    report.findingLine, report.summary,
    report.shortSha, report.count: the
    lines more than one command prints,
    and the severity and status order
  src/resources/
    processes  child groups (S4, S6)
    store      findings, rounds, last check,
               gate logs, the lock
    git        rev-parse, diff, merge-base,
               the work tree
    startRules finds the app's Start
    loopConfig reads and checks loop.json
    scan       the change's base, diff,
               and quick-scan hits
    reviewer   the rules, the change files,
               the run on processes, the reply
  src/operations/
    check, gates, findings, rules,
    answer, status, review
  bin/tinker-loop.mjs
    runMain host (S2) over dist-cli
```

This is the shape after ticket 9.
There is no `lib/`. The package exports only
`./package.json`: other apps use the bin.

- Each unit lists its parameters: the tags and
  resources it depends on.
  Those are the edges of the graph.
- Tags hold what `cmds/cli.ts` reads:
  the app folder (from `cwd` and `--app`),
  `--base`, the env for child processes,
  the model, the output (`print`, `warn`),
  and the stop signal (`stop`).
- `loopConfig` is a resource on `appDir`,
  not a tag, so it comes from the graph.
- Operations read and write no file
  themselves: every file goes through a
  resource (ticket 9).
- `childEnv` is bound from the context's env.
  So the process resource passes env on purpose
  and reads no process global.
- Resources own IO and live work:
  child groups, the file store, git, and the reviewer.
- The store takes time from `ctx.clock` and the
  lock token from `ctx.random`.
  Temp file names use random, not a pid.
- Operations take checked input and return
  results or raise typed errors.
- Only `cmds/cli.ts` picks the exit code.
  The mapping stays inline there, since it has
  one caller (`start-decompose.md:52-53`).
- Expected failures write their own stderr line
  and call `exit(code)` with no reason.
  The host prints a reason only for a crash
  (`main-host.mjs:27-28`).
  So messages such as
  "tinker-loop review: the reviewer exited
  with code 3" stay as they are.

### Graph first

Duke's rule, 2026-10-20:
"if no need to do pure function, then don't do it.
normally the 'need' comes from what are parameters,
and that reflect the graph".

Why, in Duke's words (2026-10-20 08:07):
"the value of this is surely less type transfer.
Type can almost always can infer from the graph
rather than redeclare, especially to those pure
function".

- Types flow from the tags and resources.
  Code inside a unit gets them by inference.
- A separate pure function must redeclare its
  parameter types.
  That copy is the type transfer we avoid.

The method:

- Start from each operation and resource,
  and its parameters.
- Write the body inline in that unit.
- Extract a plain helper only when the graph
  shows the need: two units take the same
  parameters for the same work.
- When a body hits the complexity limit of 8
  (`vite.config.ts:31`), split it by its
  dependencies into another unit:
  an operation or a resource in the graph.
  Do not split it into a pure helper.
- Write no type by hand for a value that comes
  from the graph: a tag value, a resource value,
  or an operation input.
- Declare a type only at its source:
  the tag, or the Data schema.
  TypeScript infers it everywhere else.
- An extracted helper takes its types from that
  source too, such as the tag's value type
  (`Tag.Handle<T>` carries it).
  It never declares a new copy.
- The cap of 17 stays a check, not a target.
  `check-plain` runs it.
  `docs/decisions/start-decompose.md:48-55`

Precedent:

- Dependency injection: a unit's parameters
  are the graph's edges, so the graph shows
  who needs what.
- YAGNI for extraction: no helper before a
  second unit needs the same work.
  The contract's two-caller rule sets that bar.

Rejected:

- A pure kit package beside the app.
  It moves code out of the graph, so the
  graph no longer shows the need.
- A cap exception for tools.
  The contract says "Do not raise the cap" and
  "Do not use … wrappers to evade it".
  `docs/decisions/start-decompose.md:52-54`

### The tests stay the acceptance suite

Precedent: characterization tests
(Michael Feathers), and the strangler fig
(Martin Fowler).

The freeze ticket (ticket 5) runs on today's code.

- Every test imports from one file,
  `tests/api.mjs`.
  It re-exports `main`, and gives `lockFindings`
  and `recordReviewRound` as async functions.
- Tests that import `parseRules`, `gateRule`,
  `scans`, or `promptTitle` move to the CLI seam
  first.
  Parser cases write a fake Start's `rules.md`
  and run `tinker-loop rules`.
  The rule-coverage test runs `check` and then
  `findings --rules`.
  Graph-first bodies are inline, so those
  functions may not exist after the port.
- Calls to `lockFindings` and `recordReviewRound`
  get `await`, so the same test bodies pass when
  those become async store methods.
- The S4 stop test is added.
- The suite is 120 tests:
  99 from before T3, plus T3's 20
  (19 review tests and 1 scan test),
  plus the stop test.
  An earlier draft said 111. It counted T3's
  11 tests from before T3 merged.
- After ticket 5, the `*.test.mjs` files freeze.
  Later tickets change only `tests/api.mjs`,
  `tests/fixture.mjs`, and test setup files.

Through tickets 6 and 7, the old code keeps serving.

- Ticket 6 switches the bin to the S2 `runMain`
  bin over `dist-cli` (Duke, 2026-10-22 23:53).
  `cmds/cli.ts` hands each command to `lib/`
  through `src/old-tool.ts`: the strangler fig.
- `tests/api.mjs` points at `lib/` until ticket 8.
- Tickets 6 and 7 add the app beside `lib/`.
- Ticket 8 ports the operations, removes the
  hand-off, and switches `tests/api.mjs` to the
  app in one ticket.
- `main` then becomes an in-process host
  around the CLI command, with `cwd`.
  The store helpers open a scope test root
  with the store resource.
- Every port ticket checks two things:
  the 120 frozen tests pass, and
  `git diff <freeze> -- 'packages/loop/tests/*.test.mjs'`
  is empty.

### T3

- T3 lands first, as ticket 1.
- Its prompt bug is fixed there:
  the prompt began with the skill's `---`,
  and `claude` read it as an option.
- The fix: the prompt starts with a plain
  title line, and a test checks that the
  prompt word never starts with `-`.
- One real `claude` review is a manual,
  paid check, not part of CI.
- The port moves `review` into an operation,
  with the reviewer run by the process resource.

### Keep simpler

- One command file, not one per subcommand.
- No new Core API.
- No new package: the loop stays one app.

## Tickets

In order. Each ticket is one commit or PR.

1. **T3 land** — fix the `---` prompt, merge T3
   Verify: 110 loop tests pass.
   One real `claude` review prints findings
   (manual, paid, not CI).
2. **S3+S7 host** — SIGHUP 129, EPIPE, and `cwd`
   Includes the copied base, `registry:build`,
   start-min and issue-board sync, UPGRADE.md,
   and the contract lines for S3, S4, S5, S7.
   Verify: main-host tests for 129, EPIPE, and
   `ctx.cwd`. All Start tests pass.
   Template and registry proofs pass.
   `pnpm --dir packages/start run mutate` is
   at least 85.
3. **S1 CLI-only app** — Start without web entries
   Includes optional peers, the `base-main` item,
   the contract at `start-decompose.md:131-133`,
   and `README.md:93` set to 85.
   Verify: a fixture app with only `cmds/cli.ts`
   and no React or TanStack installed passes
   prepare, doctor, build, and `gate:commands`.
   All Start tests and registry checks pass.
   `pnpm --dir packages/start run mutate` is
   at least 85.
4. **S2 bin pattern** — bin, files, `ssr.external`,
   doctor check
   Verify: the fixture app packs with its bin and
   `dist-cli`. Another workspace app runs it with
   `vp exec`. `dist-cli` holds no copy of
   `@tinker/start` or `@tinker/core`.
5. **Freeze** — `tests/api.mjs`, `await`,
   internals moved to the CLI seam,
   and the S4 stop test
   Verify: 120 tests pass. After this ticket,
   the `*.test.mjs` files do not change.
6. **Skeleton** — the app beside `lib/`
   CLI-only files, `base-main`, tsx as a
   devDependency, the S2 bin, and the hand-off
   to `lib/`.
   Verify: doctor and `gate:commands` pass.
   The 120 frozen tests pass, with one build first.
   The scaffold's `tinker-loop` runs.
7. **Resources** — processes, store, git,
   startRules, reviewer, each with its parameters
   Verify: a scope test closes the root while a
   child ignores SIGTERM, and finds its group
   gone within 6 seconds.
   The 120 frozen tests pass.
8. **Operations** — all six commands on Core,
   bodies inline, then the switch
   Verify: the 120 frozen tests pass,
   serial and the CI way.
   The test-body diff since ticket 5 is empty.
   Types are declared only at tags and Data
   schemas; graph values carry no hand-written
   type, and review checks it.
9. **Clean up** — `lib/` removed, CI runs the
   loop's doctor and gates
   `check-plain.mjs` comes here, with its first
   user: copy it and add the `check-plain` script
   when CI runs the loop's gates.
   Mutation follows Duke's rule for apps
   (2026-10-19 19:34): a diff gate on changed
   lines, through the Core graph, and a full run
   as a scheduled report with floor 60.
   Start stays at 85.
   Verify: CI is green. The diff gate passes.
   `check-plain` passes, and each plain helper
   in `PLAIN.md` names its two units.
   The scheduled full run reports at least 60.
   A real `tinker-loop check` runs in the scaffold.
   Also: the loop runs `tinker prepare` in
   `prepare`, not `postinstall`. pnpm refuses
   a tarball with a `postinstall` script until
   the user approves it, and an install of a
   tarball never runs `prepare`. Doctor accepts
   either script.
   Status: `check-plain` on the loop counts 0
   plain functions, under the cap of 17.
   CI runs it as `pnpm --dir packages/loop run
check-plain`, with the scaffold's script.
10. **Reshape for check-plain** — the closures
    inside units become graph work.

- A resource returns one object; its
  methods call each other by name.
- Lock work is `findingsLock.take` and
  `release`, inside the record operations.
- The command line is the `commandLine`
  resource; `runCommand` picks the command.
- The 4 report lines are operations too
  (`report.findingLine`, `report.summary`,
  `report.shortSha`, `report.count`), so a
  call lands on a span and `summary` names
  `findingLine` as a dependency. Nothing is
  left plain.
  Verify: `check-plain` passes. The 120 frozen
  tests are unchanged and pass.

## Decided

- Helpers (Duke, 2026-10-20): graph first.
  No kit package and no cap exception.
