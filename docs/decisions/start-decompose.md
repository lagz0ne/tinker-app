# Current Start authoring contract

This is the contract for the current source, including changes after Start 0.9.0.
The released 0.9.0 contract stays in [UPGRADE.md](../../packages/start/UPGRADE.md#090).
The golden copied source is `apps/start-scaffold/tinker/`; the small app shares
its base and selected components. Core and React stay at 0.8.0. Do not patch Core.

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
  signal: AbortSignal;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  exit: (code: number, reason?: unknown) => void;
};
```

Main returns a closed promise; a server also returns fetch. Importing a command
starts nothing. Commands read no process globals and load no env file. The host
owns those inputs. Follow the actual [small server](../../apps/start-min/cmds/server.ts)
or [board commands](../../apps/issue-board/cmds) for complete wiring.

Only the command chooses its error code: operations return results or raise
errors. An outer catch calls exit(code, error), then returns a stopped result.
It does not rethrow or print that error again. Internal catches may rethrow to
join cleanup. Close the app before telemetry; use checkClosed for root results.

Exit is a clean stop. The host keeps the first code, aborts signal, joins closed,
flushes stdout/stderr, and sets process.exitCode. It never calls process.exit.
It prints a saved failure immediately and each distinct late failure once.
A grace deadline of 10 seconds is the only hard stop. SIGINT is 130; SIGTERM is
143, even if a later error asks for 1. Other codes are 0 success, 1 unexpected
error, 64 bad args, 65 bad data, 75 temporary failure, and 78 bad startup config.

Vite names serverEntry, routerEntry, and startEntry. Apps with a worker or CLI
also name workerEntry and cliEntry and provide matching vite.worker.config.ts
or vite.cli.config.ts with literal build.ssr and build.outDir. Doctor and build
check those exports/configs. gate:commands builds and runs each process entry
serially, proving its unknown-input exit and joined close without live services.
The real app tests and live proofs exercise configured startup and work paths.

Prod awaits main before listening and checks fetch. Dev shares one startup and
closes on HMR replacement. **A command exit closes the dev server. Fix startup
config, then restart `vp dev`.** A returned stopped server response is 503
Command stopped; the host prints the error.

### Write calls

New board multi-step writes use one owned child call with a real signal. The
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

The old counter, todos, and profile demos still await native transactions.
They are migration work, not examples of the new session transaction. Auth's
single pool hooks and its mail queue are also separate from the board outbox.
See [the migration list](../../apps/issue-board/maintain/REFACTOR.md).

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
including check-plain --prove after changing its rules. The copied runtime's
mutation floor stays 85; the lander runs mutation checks.

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
