# Loop on Tinker

Date: 2026-10-19. Status: proposed.
Builds on: [start-decompose.md](start-decompose.md), loop T1 to T4.
Decided by: Duke picked "full app".
Start's CLI gaps are fixed first.
Then tinker-loop is rebuilt as a real Tinker app.

## Context

tinker-loop is a plain Node tool today.
It lives in `packages/loop` on `next` at `7321d6c`.
It has 99 tests that run the command as a user would.
T3 (`tinker-loop review`) waits on branch `loop/t3-review`, with 11 more tests.

Start ships a CLI entry only as an extra on a web app.
A tool with only `cmds/cli.ts` cannot be a Start app today.
The items below fix that first, then port the loop.

Each item gives the problem with evidence,
the precedent we borrow, the change, and what we keep simpler.
Line numbers are on `next` at `7321d6c`.

## S1 A CLI-only app

### Problem

- `tinker()` throws when `src/routes` is missing.
  `packages/start/vite.mjs:111`
- `tinker()` always loads TanStack Start.
  `packages/start/vite.mjs:134`
- Router, start, and server entries are required.
  `packages/start/lib/named.mjs:8-10`
  `packages/start/vite.d.mts:9-11`
- `tinker prepare` stops without a server entry,
  then writes a route tree.
  `packages/start/bin/tinker.mjs:100-108`
- Doctor's `routes` check stops the build.
  `packages/start/lib/doctor.mjs:15`, `:21`

### Precedent

- Go's `cmd/<name>/main.go`:
  a module can hold only commands, no server.
- Cargo: a crate can be only `src/main.rs`.

### Change

- An app is CLI-only when `tinker()` names
  `cliEntry` and no `serverEntry`.
- In a CLI-only app, router, start, and server
  entries are not required.
- `tinker()` skips TanStack Start and the
  `src/routes` check.
- `tinker prepare` writes `.tinker/` files
  but no route tree.
- Doctor skips `routes` and the generated
  route checks.
  It keeps imports, style, boundary, and named files.
- `gate:commands` builds and checks the CLI entry,
  as it does today.

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
  `vp run -r build` builds the tool
  before the apps that use it.
- `@tinker/start` and `@tinker/core` become
  runtime `dependencies` of the tool,
  since the bin imports `main-host`
  and the build keeps packages external.
- Doctor checks that each `bin` file exists,
  is in `files`, and imports the built CLI.

### Keep simpler

- No `tinker run` subcommand and no bin generator.
  The app owns its three-line bin.
- No separate host package.
  `@tinker/start/main-host` already exports `runMain`
  (`packages/start/package.json:26`).

## S3 SIGHUP in `runMain`

### Problem

- `runMain` stops on SIGINT and SIGTERM only.
  `packages/start/lib/main-host.mjs:181-182`
- A closed terminal sends SIGHUP.
  The host does not stop the command, and the
  command's child groups live on.
- The loop handles SIGHUP in its own bin today.
  `packages/loop/bin/tinker-loop.mjs:7`

### Precedent

- POSIX shells: a process killed by signal n
  exits 128 + n.
- SIGHUP is 1, so it exits 129.
  `nohup` exists because SIGHUP stops work.

### Change

- `runMain` stops on SIGHUP with code 129.
- The contract line becomes:
  SIGHUP is 129, SIGINT is 130, SIGTERM is 143.
  `docs/decisions/start-decompose.md:127-128`

### Keep simpler

- No SIGQUIT, SIGPIPE, or SIGUSR handling.

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

### Precedent

- `docker stop`: SIGTERM, wait 10 seconds,
  then SIGKILL.
- systemd `KillMode=control-group`:
  stop signals go to the whole group.
- `setsid` and `tini -g`: one group per child,
  so one signal reaches its whole tree.

### Change

- The process resource owns every group it starts.
  The host does not.
- On stop or close, the resource sends SIGTERM
  to each live group, waits up to 5 seconds,
  then sends SIGKILL and waits up to 1 second.
- That is at most 6 seconds.
  It fits inside the host's 10 seconds,
  with 4 seconds left to flush output.
- The rule goes in the contract:
  a command's own kill sequence ends
  within the grace time.
- A test stops the tool while a gate ignores
  SIGTERM, and checks that the gate is gone
  and the exit code is 130.
  The loop has this test today
  ("a gate that ignores SIGTERM is killed
  5 seconds later").

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

- `grep` and `diff` give an answer in the code:
  0 and 1 are answers, 2 is something else.
- `sysexits.h` keeps 64 to 78 for errors.

### Change

- A command may give 2 one documented meaning,
  as grep and diff do.
  It says so in its usage and README.
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

- One user today. The rule of three:
  extract on the third use.
- It moves to a Start component when
  a second app needs child groups.
- Its tests stay with it, so the move
  is a copy plus a registry item.

## S7 The working folder in `MainContext`

This gap was found while planning the port.

### Problem

- `MainContext` has env, args, signal,
  stdout, stderr, and exit, but no folder.
  `docs/decisions/start-decompose.md:104-110`
- Commands may read no process globals.
  `docs/decisions/start-decompose.md:115`
- The loop works on "the app in this folder".
  It needs the folder the user ran it in.

### Precedent

- `execve` and `posix_spawn`: argv, env,
  and the working folder are a process's inputs.
- Node's `child_process` takes `cwd`
  next to `env`.

### Change

- `MainContext` gets `cwd: string`.
- `runMain` fills it from `process.cwd()`.
- `createMainHost` takes it as an option,
  so tests pass a folder.

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
    copied base: defineMain, checkClosed
  src/tags.ts
    appDir, baseRef, loopConfig,
    childEnv, reviewModel
  src/resources/
    processes  child groups (S4, S6)
    git        rev-parse, diff, merge-base
    kit        lazy module: @tinker/loop-kit
    startRules finds the app's Start
  src/operations/
    check, findings, rules,
    answer, status, review
  bin/tinker-loop.mjs
    three-line runMain host (S2)
```

- Tags hold what `cmds/cli.ts` reads:
  the app folder (from `cwd` and `--app`),
  `--base`, the checked `loop.json`,
  the env for child processes, and the model.
- `childEnv` is bound from the context's env.
  So the process resource passes env on purpose
  and reads no process global.
- Resources own IO and live work:
  child groups, git calls, and the kit.
- Operations take checked input and return
  results or raise typed errors.
  Only `cmds/cli.ts` picks the exit code.

### The plain-helper cap

The loop has about 45 pure functions.
The cap is 17 per app, and a helper needs
two real callers.
`docs/decisions/start-decompose.md:48-55`
The complexity limit of 8 also applies
(`vite.config.ts:31`), so long parsers cannot
fold into one body.

Precedent: functional core, imperative shell
(Gary Bernhardt).
In this repo, outside libraries enter unit
bodies through lazy module resources.
`docs/decisions/start-decompose.md:16-17`
`apps/issue-board/src/backend/modules.ts:28-30`

- A new plain package, `@tinker/loop-kit`,
  holds the pure code and the file store.
  That is the findings format, merges, ids,
  the lock, the rules parser, the diff scan,
  the review parser, and the report text.
- It is plain Node, with its own unit tests.
- The app loads it through the `kit` resource.
- App code keeps only its own plain helpers,
  listed in `PLAIN.md`, at most 17.
  The plan is about 5: `mainErrorCode`,
  `checkClosed`, and the exit-code mappings.

### The tests stay the acceptance suite

Precedent: characterization tests
(Michael Feathers), and the strangler fig
(Martin Fowler).

- First, on today's code, every test imports
  from one file, `tests/api.mjs`.
  It re-exports `main`, `gateRule`, `scans`,
  `parseRules`, `lockFindings`, and
  `recordReviewRound`.
- After that ticket, the `*.test.mjs` files freeze.
  The port changes only `tests/api.mjs`
  and `tests/fixture.mjs`.
- `main` becomes an in-process host
  around the CLI command, with `cwd`.
- The lock and round helpers come from the kit.
  They stay sync, since the tests call them so.
- Each port ticket checks that
  `git diff <freeze> -- 'packages/loop/tests/*.test.mjs'`
  is empty.

### T3

- T3 lands first on today's code, so its
  11 tests join the frozen suite (110 tests).
- Its prompt bug is fixed there:
  the prompt began with the skill's `---`,
  and `claude` read it as an option.
- The fix: the prompt starts with a plain
  title line, and a test checks that the
  prompt word never starts with `-`.
- The port then moves `review` into
  an operation, with the reviewer command
  run by the process resource.

### Keep simpler

- One command file, not one per subcommand.
- No new Core API.
- The kit is private, like the loop.

## Tickets

In order. Each ticket is one commit or PR.

- **S3+S7 host** — SIGHUP and `cwd` in `runMain`
  Verify: a main-host test exits 129 on SIGHUP.
  A test reads `ctx.cwd` as `process.cwd()`.
- **S5 contract** — exit 2 and SIGHUP in
  `start-decompose.md`
  Verify: the contract lists 2, 129, 130, 143.
- **S1 CLI-only app** — Start without web entries
  Verify: a fixture app with only `cmds/cli.ts`
  passes prepare, doctor, build, and
  `gate:commands`. All Start tests pass.
- **S2 bin pattern** — bin, files, doctor check
  Verify: the fixture app packs with its bin
  and `dist-cli`. Another workspace app runs it
  with `vp exec`.
- **T3 land** — fix the `---` prompt, merge T3
  Verify: 110 loop tests pass. One real
  `claude` review prints findings.
- **P0 freeze** — tests import `tests/api.mjs`
  Verify: 110 tests pass. Test bodies are
  unchanged except imports.
- **P1 kit** — move pure code to `@tinker/loop-kit`
  Verify: kit unit tests and the 110 tests pass.
- **P2 skeleton** — the loop becomes a
  CLI-only app with its bin
  Verify: doctor and `gate:commands` pass.
  An unknown command exits 64.
- **P3 resources** — processes, git, kit, startRules
  Verify: a scope test stops a TERM-ignoring
  child within 10 seconds, with exit 130.
- **P4 operations** — all six commands on Core
  Verify: the frozen 110 tests pass,
  serial and the CI way. `PLAIN.md` lists
  at most 17. `check-plain` passes.
- **P5 clean up** — old `lib/` removed,
  CI runs the loop's doctor and gates
  Verify: CI is green. A real
  `tinker-loop check` runs in the scaffold.

## Open questions for Duke

- Is a plain `@tinker/loop-kit` package the
  right way to meet the cap?
  The other way is a cap exception for tools.
- Should exit 2 be allowed for any command,
  or for `tinker-loop status` only?
- Should T3 land before the port,
  or be folded in only during the port?
- Should the tool take `@tinker/start` as a
  runtime dependency, or should `runMain` move
  to a small host package?
