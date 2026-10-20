# Loop on Tinker

Date: 2026-10-20. Status: proposed.
Builds on: [start-decompose.md](start-decompose.md), loop T1 to T4.
Decided by: Duke picked "full app".
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
- Other workspace packages, such as a pure kit,
  are inlined into `dist-cli`.
  They stay dev dependencies.
- Who builds `dist-cli`:
  - the tool's own tests, in a vitest
    `globalSetup`, so `vp test` builds first;
  - the root `vp run -r build` for local use;
  - any CI job that runs the tool runs
    `pnpm --dir <tool> run build` first.
- Doctor checks that each `bin` file exists,
  is in `files`, and imports the built CLI.

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
    appDir, baseRef, loopConfig,
    childEnv, reviewModel
  src/resources/
    processes  child groups (S4, S6)
    store      findings, rounds,
               last check, the lock
    git        rev-parse, diff, merge-base
    kit        lazy module:
               @tinker/loop-kit
    startRules finds the app's Start
    reviewer   argv, runs on processes
  src/operations/
    check, findings, rules,
    answer, status, review
  bin/tinker-loop.mjs
    runMain host (S2)
```

- Tags hold what `cmds/cli.ts` reads:
  the app folder (from `cwd` and `--app`),
  `--base`, the checked `loop.json`,
  the env for child processes, and the model.
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

### The plain-helper cap

The count, by this rule: a top-level function is pure
when it is not async, its body has no file, process,
spawn, time, random, or Atomics call,
and it calls no function that has one.

- `7321d6c`: 86 top-level functions, 39 pure.
- `loop/t3-review` (`ac35e5d`): 101 functions, 50 pure.

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

Pick: split the kit.

- A new plain package, `@tinker/loop-kit`,
  holds only pure code.
  No IO, no clock, no random, no pid.
- That is the findings format, ids, the merges,
  the rules parser, the diff scan,
  the review parser and prompt, and the report text.
- It is plain Node, with its own unit tests.
- The app loads it through the `kit` resource.
- The file store, the lock, the clock, and random
  are app resources, so Core's rules reach them.
- App code keeps only its own plain helpers,
  listed in `PLAIN.md`, at most 17.

Rejected: a cap exception for private tools.
The contract says "Do not raise the cap" and
"Do not use … wrappers to evade it".
`docs/decisions/start-decompose.md:52-54`

### The tests stay the acceptance suite

Precedent: characterization tests
(Michael Feathers), and the strangler fig
(Martin Fowler).

The freeze ticket (P0) runs on today's code.

- Every test imports from one file,
  `tests/api.mjs`.
  It re-exports `main`, `gateRule`, `scans`,
  `parseRules`, `lockFindings`, and
  `recordReviewRound`.
- Calls to `lockFindings` and `recordReviewRound`
  get `await`, so the same test bodies pass when
  those become async store methods.
- The S4 stop test is added.
- The suite is then 111 tests:
  99, plus T3's 11, plus the stop test.
- After P0, the `*.test.mjs` files freeze.
  Later tickets change only `tests/api.mjs`,
  `tests/fixture.mjs`, and test setup files.

Through P1 to P3, the old code keeps serving.

- The bin and `tests/api.mjs` point at `lib/`
  until P4.
- P2 and P3 add the app beside `lib/`.
- P4 switches the bin to `runMain` and
  `tests/api.mjs` to the app in one ticket.
- `main` then becomes an in-process host
  around the CLI command, with `cwd`.
  The store helpers open a scope test root
  with the store resource.
- Every P ticket checks two things:
  the 111 frozen tests pass, and
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
- The kit is private, like the loop.

## Tickets

In order. Each ticket is one commit or PR.

- **T3 land** — fix the `---` prompt, merge T3
  Verify: 110 loop tests pass.
  One real `claude` review prints findings
  (manual, paid, not CI).
- **S3+S7 host** — SIGHUP 129, EPIPE, and `cwd`
  Includes the copied base, `registry:build`,
  start-min and issue-board sync, UPGRADE.md,
  and the contract lines for S3, S4, S5, S7.
  Verify: main-host tests for 129, EPIPE, and
  `ctx.cwd`. All Start tests pass.
  Template and registry proofs pass.
  `pnpm --dir packages/start run mutate` is
  at least 85.
- **S1 CLI-only app** — Start without web entries
  Includes optional peers, the `base-main` item,
  the contract at `start-decompose.md:131-133`,
  and `README.md:93` set to 85.
  Verify: a fixture app with only `cmds/cli.ts`
  and no React or TanStack installed passes
  prepare, doctor, build, and `gate:commands`.
  All Start tests and registry checks pass.
  `pnpm --dir packages/start run mutate` is
  at least 85.
- **S2 bin pattern** — bin, files, `ssr.external`,
  doctor check
  Verify: the fixture app packs with its bin and
  `dist-cli`. Another workspace app runs it with
  `vp exec`. `dist-cli` holds no copy of
  `@tinker/start` or `@tinker/core`.
- **P0 freeze** — `tests/api.mjs`, `await`,
  and the S4 stop test
  Verify: 111 tests pass. Test bodies change
  only in imports and `await`.
- **P1 kit** — pure code to `@tinker/loop-kit`
  Verify: kit unit tests pass.
  The kit imports no `node:fs` or
  `node:child_process`, and uses no `process`,
  `Date`, or `Math.random`.
  The 111 frozen tests pass.
- **P2 skeleton** — the app beside `lib/`
  CLI-only files, `base-main`, `check-plain.mjs`
  copied, and the `globalSetup` build.
  Verify: doctor, `gate:commands`,
  `check-plain`, and `check-plain --prove` pass.
  The 111 frozen tests pass.
- **P3 resources** — processes, store, git,
  kit, startRules, reviewer
  Verify: a scope test closes the root while a
  child ignores SIGTERM, and finds its group
  gone within 6 seconds.
  The 111 frozen tests pass.
- **P4 operations** — all six commands on Core,
  then the switch
  Verify: the 111 frozen tests pass,
  serial and the CI way.
  The test-body diff since P0 is empty.
  `PLAIN.md` lists at most 17.
  `check-plain` passes.
- **P5 clean up** — `lib/` removed, a stryker
  config with floor 85, CI runs the loop's
  doctor and gates
  Verify: CI is green.
  `pnpm --dir packages/loop run mutate` is
  at least 85.
  A real `tinker-loop check` runs in the scaffold.

## Open question for Duke

- Split the kit, or allow a cap exception?
  The default is the split:
  `@tinker/loop-kit` holds only pure code,
  and the store, lock, clock, and random are
  app resources.
  The exception is the rejected option
  (`start-decompose.md:52-54`).
