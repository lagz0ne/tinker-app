# Current Start authoring contract

This is the contract for the current source, released as Start 0.13.0.
Each released change set stays in [UPGRADE.md](../UPGRADE.md#0100).
The golden copied source is `apps/start-scaffold/tinker/`; the small app shares
its base and selected components. Core and React stay at 0.9.0. Do not patch Core.

## Own the boundary

Hosts own process inputs, sockets, OS stops, and output flush. Direct `cmds/*`
files bind app inputs and own roots. Tests may own roots. Commands keep wiring
inline. Test their input, startup, exit, and close contracts.

Feature code uses tags for injected values, data for visible state, resources
for clients and private work state, and operations for actions. Outside libraries
enter unit bodies through lazy module resources. Use the unit's clock, random,
signal, and defer. Import tables, schemas, and own code at the top.

## Keep imports one-way

- Commands import Core, `~/base`, `~/components`, and `@/` app code.
- Base owns native entry, close, panic, and observation glue. It may use components.
- Components import other components through public entries and declare direct
  `requires` in `component.json`. They never import base, app code, or commands.
- App code uses component public entries. Tests may use the private files they prove.
- `@tinker/start` ships tools and hosts, not feature runtime or forwarding barrels.

Use four runtime import groups: libraries, `~/`, `@/`, then local files. The
formatter puts native built-ins first when present. Omit TypeScript file endings.
Break a function body into steps with blank lines; keep imports at the top.

## Declare work and its owner

No authored classes or live module clients. A declaration may live at module
scope; a running client, root, stop controller, queue, timer, or watcher needs
an owner. Resources release owned work with defer. Only direct commands and
scope tests create roots. Native SDK callbacks keep their SDK contracts.

A resource's returned methods may accept native callbacks or database handles
when that resource owns their work. This does not permit a plain helper to take
a scope, session, context bag, controller, clock, signal, or IO object. Named
base entries, driver bridges, request middleware, and extension hooks are
explicit native boundaries. A new helper in one of those files gets no blanket
exception. React views render data and invoke operations; their helpers still
follow the plain rule.

Plain helpers are pure, have at most three plain value inputs, and have at
least two distinct real callers. Tests, repeated calls from one caller, and
self-calls do not count. Each helper has a name and TSDoc explaining where each
input comes from and why it is needed. List every kept helper in `PLAIN.md`.
The cap is **17**, including mainErrorCode and checkClosed when kept. A one-caller
mapping stays inline. Do not raise the cap. Do not use unknown-to-handle casts,
callback bags, hidden object methods, or wrappers to evade it. Plain helpers
cannot do IO, await, read time or random, or retain state. Door readers and error
guards may take unknown. React props do not carry Core handles or signals.

## Bind only real seams

A component declares the typed values it needs, never an env object or text
converter. Commands read host inputs and bind each tag inline. Missing values
leave required tags unbound. Check required host config and startup slots before
ready. Safe defaults must support useful behavior without a choice. Core checks
tags lazily; this is not an eager check of every possible request binding.

Request headers, request stops, and request-close callbacks are bound per call.
Sync's app readers and records use required handle-bearing tags. Cross-root
telemetry callbacks and replaceable native/test IO also need bindings. Import
mandatory component work directly when these boundaries do not apply.

### Auth and account streams

Auth directly depends on sync.createAccountStream, sync.publishAccountNotice,
and mail.authMail. There are no auth hook slots, saved start context, or
AsyncLocalStorage bridge. Better Auth's hooks call those resolved controllers
or the mail queue directly. Hook operation spans hang under the scope-owned
auth resource's build span, rather than the request span.

User creation inserts sync_stream idempotently. A failed user hook logs and
leaves sign-up usable; session creation repeats the insert, so sign-in repairs
a missing row. Better Auth commits before its after-hooks and supplies no shared
transaction client, so these are awaited, separate pool calls. Session deletion
publishes its notice after the SDK commit. Auth mail keeps its owned queue.
During graceful shutdown those controllers refuse new work with Disposed. A
sign-in in that window can error after commit; the next sign-in repairs the
stream. A lost sign-out notice is harmless because streams close.

Page account, bootstrap, and live-account lookups do no database writes, including
with old or expired cookies. Better Auth defers refresh/expiry writes to its
explicit POST /api/auth/get-session path. The page shell mounts the browser
session hook: it checks on mount, focus, and every five minutes while signed in.
When GET reports needsRefresh, the SDK sends that POST and stores the new cookie.
The SDK's empty POST gets an explicit JSON body at the browser SDK boundary.
Stream bootstrap only reads; a missing stream raises StreamMissing. A migration
seeds the public row and backfills existing accounts. Snapshots use REPEATABLE
READ, READ ONLY so data and revision agree without a row lock.

## Close before success

Every process command exports its async function through the typed identity
defineMain. The host calls it once with this complete context:

```ts
export type MainContext = {
  env: Readonly<Record<string, string | undefined>>;
  args: readonly string[];
  cwd: string;
  signal: AbortSignal;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  exit: (code: number, reason?: unknown) => void;
};
```

Main returns a closed promise; a server also returns fetch. Importing a command
starts nothing. Commands read no process globals and load no env file. The host
owns those inputs, including cwd, the folder the process runs in. Follow the actual [small server](https://github.com/lagz0ne/tinker-app/blob/start-v0.13.0/apps/start-min/cmds/server.ts)
or [board commands](https://github.com/lagz0ne/tinker-app/blob/start-v0.13.0/apps/issue-board/cmds) for complete wiring.

Only the command chooses its error code: operations return results or raise
errors. An outer catch calls exit(code, error), then returns a stopped result.
It does not rethrow or print that error again. Internal catches may rethrow to
join cleanup. Close the app before telemetry; use checkClosed for root results.

Exit is a clean stop. The host keeps the first code, aborts signal, joins
closed, flushes stdout/stderr, and sets process.exitCode. It never calls
process.exit. It prints a saved failure immediately and each distinct late
failure once. Output that goes away, a closed pipe or terminal, does not change
the code. After a stop, the host waits a grace deadline of 10 seconds, then
kills its own process. A command that owns child processes ends them inside that
grace; the host's kill is the last resort and does not reach them. SIGHUP is
129, SIGINT is 130, and SIGTERM is 143, even if a later error asks for 1. Other
codes are 0 success, 1 unexpected error, 64 bad args, 65 bad data, 75 temporary
failure, and 78 bad startup config. A command may give 2 one documented meaning
of its own, as grep and diff shape their codes; it says so in its usage.

Vite names serverEntry, routerEntry, and startEntry. A CLI-only app names only
cliEntry: it has no web entries or routes and needs no React or TanStack, and it
copies only the base-main item. Apps with a worker or CLI also name workerEntry
and cliEntry and provide matching vite.worker.config.ts or vite.cli.config.ts
with literal build.ssr and build.outDir. Doctor and build check those
exports/configs. A CLI may ship as a package bin that imports the built CLI
entry and passes it to runMain; doctor checks that each bin file exists,
imports that entry, and that files lists both. gate:commands builds and runs each process entry serially,
proving its unknown-input exit and joined close without live services. The real
app tests and live proofs exercise configured startup and work paths.

Prod awaits main before listening and checks fetch. Dev shares one startup and
closes on HMR replacement. **A command exit closes the dev server. Fix startup
config, then restart `vp dev`.** A returned stopped server response is 503
Command stopped; the host prints the error.

### Write calls

New board multi-step writes and the counter/todo writes use one owned child call with a real signal. The
server function, route call, CLI batch, or worker dispatch owns that call. Steps
only depend on its session transaction; they do not open sessions or commit.
The request's streamed-body session is not the transaction owner.

The transaction is idle until the first query. It lazily checks out one client,
starts BEGIN, and sets LOCAL lock_timeout and statement_timeout. Typed defaults
are 500/1000 ms; maximum values are 1000/2000 ms. On session success defer commits;
on failure, cancel, or release it rolls back, then releases the client. A failed
BEGIN, COMMIT, or ROLLBACK discards the client with release(true). Ending idle
handles checks out nothing and issues no SQL. Retained ended handles raise
TransactionEnded; repeated ends do nothing. Nested tx.transaction() is refused.
Optional explicit commit/rollback ends are joined by defer without a second end.

Session close finishes before success, response bytes, or CLI progress output.
A defer COMMIT failure must fail the call. Keep the lock order, guards, execution
receipts, stream history, and board outbox writes in the same transaction. Send
board mail from the outbox; one alert send plus record/COMMIT must fit the host
grace. Its send deadline is at most 3000 ms and destroys active owned sockets.
SQL limits bound waits on a working database, not arbitrary network loss.

Counter and todos now use the same owned transaction call. Old profile writes
still await native transactions.
They are migration work, not examples of the new session transaction. Auth's
pool hooks stay outside that session transaction. Auth callbacks await a separate
committed enqueue in the shared mail outbox; board enqueue stays in its write
transaction. Workers claim batches before SMTP and acknowledge by lease token.
See [the migration list](https://github.com/lagz0ne/tinker-app/blob/start-v0.13.0/apps/issue-board/maintain/REFACTOR.md).

## HTTP and tests

Routes and server functions own wire Request/Response values. Operations take
checked plain input and return feature values or typed errors. The named auth
mount is a native protocol exception. Feature outgoing HTTP uses
httpRequest.controller; tests bind httpBackend. Only the named HTTP backend,
telemetry bridge, and SMTP socket module use their approved native IO. Do not
load raw HTTP clients, sockets, or built-in fetch elsewhere in feature code.

Test through small scopes with typed bindings and native resource presets.
Keep command and host contract tests. Run tests serially with
VITEST_MAX_WORKERS=1 and VP_RUN_CONCURRENCY_LIMIT=1. Never skip or quarantine a
test. A fault control must fail for its named cause. Run the app's listed gates,
including check-plain --prove after changing its rules.

### App mutation diff gate

App pull requests use `.github/workflows/mutation.yml` at floor **60**. The
weekly full app run, also available through workflow_dispatch, is a report and
never a pull-request merge gate. `packages/start` keeps floor **85**; Core does
not change.

Both apps mutate tinker, src/demo, src/backend, src/transport, src/contracts,
and cmds TypeScript. Command mains stay in: input, startup, exit, and close have
contract tests. No cmd file is exempted as untested wiring. Board src/frontend
views remain outside this backend scope. Existing exclusions keep native base
entries/fallbacks, route glue, and sync/functions binding declarations out.

Both apps ignore static mutants and keep the one-worker default. An instrumented
baseline of 533 tests exceeded five minutes on one CPU, so its startup deadline
is ten minutes; configured `timeoutMS` stays 15000. One shared arid-node ignorer suppresses log
calls, span labels, attribute names, and whole numeric initializers named for
timeout, deadline, or grace. Budget expressions stay eligible for mutation. These rules follow
[Google's arid-node approach](https://testing.googleblog.com/2021/04/mutation-testing.html).
They do not suppress attempt bounds, status values, or other business rules.

Run this from the repo root after building the app:

```bash
node scripts/mutation/span-map.mjs apps/issue-board
node scripts/mutation/diff.mjs --app apps/issue-board --base origin/main --head HEAD
```

The first command runs every app test once with both vite.config and
vitest.config, including the app test timeout and mock settings. A test-only Vite transform observes
Core's public span export at scope creation; it preserves existing observers
and logs. `reports/mutation/span-map.json` lists handles, reverse dependencies,
tests, and gaps: operation/resource handles with no observed test span.

The second command finds the PR merge base with the base branch, then reads
Git's changed lines, finds their handles, and follows
reverse `.depends` edges to command main or scope. It mutates only those line
ranges. A changed test selects its direct app imports only (depth one), then
follows named/star re-exports to the declaring files, then intersects those
files with spans that test file actually observed in the span map. Ordinary
indirect imports, type-only imports, unobserved spans, and plain helpers
without spans add no test-mapped targets. A test with no matching span plans
nothing, and the summary says why. Deleted tests use their base-revision imports
and any coverage still present in the current map. There is no fallback to all
source files.
Removed-only hunks select two surviving lines on each side, clamped at file ends.
A deleted file has no adjacent surviving lines; its omission is reported. Vitest selects the mapped test files; Stryker's per-test coverage then
selects tests for each mutant. Native helpers and unobserved handles fall back
to the map's complete test inventory, and the plan says when that happens.
No missing span can silently remove a changed line from the gate. The script
rejects a checkout whose changed source differs from the requested head.

Both commands write their report under the app's `reports/mutation/`. CI uploads
the map, gap list, diff plan, elapsed run time, and mutant results, even on failure.
The GitHub job summary shows plan size, changed/test-mapped/adjacent line counts,
and every omitted range with its reason. A separate table lists every changed
app file outside the mutation scope, including excluded source and generated
files; changed test files are marked as mapped separately. Counts are exclusive: changed lines own
overlaps before adjacent lines and test-mapped spans.
The serial checks in `start-gates.yml` stay unchanged.

CI first builds each app's span map and full diff plan. It then splits the
planned ranges by file into parallel matrix jobs, with no shared services
or writable files. Largest files go first to the least-loaded shard, with stable
file-name ties. Files over the 60-minute target split into bounded range pieces. Every planned
line belongs to exactly one shard. Multiline mutants keep their global owner
line, so a file split cannot count one mutant twice.
Each mutation job uses one worker and a 180-minute deadline. New pushes cancel
the older PR run for that ref. Manual and weekly runs have separate concurrency
groups, so a manual run cannot cancel the weekly report. A failed shard does not
cancel its siblings.

Shard count comes from plan size, aimed at about 60 minutes per shard. The
calibration is PR #3 at concurrency one: 1,814 tested mutants, 220.29 minutes,
7.29 seconds per tested mutant including baseline. Sizing counts every planned
line as one possible mutant and reserves another 200 seconds for each baseline.
The 1,000-line plan splits into three jobs of 334, 333, and 333 lines. These are
estimates, not a time guarantee. A single large file splits by planned ranges at the same line capacity; its
pieces are packed with the other files. Plans above GitHub's 256-job limit fail rather than drop lines.

Each shard reports its score but has no individual score floor. The always-run
`diff-gate` job requires every shard to succeed, rejects missing, duplicate,
foreign or incomplete results, and sums mutant counts separately for each app.
Each app's combined score must reach 60; averaging percentages could hide a
weak result. App configuration floors stay at 60, and unsharded local runs keep
that floor. Weekly full reports and Start's floor are unchanged.
Every changed line stays planned; there is no total line budget or random
source-line sample. Arid/static filtering happens in Stryker. The per-line mutant
cap then applies to all planned sources, with changed-line ranges first. Native
instrumentation includes enclosing statements and merges touching ranges across
source kinds, so multiline mutants at range edges remain eligible. The line cap
uses the original plan and ignores statement neighbors outside its lines. Extra
test-mapped lines have a separate 200-line budget, picked in stable file-and-line
order after changed and adjacent lines own overlaps. Every range left out is
listed in the GitHub summary. The budget never removes changed or adjacent
lines. Sharding never drops changed lines to make a deadline. Weekly full
reports stay uncapped.
The diff job always runs the tool contracts, including config-only
PRs. Third-party actions are pinned to commit SHAs.
Diff runs alone load `scripts/mutation/line-cap.mjs`: at most one eligible mutant
per selected source line. A SHA-256 ordering of relative file, changed line, location,
operator, and replacement makes the choice repeatable, independent of candidate
IDs or arrival order. Multiline nodes belong to their first changed line.
Git lines are one-based and native plan positions are zero-based; the cap converts
both bounds and respects an exclusive end at column zero. The public Stryker
plan event marks other candidates Ignored before execution;
`diff-line-cap.json` records the choices. A cap error suppresses execution and
the diff script rejects a missing selection, error artifact, or report whose
mutant IDs differ from the selection, since Stryker
otherwise logs reporter errors and continues. Weekly full runs do not load this plugin.
This follows the line sampling in
[State of Mutation Testing at Google (2018)](https://research.google/pubs/state-of-mutation-testing-at-google/).

No incremental CI cache is enabled. It can reuse unchanged mutant/test results
on repeat pushes, but a base-SHA key alone does not cover changes in imported
helpers, dependencies, or tooling. Stryker does not detect all those changes,
and its coverage baseline still runs. Safe reuse needs broader cache invalidation;
it does not remove the cost of a first large diff.

## D1: app inputs and direct dependencies

Sync keeps one required tag per app reader, records descriptor, or operation.
Auth imports mandatory sync and mail work directly. Tags remain for host config,
request inputs, cross-root values, and real native/test boundaries. This replaces
the former auth hook-slot and saved-context design.

## D2: commands and host

The defineMain context and clean exit contract above replace the old four-field
main, signal-exit-0, retry-after-start-failure, and outer rethrow guidance. The
host owns process inputs and lifecycle; commands keep their wiring inline.

## D3: tooling and copied updates

Current Start CLI commands are **prepare, doctor, and serve**. Doctor --fix only
repairs its supported glue and generated files; it does not rewrite app wiring.
Per-component registry items already exist. Build their output from the golden
source with the existing registry:build script; never hand-merge generated files.
The released 0.9.0 installer path is recorded in UPGRADE.md.

Planned Start tooling is **add, update, and check**. That CLI will replace whole
owned components and stop when it finds local edits, so the user can review them.
It must protect app source, config, secrets, and command wiring. There is no
automatic merge or working add/update/check command in this source yet.
