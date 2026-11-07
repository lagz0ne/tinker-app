# tinker-app

A Tinker app on TanStack Router and `Bun.serve`.
Two builds, one per side.

## Start an app

```bash
npx degit lagz0ne/tinker-app my-app
cd my-app && bun install
```

Pin a release with `#vX.Y.Z`:

```bash
npx degit lagz0ne/tinker-app#v0.19.3 my-app
```

## Run

```bash
bun run dev      # dev server, Bun bundles on request
bun run check    # tsc, tests, both builds, check:client
bun run build    # both builds, then the client check
bun run start    # the built server
```

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

`bun run check` runs tsc, `bun test`, both
builds, then `check:client`.

`bun run check:style` is `vp check`: oxfmt
and oxlint, with rules in `vite.config.ts`.

`bun run check:plain` bans plain helper
functions. Every function is an operation or
a capsule hook. `cn` and `defineMain` are
exempt. So are the definition makers (`rpc`,
`remoteData`, `createSse`, `createMemory`):
they run at module load, before any scope. A module resource (a `resource` whose
factory returns `import("<package>")` on every
return) counts as a library: the options you
pass to it are native. `ReadableStream` and
`Proxy` count only as a direct
`new X({...})`, not through a const.

`.github/workflows/gates.yml` runs all three
on each push to `main`, and weekly.

## Two builds

- `build:client`: `cmds/index.html`, browser
  target, to `dist/client`, with a metafile.
  `--public-path=/` makes `index.html` load
  its files from `/`, so a deep link such as
  `/a/b` works.
- `build:server`: `cmds/host.ts` and the
  telemetry worker, Bun target, to `dist/server`.
- `check:client`: reads the client metafile.
  It fails if a server module is in the client
  build: a `*.server.ts` file, `src/backend`,
  a server cmd, or a `node:` or `bun:` import.
  The name is the only rule: a server module
  that imports no builtin, such as a module
  resource that loads a server package, must
  end in `.server.ts` (`modules.server.ts`).

## rpc and remote data: one transport

The decision: `docs/decisions/remote-data-and-rpc.md`.
The client and the server run the same handle.

- `src/api/`: `api = rpc({ greet: {...} })`.
  A key has an `input` and an `output` shape.
- `src/backend/`: the implementations.
- `cmds/server.ts`: `api({ implement })`, and
  `sse.server({ base: "/rpc", services })`.
- `cmds/browser.tsx`: `sse.client({ base })`,
  and `api({ remote: sse.client })`.
- A key with no implementation fails start
  with `MissingConfig`.
- A failure is a fault from a fixed set:
  `refused`, `failed`, `invalid`, `encode`,
  `decode`, `link`. `api.fault.is(e)` tells.
- A server throw is `failed`. Its cause stays
  in the server log.
- `remoteData({ cells })` reads server cells
  on the client. `board.faults` holds each
  key's last fault, as data.
- A call body over `maxBody` bytes (1 MiB
  unset) answers 413, and no implementation
  runs. A body with no length is read only up
  to it. `maxBody` is a positive whole number,
  or `Infinity` for no cap. NaN, 0, -1 or 1.5
  fail start (`DataValidationFailed`, exit 78).
- A request with a foreign `Origin` answers 403.
- `memory` is the same protocol in one
  process, for tests.

- Each implementation runs in its own layer
  (a call with a `signal`). A `tx` it joins
  commits when it returns, and rolls back
  when it throws.

### The layers

- transport: bytes (`sse`, `memory`).
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
  sse.server({ base: "/rpc", services: [api] }),
],
```

The tab installs it with `remote`:

```ts
capsules: [
  sse.client({ base: "/rpc" }),
  api({ remote: sse.client }),
],
```

An op calls `api.greet` the same way on
either side.

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
- Tab: `board({ read: sse.client })`, then
  `useData(board.todos)`. Read only.
- `board.faults`: each key's last fault, as
  data. A read never throws.

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
`hook.error`, `hook.finish`. A capsule lists
them, and a list runs in order. `onStart`
binds the caller, or says no with `refuse`:

```ts
const signedIn = operation({
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
  input: hook.start,
  run: async (_, { clock }) => ({
    context: { t0: clock.currentTimeMillis() },
  }),
});
const timed = operation({
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
  remote: sse.client,
  retry: { link: 2 },
  onStart: [signedIn],
  onError: [refusedAsFault],
  onFinish: [timed],
});
```

remoteData still takes a `use` list for now:
its half of the lifecycle is an open point.

### Tests: the memory transport

The same protocol in one process:

```ts
const server = createScope({
  capsules: [
    board({ serve: true }),
    memory.server({ services: [board] }),
  ],
});
const tab = createScope({
  capsules: [
    memory.client({ peer: server }),
    board({ read: memory.client }),
  ],
});
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

The client sends a W3C `traceparent` header,
so the server's span is the child of the
client's `sse.send` span.

## Database: Drizzle

Off by default. Two capsules per database:
a driver owns the client, a facade gives
Drizzle to your operations. Bun first.

- `drizzlePg`: Postgres dialect. Drivers:
  `bunSql` (Bun.sql), `pglite` (tests).
- `drizzleSqlite`: SQLite dialect. Driver:
  `bunSqlite` (bun:sqlite).
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

- `cmds/server.ts`: the root, rpc, the table.
- `cmds/browser.tsx`: the tab root and the router.
- `cmds/dev.ts`, `cmds/host.ts`: `Bun.serve` for
  dev and for the build.
  `/api/*` and `/rpc/*` go to the server
  command. To add more, pass a third argument:
  `serveMain(main, pages, { paths: ["/mcp"] })`.
- `tinker/base/main-host.ts`: `runMain`, the
  host for a command with no port, such as an
  import. Same exit codes as `serveMain`.
- `tinker/components/protocol`: the envelope,
  the faults, the codec use, the route table.
- `tinker/components/sse`: `sse.client`
  (`index.ts`), `sse.server` (`index.server.ts`).
- `tinker/components/memory`: the in-process
  transport, for tests.
- `tinker/components/rpc`: `rpc(contracts)`.
- `tinker/components/remote-data`:
  `remoteData(cells)`.
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
- `tinker/components/bun-sql`, `bun-sqlite`,
  `pglite`: the drivers.
- `scripts/`: `check-client`, `check-plain`.
- `tests/`: `bun test` files for rpc, remote
  data, the transports, routes, trace, health,
  drizzle, telemetry ingest and `check-plain`,
  plus `tests/serve-main.test.ts` (the Bun
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
npx degit lagz0ne/tinker-app#start-archive old-start
```
