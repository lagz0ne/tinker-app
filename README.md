# tinker-app

A Tinker app on TanStack Router and `Bun.serve`.
Vite bundles the browser half. Bun runs the
server half.

Bun is the one runtime. Vite runs on it too
(`bun --bun vp`). No Node is needed: CI runs
every gate with `node` on the path set to fail.

## Start an app

```bash
bunx degit lagz0ne/tinker-app my-app
cd my-app && bun install
```

Pin a release with `#vX.Y.Z`:

```bash
bunx degit lagz0ne/tinker-app#v0.26.1 my-app
```

## Run

```bash
bun run dev    # Vite + bun --hot
bun run check  # tsc, tests, build, checks
bun run build  # page bundle, then one binary
bun run start  # the built server
```

`dev` runs two halves (`cmds/dev.ts`):

```text
browser
   |
vp dev :5173   page, Fast Refresh
   |  /rpc (socket), /api
bun --hot :3001   cmds/api.ts
```

- The socket in dev is Bun's own, as when
  built.
- `PUBLIC_ORIGIN` is Vite's origin in dev.
- Fast Refresh keeps state when a component
  lives in its own module. A file that also
  exports the route tree reloads the page.

`dev` and `start` need three telemetry keys:

- `OTEL_SERVICE_NAME`
- `VICTORIA_TRACES_URL`
- `VICTORIA_LOGS_URL`

A missing one exits 78.
`.env.example` lists the safe defaults.

A hang-up (SIGHUP) stops the host with exit
129, as SIGTERM does. So `nohup bun run start &`
stops when its shell exits. Use `setsid` or a
process manager (systemd, Docker) instead.

Behind a TLS proxy, set `PUBLIC_ORIGIN` (such
as `https://app.example`). rpc calls and tab
telemetry must then come from that origin.

## Checks

`bun run check` runs tsc, the tests, the
build, then `check:client` and `check:tests`.

`bun run test` is `bun --bun vp test`. It has
two projects in `vite.config.ts`:

- `server`: `tests/*.test.ts`, on the Bun
  runtime, so `bun:*` imports work.
- `browser`: `tests/browser/*.test.tsx`, in a
  real Chromium (Vitest browser mode,
  Playwright).

`bun run check:style` is `bun --bun vp check`: oxfmt
and oxlint, with rules in `vite.config.ts`.

`bun run check:plain` runs `tinker-analyze check`,
on Bun (`bun --bun`),
(`@tinkered/analyze`). It reads the files and
prints each broken rule with its rule id, then
the skill to read:

```text
src/a.tsx:3 tinker/react-state `useState`: …

tinker/react-state: hold the state in a Core
  cell and read it with @tinkered/react
  read: @tinkered/react#react
```

- `tinker/plain`: no plain helper functions.
  Every function is an operation or a capsule
  hook. `cn` is exempt.
- `tinker/one-wire`: a page file calls no
  `fetch` or `WebSocket`; the rpc client does.
- `tinker/react-state`: a page file calls no
  `useState`, `useReducer` or `useEffect`.

The app's own exceptions are in
`tinker-analyze.json`, each with its reason:
the entry functions in `tinker/base`, which
run before any scope.

## For agents

`AGENTS.md` tells an agent how to work here.
The Tinker rules ship in the packages as
skills (`@tanstack/intent` lists and loads
them), at the installed version:

```bash
bunx intent list
bunx intent load @tinkered/core#core/operation
```

`.github/workflows/gates.yml` runs all three
on each push to `main`, and weekly.

## One build: a binary

- `build:client`: `bun --bun vp build` to
  `dist/client`. Then
  `scripts/embed-client.ts` writes
  `cmds/client-files.gen.ts`: one
  `with { type: "file" }` import per file.
- `build:server`: `bun build --compile` of
  `cmds/host.ts` and the telemetry worker, to
  one file, `dist/server`.
- The client's files sit inside the binary.
  Nothing is read from disk.
- `--bytecode`: the server ships as bytecode.
  It starts in about half the time.
- `start`: runs `dist/server`, from any folder.
- `check:client`: reads
  `dist/client-meta.json`, the module list a
  small Vite plugin writes
  (`scripts/client-meta.ts`). It fails if a server
  module is among them: a `*.server.ts` file, `src/backend`,
  a server cmd, or a `node:` or `bun:` import.
  The name is the only rule: a server module
  that imports no builtin, such as a module
  resource that loads a server package, must
  end in `.server.ts` (`modules.server.ts`).
- `check:tests`: reads both metafiles. It
  fails if a prod build holds test code:
  `@tinkered/core/testing` or a `*.testing.ts`
  file. See "Test tooling" below.

## Test tooling: a test capsule

A capsule's author ships its test tooling as a
plain capsule (Core ADR 0131). Put it in a
`*.testing.ts` file. Only tests import it.
Its label is `<capsule>.testing`.

```ts
// auth.testing.ts
import { capsule } from "@tinkered/core";

export const authTesting = capsule({
  label: "auth.testing",
  exports: { signInAs },
});
```

```ts
// auth.test.ts
await using app = createScope({
  capsules: [auth({ api: fakeApi() }), authTesting],
});
await app.run(authTesting.signInAs, { input: ANN });
```

- A root with capsules answers each call with a
  promise (Core ADR 0128). A call made during
  start waits for start.
- Code that wants a `Scope.Handle` takes the
  started one: `const live = await app.ready`.
  Its sync calls stay sync.
- Lint makes `no-floating-promises` an error,
  so a call you forgot to await fails `check`.
- `await using` closes the scope at the end of
  the test.
- `check:tests` fails the build if a prod file
  imports a `*.testing.ts` file.

## A feature: one folder, one door

An app is a set of features. Each feature is
one folder in `src/`, with one door:

```text
src/todo/
  contract.ts     todoBoard + todoApi
  ops.server.ts   the server's ops
  todo-list.tsx   the page
  index.ts        door: todo
  index.server.ts door: todoOps
```

```ts
export const todo = capsule({
  label: "todo",
  exports: { board: todoBoard, api: todoApi },
});
```

- `board` is remote data: the live read.
  `todo.board.todos` is a read view, so
  only the feature's own ops write it.
- `api` is rpc: every change is a call.
- Others import `@/todo` only. The server
  also imports `@/todo/index.server`.
- Lint refuses a deeper import
  (`no-restricted-imports`). Inside its
  folder, a feature imports by `./`.
- The cmds install the board and api:
  `todo.board({ serve: true })` and
  `todo.api({ implement: todoOps })` on
  the server; `todo.board({ read })` and
  `todo.api({ remote })` in the tab.
- Precedent: a DDD bounded context, a
  module with one public door.

## A second feature: the issue board

`src/issues/` is a team board at `/issues`.
It shows keyed data with a guard.

- Issues are keyed `{ teamId, id }`.
- Comments are keyed `{ teamId, issueId, id }`.
- A tab reads one team:
  `issues.board.issues.where({ teamId })`.
- Every key starts with `teamId`, so one
  `onStart` hook guards every part.
- A part has its own state:
  `useData(issues.board.status(read))` is
  `pending`, `ready` or `fault`.
- A non-member's read is refused. That is
  the server's answer, so the client does
  not ask again by itself. "Try again"
  runs `issues.board.invalidate` with the
  part, so a person added later sees the
  team. Only a broken link heals by itself.
- The guard reads its part, typed:
  `issueBoard.part(input)?.teamId`.
- A move names the version it saw. A newer
  version answers `stale`, as output.
- Sign-in is a stand-in: a name in each
  message's meta (`whoMeta`). No password.
- Every cell is served. A cell that is not
  served is a copy per session, so a
  call's write to it ends with the call.
  `cell.atScope.controller` writes the root.
- Choose the key from the reads, as a table's
  primary key: each read is some fields of
  the key, and the guard's field is in it.
- A fault says who spoke (`Fault` in
  `board.tsx`): `from` is `"server"` or
  `"local"`.
- The server's answer: `refused` says why,
  `missing` says the page is old, the rest
  shows a ref. The same ask gives the same
  answer, so nothing asks again.
- `link` is local: no answer. A read is
  asked again by itself. A call is not.
  `sent: false` means nothing left. Else
  the call may have run, so the page says
  "It may be saved" and the person looks.
  The ref is the trace id; the cause is in
  that trace on the server.
- A server that goes away ends the open
  reads as `link`: the board says "Offline.
  Trying again." in place of the form.
- A throw in a transport is a bug, not
  `link`: it shows as `failed`, from local,
  with the cause in the log.
- An op that writes two cells checks first
  and writes last, with no `await` between
  the writes. Cells have no transaction; a
  store has one.
- The data is in memory: a restart loses it.
  A real app keeps it in a store, behind a
  `load`.

```ts
issues.board({
  serve: true,
  onStart: [signedIn, membersOnly],
});
```

## rpc and remote data: one transport

The decision: `docs/decisions/remote-data-and-rpc.md`.
The client and the server run the same handle.

- `src/greet/contract.ts`:
  `greetApi = rpc({ greet: {...} })`.
  A key has an `input` and an `output` shape.
- `src/greet/greet.server.ts`: the work.
- `cmds/server.ts`: `greet.api({ implement })`,
  and `ws.server({ path: "/rpc", services })`.
- `cmds/browser.tsx`: `ws.client({ url })`,
  and `greet.api({ remote: ws.client })`.
- A key with no implementation fails start
  with `MissingConfig`.
- A failure is a fault from a fixed set:
  `refused`, `failed`, `invalid`, `encode`,
  `decode`, `link`. `greet.api.fault.is(e)`
  tells.
- A server throw is `failed`. Its cause stays
  in the server log.
- `remoteData({ cells })` reads server cells
  on the client. `board.faults` holds each
  key's last fault, as data.
- A socket frame over `maxPayload` (1 MiB
  unset) closes the socket (1009).
- A socket from a foreign `Origin` gets 403.
- Bytes go on their own POST beside the
  socket: see "Bytes, in code".
- `memory` is the same protocol in one
  process, for tests.

- Each implementation runs in its own layer
  (a call with a `signal`). A `tx` it joins
  commits when it returns, and rolls back
  when it throws.

### The layers

- transport: text (`ws`, `memory`).
- protocol: codec, envelope, faults, the
  lifecycle's hooks. Shared code, not a
  capsule.
- rpc and remoteData: values.

### rpc, in code

One definition, both sides:

```ts
export const api = rpc({
  greet: {
    input: z.object({ name: z.string() }),
    output: z.object({ text: z.string() }),
  },
});
```

The server installs it with `implement`:

```ts
capsules: [
  api({ implement: { greet: greetHere } }),
  ws.server({ path: "/rpc", services: [api] }),
],
```

The tab installs it with `remote`:

```ts
capsules: [
  ws.client({ url: "wss://app.example/rpc" }),
  api({ remote: ws.client }),
],
```

An op calls `api.greet` the same way on
either side.

### Bytes, in code

A file is one field of a key's input:

```ts
"file.put": {
  input: z.object({
    name: z.string(),
    file: bytes(z.custom<RpcBody>(), {
      max: 10 << 20,
    }),
  }),
  output: z.object({ id: z.string() }),
},
```

- The tab passes a `Blob` (a `File`).
- The key then goes as `POST /rpc/file.put`.
- The rest of the input rides in `x-input`.
- The implementation gets `file`: read it
  once, with `bytes()`, `text()` or
  `stream()`. It is read only then.
- `types` lists the content types it takes
  (`application/octet-stream` unset). A Blob
  of another type goes as the first one.

The server checks, before one byte is read:

- 404: the key has no bytes field.
- 403: a foreign `Origin`.
- 400: no `x-input` (a cross-site form
  cannot set it without a preflight).
- 431: `x-input` or `x-meta` over 2 KiB.
- 415: a type the key does not list.
- 413: `Content-Length` over `max`.
- 503 + `Retry-After`: `maxUploads` (8) run.

Then:

- `onStart` runs first: a refusal never
  reads the body.
- The stream is counted: past `max` is 413,
  whatever `Content-Length` said.
- `uploadDeadline` (5 min) cuts a slow body.
- Bun's `maxRequestBodySize` is the largest
  `max` (1 MiB at least): `cmds/server.ts`.
- `memory` carries the Blob as it is.

### remoteData, in code

The passed cell is a shape. Each definition
makes its own cells:

```ts
const todos = data({ initial: [] as string[] });
export const board = remoteData({ todos });
```

- Server: `board({ serve: true })`. An op
  writes `todos.controller`; the capsule
  copies the write and pushes it.
- Tab: `board({ read: ws.client })`, then
  `useData(board.todos)`. Read only.
- `board.faults`: each key's last fault, as
  data. A read never throws.

### A keyed cell: one member per change

The todo list is keyed. A write sends the
member it changed, not the list:

```ts
const todos = data({
  label: "todo.list",
  mode: "keyed",
  parse: todo,
  key: (t) => ({ id: t.id }),
});
```

- Read all: `todo.board.todos.where({})`.
- Read one: `todo.board.todos.of({ id })`.
- The list maps ids to `<TodoRow id />`.
  Each row reads `of({ id })`, so a toggle
  draws one row.
- A part inside a part in use opens no new
  stream: it rides that one.
- Write on the server: `set`, `update`,
  `delete` on `todos.controller`.
- Data in a database: give the board a
  `load` op. A projector reads the store's
  notices and calls `invalidate`.
- A store with no notices tells a second
  client only through the op: it calls
  `invalidate` after its commit.
- Guide: tinkered `docs/keyed-projector.md`.

### remoteData per project: `config`

A definition takes a `config` of your own
tags, as a capsule does. Each becomes a tag
on the instance:

```ts
const board = remoteData(
  { tasks },
  { config: { project: projectTag } },
);
```

- Tab: bind it where it fits, on the root,
  a session, or a namespace:
  `createSession({ tags:
[board.project("p1")] })`.
- That session reads p1's list. Two
  sessions on p1 share one watch.
- Server: `board({ serve: true, fill })`.
  `fill.tasks` is an op that reads
  `board.project` and gives the first value.
- A write runs in a call tagged with the
  project. It pushes to that project only.
- A keyed write with no project bound fails
  with `MissingTag` before it runs.
- The tag's own `parse` checks the value on
  the server; a `use` step there sees the
  parameter in its input.
- A watch's text is at most 2 KiB
  (`watchTextMax`), on every transport.

### The lifecycle: hooks and `refused`

A hook is a plain operation on one of the
hook shapes: `hook.start`, `hook.success`,
`hook.error`, `hook.finish`. Core has them:
`const { hook } = transport`. A capsule lists
them, and a list runs in order. `onStart`
binds the caller, or says no with `refuse`:

```ts
const signedIn = operation({
  label: "signedIn",
  input: hook.start,
  depends: { who: principal },
  run: async ({ who }, { input }) =>
    who
      ? { tags: [user(who)] }
      : input.refuse({ signIn: true }),
});
```

- `onStart: [signedIn]` on `api(...)` runs
  for every key, on either side.
- `implement: { key: { run, onStart } }`
  adds to it for one key. `inherit: false`
  drops the capsule's lists.
- A refusal is the `refused` fault, with its
  payload (as HTTP 401/403), and `onError`
  does not run.

`onError` may let the error stand, refuse, or
answer a value: recovery.

```ts
const refusedAsFault = operation({
  label: "refusedAsFault",
  input: hook.error,
  run: async (_, { input }) =>
    input.refuse({ kind: Object(input.error).kind }),
});
```

`onSuccess` gets the output the output shape
has already checked: a field the schema
strips never reaches it. A stream has no
one output, so `onSuccess` does not run for
it.

`onStart` may leave a context for the later
hooks, and `onFinish` reads the outcome:

```ts
const timing = operation({
  label: "timing",
  input: hook.start,
  run: async (_, { clock }) => ({
    context: { t0: clock.currentTimeMillis() },
  }),
});
const timed = operation({
  label: "timed",
  input: hook.finish,
  run: (_, { input, clock, log }) =>
    log.info("call", {
      key: input.key,
      ms: clock.currentTimeMillis() -
        Number(input.context.t0),
      outcome: input.outcome.kind,
    }),
});
```

`retry` names fault kinds and counts:
`{ link: 2 }` runs the work again at most
twice after `link` faults. Only the work runs
again; the hooks run once. No default: a
write is never sent twice.

```ts
api({
  remote: ws.client,
  retry: { link: 2 },
  onStart: [signedIn],
  onError: [refusedAsFault],
  onFinish: [timed],
});
```

remoteData still takes a `use` list for now:
its half of the lifecycle is an open point.

### Tests: the memory transport

The same protocol in one process. `memory`
comes from `@tinkered/core/testing`. A peer is
a started scope, so wait for `ready`:

```ts
const server = await createScope({
  capsules: [
    board({ serve: true }),
    memory.server({ services: [board] }),
  ],
}).ready;
const tab = await createScope({
  capsules: [
    memory.client({ peer: server }),
    board({ read: memory.client }),
  ],
}).ready;
```

### A write that must outlive its call

Core 0.12.0: the edge picks the layer. A
token cache that `renew` fills in a call
with a `signal` writes the root:

```ts
depends: { t: token.atScope.controller },
```

- `cell.controller`: the caller's layer.
- `cell.atNamespace.controller`: the root,
  in the caller's namespace.
- `cell.atScope.controller`: the root, no
  namespace.

The client sends a W3C `traceparent` in each
message's meta, so the server's span is the
child of the client's `ws.send` span.

## Database: Drizzle

Off by default. Two capsules per database:
a driver owns the client, a facade gives
Drizzle to your operations. Bun first.

- `drizzlePg`: Postgres dialect. Drivers:
  `bunSql` from `@tinkered/bun/sql` (Bun.SQL),
  `pglite` (tests).
- `drizzleSqlite`: SQLite dialect. Driver:
  `bunSqlite` from `@tinkered/bun/sqlite`.
- The facade exports `db`, `tx`, `migrate`.
- Start runs `migrate` from the drizzle-kit
  folder (default `drizzle/pg`).
- No driver: a type error, and `MissingConfig`
  when the root starts.

In `cmds/server.ts`:

```ts
capsules: [
  bunSql({ url: new URL(env.DATABASE_URL) }),
  drizzlePg({ driver: bunSql.connection }),
  // ...rpc, routes
],
```

In a test, swap the driver:

```ts
capsules: [
  pglite(),
  drizzlePg({ driver: pglite.connection }),
],
```

An operation:

```ts
depends: { tx: drizzlePg.tx },
run: async ({ tx }, { input }) =>
  tx.insert(notes).values(input),
```

Transactions follow Spring's propagation
words, with a session as the boundary:

- **Join** (default): depend on `tx`. Every
  op and subflow in one session shares one
  transaction.
- **Own**: run a subflow with `signal`. It
  gets its own session, so its own
  transaction. It commits even if the
  caller fails later. The caller must not
  depend on `tx` itself (SQLite and PGlite
  have one writer: that would wait forever).
- **Boundary**: a transaction needs a
  session that a call owns: a request, an
  rpc call, a call with `signal` or `tags`,
  or `createSession()`. A plain root run
  that touches `tx` fails with
  `TransactionNeedsSession`.
- At the session's end: success commits;
  a failure rolls back. A forced close
  rolls back; a graceful close commits.

- Pick one dialect: a Drizzle schema is
  `pgTable` or `sqliteTable`, not both.
  Auto migration (dev):

- Add `drizzle.config.ts` at the app root.
  More than one dialect:
  `drizzle.<name>.config.ts`.
- `bun run dev` runs `bun run db:generate`
  first: drizzle-kit writes a migration when
  the schema changed, and nothing when not.
- Start then applies it. So does prod, from
  the same files. Commit them.
- No config: no database, the step does
  nothing.
- A schema edit while dev runs needs a dev
  restart (or `bun run db:generate`).
- A rename makes drizzle-kit ask you in the
  terminal: rename, or drop and add.

## Where things are

- `cmds/server.ts`: the root. The `serve`
  capsule goes first: it listens once the
  socket and the table have started.
  `/api/*` and `/rpc/*` go to the handlers.
  To add more, pass `paths: ["/mcp"]`.
- `cmds/pages.ts`: the client files in the
  binary, as `serve`'s pages.
- `cmds/browser.tsx`: the tab root and the router.
- `cmds/host.ts`, `cmds/api.ts`: `run(main)`
  from `@tinkered/bun`, the host. It owns the
  signals and the exit code.
- `tinker/base/main-host.ts`: `runMain`, the
  host for a command with no port, such as an
  import. Same exit codes as `run`.
- `rpc(contracts)`, `remoteData(cells)` and
  `transport` (the envelope, the faults, the
  codec) come from `@tinkered/core`.
- `@tinkered/bun/client`: `ws.client`;
  `@tinkered/bun`: `ws.server`. One socket per client. The
  messages of one tick go as one frame, both
  ways.
- `memory` from `@tinkered/core/testing`: the
  in-process transport, for tests.
- `tinker/components/requests`: the `routes`
  capsule. A route is any operation. A stream
  route calls `routes.reply` with its Response,
  then runs until the body ends.
  A subflow the op does not await gets its
  signal aborted when the run ends. To keep
  work going past the reply, use `reply` and
  await the work in the op.
  Only the first reply counts. A second
  `reply` is dropped. A Response the op
  returns after `reply` is dropped, and its
  body is cancelled.
  Close or error a reply stream in a
  `finally`: if the op throws first, the
  client waits for the 60 s idle timeout.
- `tinker/components/telemetry`: the sink
  capsules. The tab's batch route runs quiet
  (`routes.ns`): taking a batch makes no span
  or log line, a refused one included.
- `tinker/components/drizzle-pg`,
  `drizzle-sqlite`: the Drizzle facades.
- `tinker/components/pglite`: the test
  driver. The Bun drivers are in
  `@tinkered/bun/sql` and `@tinkered/bun/sqlite`.
- `scripts/`: `check-client`.
- `tests/`: test files for rpc, remote
  data, the transports, routes, trace, health,
  drizzle and telemetry ingest,
  plus `tests/main-host.test.ts` (the
  host), `tests/server.test.ts` (the server
  command) and `tests/build-client.test.ts`
  (the client build). The Bun.sql tests run
  when `PG_URL` is set.
- The idle test holds a stream quiet for 16 s.
  Bun checks idle timeouts about every 4 s, so
  a shorter gap passes without the fix.

Components in `tinker/components/` are plain
folders. Edit them in place. There is no
`tinker` CLI, registry or `components.lock`
any more.

## Known limits

- Bun HMR breaks TanStack Router (a null module
  in `router-core`), so HMR is off. Reload the tab
  after an edit.
- No server render.
- The tab does not check a reply's shape.

## Releases

This repo only: after green gates on `main`, CI
tags `v<version>` from `package.json`, when that
tag is missing. Bump `version` to release. In a
copy, `release.yml` skips; delete it if you like.
`trunk-status.yml` opens an issue when your own
`main` goes red; delete it if you do not want it.

## Where Start went

Start, the loop, the Start apps and the `tinker`
CLI were removed on 2026-11-01.
They live in the tag `start-archive`.
`main` is the only branch.
Old versions live in tags: `small-v*`,
`demo-v*`, `start-v*`, `start-archive`.

```bash
git checkout start-archive
bunx degit lagz0ne/tinker-app#start-archive old-start
```
