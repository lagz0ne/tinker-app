# Start scaffold

One TanStack Start app with separate backend and frontend modules.
Only Core and React come from Tinker.
Production uses Postgres, Drizzle, Better Auth, SMTP, and Pino.
There is no database picker or SQLite path.

## Try the proof

From the repo root:

```bash
vp install
vp run @tinker/core#build
vp run @tinker/react#build
vp run @tinker-start-scaffold#dev
```

Open `http://localhost:4318` in two tabs.
Increase the shared counter without signing in.
Make an account and open your profile or private list.
Save a name and watch the name on your todo page change.
Unsaved text in another profile editor stays there.
Add, finish, or delete a todo.
Each account has its own private list.
Sign out and use a second account in the same tab.

The dev command sets `START_PROOF_MODE=1`.
That uses the PGlite proof adapter and recorded mail.
PGlite runs Postgres in memory; restarting clears the proof data.
Recorded mail sends nothing to an inbox.
Production resource factories always use `pg` and SMTP.
The proof preset module loads with the server seam.
PGlite loads only when its factory runs in proof mode.

`HOST` and `PORT` set the local address.
Proof auth accepts localhost, loopback, and `*.tini.works`.
`PUBLIC_ORIGIN` can pin the scheme and host in the URL.

## Setup and your files

- `src/scaffold/` owns Start lifetime, middleware, sync, and Pino observation.
- `src/backend/` owns clients, tables, auth rules, and server operations.
- `src/contracts/` owns input readers, changes, and result shapes.
- `src/frontend/` owns saved records, drafts, actions, and views.
- `src/transport/` connects feature operations to native server functions.
- `src/routes/` declares public pages and private page guards.
- `src/start.ts`, `src/router.tsx`, `src/server.ts`, and `src/client.tsx`
  connect setup at the filenames Start expects.
- `drizzle/` contains the checked-in Postgres migrations.

The fixed setup reaches your values through two files.
`src/lib/tinker.ts` re-exports browser values and input readers.
`src/lib/tinker.server.ts` re-exports server resources, settings, and proof presets.
Both files belong to you and are installed once.
The browser file fills the fixed `Register` with your change, result, and snapshot types.
The fixed code owns the envelope: stream, revision, execution ID, and change/result kind.
Your readers check feature bodies at the network door.
Saved JSON bodies stay unknown to the fixed tables.
Your transport maps your errors to messages.

The database is a userland resource.
It loads native libraries inside its factory and closes its client with the scope.
Current user is a request resource.
Operations own actions; data holds mutable records and local state.
Tags inject fixed settings.
Input readers infer operation input and context types.
Feature code receives values, never a scope or context bag.

The same middleware object is global and attached to functions and server routes.
Start runs shared request middleware once.
The Core extension binds the server root into native fetch context.
Middleware opens a request session and retains it until the body ends or is cancelled.
An unbound request fails with `StartScopeMissing` before work starts.
There is no AsyncLocalStorage or global current scope.
Middleware stays separate from server-function modules to keep its identity.

Start import guards reject backend files and server libraries in the browser build.
Native libraries load only when their declared resource or action runs.
The shadcn source lives in `src/frontend/ui/`.
Style follows the [Start guide](https://ui.shadcn.com/docs/installation/tanstack).
`src/routeTree.gen.ts` is generated; do not edit it.

## Saved data and mutation

The public counter, private profile, and private todos use the same flow.
A mutation returns an execution ID or an early refused result.
The browser creates the request ID before sending; the server acknowledges that ID.
This registers the local wait before an event can arrive.
A lost reply can retry the same ID without repeating the saved write.

Saved records change only through sync.
The server stores a saved change and its event in the same transaction.
A short per-stream lock orders revisions by commit, not sequence allocation.
Bootstrap reads a snapshot and its cursor under that same lock.
Postgres NOTIFY wakes one shared LISTEN connection after commit.
Native SSE reads saved events and replays missed revisions.
The listener subscribes before the first read, so a commit cannot fall between read and wait.
A reconnect uses the last applied cursor and checks the current account.
The same account keeps its cursor; a changed account gets a new snapshot.
Core owns the stream, clock, original stop signals, and cleanup.
A heartbeat checks auth and keeps HTTP open; it does not poll changes.
The stream closes when its request, backend, or database listener ends.

A local operation waits for its final event.
Sync applies saved changes before resolving that wait.
Remote events update the same records without a local promise.
Old replay and older snapshots cannot replace newer records.
Local dirty text stays separate from saved data.
Private responses from an old account are ignored.
Sign-out and tab exit stop local waits.
Closing a browser wait does not undo a committed server write.

A todo or counter is complete at commit.
A profile save requires commit plus notification acceptance.
The saved name is usable while mail is pending.
Mail failure yields a partial result with the saved profile ID and named failure.
Retry sends the notification; it does not save the name again.
Mail runs outside database transactions.
A root-owned resource retains work after a request exits.
It coalesces concurrent sends for one execution ID within one process.
Stored results serve later repeated requests.

## Copy and update through the registry

[Registry ownership and install commands](../../docs/roadmap/start-scaffold/REGISTRY.md)
describe the copy flow.

- `runtime` copies only `src/scaffold/` and has no userland dependency.
- `postgres-auth-mail-example` copies the chosen services and sample features once.
- `starter` composes both items and native entry/config files for first setup.

The registry copies into a Start project with this app's package prerequisites.
Core and React are workspace packages; this proof does not publish them to npm.
The registry does not install another runtime framework.
Review a dry run before overwriting setup.
Never overwrite the example item to update setup.
Setup contract 3 needs these changes before a runtime update:

- Add `src/lib/tinker.ts` and `src/lib/tinker.server.ts`.
  Fill `Register` in the browser seam with your feature types.
- Import `readReceipt` from your own `src/transport/result.server.ts`.
- Remove the sync table definitions from `src/backend/sync.schema.ts`.
  Backend files import `stream`, `execution`, and `event`
  from `../scaffold/backend/sync.schema.ts`.
- Build feature readers on the envelopes in `src/scaffold/sync.ts`.

The registry puts them in the consumer's configured `lib` folder.
shadcn 4.21.0 skips import rewriting for `registry:file`.
Fixed TypeScript files that import the seams use `registry:lib` with fixed targets.
The copy test changes the alias to `@/app-lib`, then builds and checks types.
Both edited seam files survive the runtime update.

Build and check the actual registry with:

```bash
vp run @tinker-start-scaffold#registry:build
vp run @tinker-start-scaffold#test:registry
```

## Checks

```bash
vp run -r build
vp check
vp run @tinker-start-scaffold#test
vp run @tinker-start-scaffold#test:boundary
vp run @tinker-start-scaffold#test:middleware
vp run @tinker-start-scaffold#test:imports
vp run @tinker-start-scaffold#test:seam
vp run @tinker-start-scaffold#test:seam:fixture
vp run @tinker-start-scaffold#test:schema
```

Tests call exported operations through small Core scopes.
They use real Better Auth, Drizzle, and a Postgres engine.
Mail presets behave as a sending client, including failed or held sends.
Domain tests do not boot the Start stack.

- Real accounts can sign up, sign in, sign out, and save a profile.
- Signed-out private writes open no transaction.
- Refused work leaves the server root usable.
- Failed transactions keep the old saved data and publish no saved change.
- A native commit failure never returns a saved profile.
- Auth email check and reset callbacks invoke the mail operation.
- Accounts can read and change only their own todos and event stream.
- Guessing another account's todo ID cannot change or delete it.
- Empty titles and caller-selected owners are refused.
- Concurrent public writes replay in commit order.
- Repeated execution IDs do not repeat saved effects.
- A result arriving before its receipt waits until saved records are applied.
- Replayed events and older snapshots keep newer records and dirty drafts.
- Account exit stops waits and ignores a late old response.
- Failed mail preserves the saved name and retry sends only mail.
- Committed profile work finishes after its request exits.
- Saved names remain readable while duplicate requests share one pending send.
- Unbound middleware fails before calling its next step.
- Shared global, route, and function middleware runs once per request.
- Concurrent native renders keep their request headers and sessions apart.
- A body ending or being cancelled closes its session and active work.
- Browser import guards and cold backend imports protect the build split.
- A stream checks the session once at open and once for the next wake.
- A signed-out private redirect and its public loader share one snapshot.
- Sign-in, an old stream account event, and route loads fetch one signed-in snapshot.
- Commit wakes SSE; rollback publishes no wake.
- SSE replays saved events and refuses another account's cursor.
- A revoked session receives no queued private rows.
- A final result replay completes a local wait after disconnect.
- Finished operation traces and Pino logs reach their HTTP receivers.
- Telemetry storage failure keeps bounded records for retry.
- Browser ingest refuses foreign origins, bad shapes, and oversized bodies.
- Stalled uploads and storage requests stop with their owner.

The separate middleware proof builds a small native Start app.
It keeps framework checks out of the operation seam tests.
The registry proof copies exact source with the real shadcn CLI.
Its dry run changes no file.
A setup update keeps an edited feature intact.
The installed consumer then builds and passes its type check.

## Local trace and log storage

Run the local Victoria stack from this app folder:

```bash
docker compose -f compose.victoria.yml up -d
```

VictoriaTraces listens on `127.0.0.1:10428`.
VictoriaLogs listens on `127.0.0.1:9428`.
Both keep seven days of data in named Docker volumes.
The app defaults to these local endpoints.
Set the three telemetry values in `.env.example` to use another host.
Storage URLs stay on the server.

Core supplies spans and trace IDs; Pino writes logs on both sides.
The server sends OTLP JSON to VictoriaTraces and JSON lines to VictoriaLogs.
The browser sends a bounded batch through the same-origin Start route.
The route checks origin, size, shape, and browser source before accepting it.
Production checks the configured `PUBLIC_ORIGIN`, including behind an HTTPS proxy.
Only the isolated proof accepts its localhost or HTTPS preview request origin.
A separate Core root owns export work, so exporting does not trace itself.
Config is a tag; the queue is a resource; export is an operation.
Export health is data with idle, queued, sending, failed, and closed states.
Failed delivery retains records for retry within the queue limits.
The queue holds at most 512 records or 1 MiB.
It sends at most 64 records or 48 KB per batch.
Close gives export a bounded final flush, then releases retained records.
Storage failure changes export health; it does not fail a saved user action.

## Live services

Fill `.env.example` with your values and load them into the server environment.
Leave `START_PROOF_MODE` unset.
From this app folder:

```bash
vp build
vp run start
```

Startup applies the checked-in Drizzle migrations.
Better Auth and feature writes use the same database.
The Node host stops accepting requests before closing Core roots.
SMTP acceptance means the server accepted mail, not that it reached an inbox.
Network Postgres and SMTP delivery have not been tested in this local proof.

## Limits

The current event history has no retention policy.
SSE recovers stored events; it is not a durable background job queue.
A server crash after commit can leave a notification without its final result.
A crash after SMTP acceptance can cause a resend before the final result is stored.
The in-process send map does not promise one send across several server processes.

The dev panel shows bounded snapshots of completed Core spans.
It does not show every live node, call, data write, or React mount.
Core does not yet expose that full live graph.
The panel is omitted from production builds.
Pino uses its native browser entry in the frontend.
Logs retain safe fields and span IDs, excluding credentials and mail links.
Core spans export directly as OTLP JSON; there is no second tracer or collector.
Victoria storage failure can drop records when the queue fills or closes.
Cross-side trace propagation is still pending.
Auth SDK internals are not separate Core spans.
A host must consume or cancel responses to release their retained request work.
