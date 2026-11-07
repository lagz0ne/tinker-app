# Remote data and rpc ride one transport

Date: 2026-11-06. Status: accepted shape;
implementation open.
Accepted: Duke, step by step, 2026-11-05 23:41
to 2026-11-06 15:37 UTC (quotes below).

Builds on: tinkered ADR 0048 (sync words:
transport, codec), 0050 (hooks as an onion),
0077 (the SSE transport), 0089 (resolve hook
limits), 0090 (a call runs in a child session),
0123 (the edge carries the rule; read views),
0126 (an edge picks the layer a write lands on).

## What Duke said

- 11-05 23:41: two capsules. One for calls, one
  for remote data. "User just need to use".
- 01:50: a remote call is an address, a request
  shape, a response shape. Two sides: the
  client sends, the server fulfills with
  operations.
- 02:29: one definition makes the capsules.
  Input and output must cross the wire.
- 02:31: the codec is an option, JSON by
  default. Same for remote data.
- 02:42: middleware in two places, the capsule
  (all keys) and one key. "Very similar to
  TanStack Start".
- 03:04: no client/server magic split. A
  middleware is made with Core parts.
- 04:09: a key's own middleware lives in the
  service's `implement` entry.
- 04:15: say "client", not "tab".
- 04:17: how many streams is the transport's
  concern.
- 04:21: a duplicate address is allowed, as in
  Hono. The first wins.
- 04:31: no `mode` on remote data. The
  protocol controls it.
- 05:39: a protocol layer, if rpc and remote
  data share it.
- 06:34: tracing: "just follow common practice".
- 07:10: drop `name`; call it `remoteData`.
- 07:18: remoteData has no `error` option.
- 07:20: remoteData uses plain `data` cells.
- 08:19: no error mapping. "The Error on
  javascript is too much free form".
- 10:39: "keep things honest. If server fail, we
  need to be able to know that".
- 11:00: join transport and protocol. "Protocol
  surely be limited by the transport".
- 11:01: "A, but much better refined naming
  needed, don't invent".
- 11-07 07:02, 07:05: rpc should have a
  lifecycle, as TanStack Query does: error
  recovery, error mapping. Promote it over
  middleware, or sunset middleware.
- 08:41: "Yeah lifecycle": `use` goes.
- 15:37: "Agree, go with B": faults are data,
  not a throw from a read.

## Context

Today tinker-app has two parts for the server:

- `tinker/components/rpc`: a POST of JSON per
  call. Any failure becomes `RpcFailed` or a
  kind read off the thrown error.
- `tinker/components/live-read`: numbered reads
  and one coalesced re-read.

Hedl (3c16417) repeats one pattern in eight
features: a load op, a resource that re-runs
on a change notice, a handler that patches one
row. Each feature writes it by hand.

The goal: a feature reads remote data as it
reads a local cell, and asks the server with
one op. The wire is set up once, at the seam.

## Precedent

- **Connect RPC transports.** One transport per
  wire (`createConnectTransport`). The protocol
  is fixed inside it. A client takes the
  transport as an option.
- **tRPC.** `createCaller` runs a procedure in
  process. A transformer is the codec. A link
  holds headers.
- **HTTP statuses.** A small fixed fault set:
  401/403, 400, 500, 502.
- **Rust `Result`, GraphQL errors as data.** A
  domain outcome is a value the op returns.
- **TanStack Query, SWR.** A read gives
  `{ data, error }`. The error is data beside
  the value.
- **ADR 0089 Limits.** The resolve hook wraps
  root reads only. "A module must expose
  explicit setup when it needs readiness
  before a read."
- **Koa, TanStack Start.** Middleware is a chain
  with `next`.
- **Hono.** A duplicate route: the first wins.
- **OkHttp `Authenticator`.** On a 401, renew
  once, then try again.
- **RFC 3229 delta encoding.** The client asks
  with `a-im`; the server answers with a delta.
- **HTTP/2, graphql-ws.** Many streams on one
  connection.
- **OTel.** HTTP client span as the parent;
  messaging spans with links for pushes.

Where ours is simpler:

- One capsule per definition, the same handle
  on both sides.
- Six faults, fixed. No error lists.
- The server is the only writer of remote data.

## The layers

```
feature
  useData(board.todos)
  run(api["todo.add"], ...)
    |
    v
rpc, remoteData: values only
    |
    v
transport capsule (sse, memory)
  speaks the protocol:
  codec, envelope, faults,
  route table, pushes, streams
    |
    v
the wire: text
```

## Decision

1. **Transport.** One capsule per side speaks
   the protocol. `sse.client` exports `call`
   and `watch`. `sse.server` gives the request
   handler as its start value. `memory` is the
   same, in one process, for tests.
2. **Protocol.** Shared code, not a capsule.
   It holds the reply envelope, the fault set,
   the codec use, the push forms and the route
   table.
3. **Second transport.** `createSse()` and
   `createMemory()` make one more set, for a
   scope with a public and a signed base.
4. **Codec.** Transport config, JSON by
   default. Both sides must use the same one.
5. **Route table.** `sse.server({ services })`
   takes the definitions. A duplicate address:
   the first in the list wins, and start logs a
   warning. `strict: true` fails start with
   `DuplicateAddress` instead.
6. **rpc.** `rpc(contracts)` gives one capsule.
   A contract has `input`, `output` and
   `mode` ("reply" or "stream").
   - `api({ use, implement })` runs the keys in
     this process (as `createCaller`).
   - `api({ use, remote: sse.client })` sends
     them.
   - `api["todo.add"]` is the same handle on
     both sides.
   - A key answers only in its own mode. A GET
     never runs a reply key, so a link on another
     site cannot change data. Other methods
     answer 405.
   - A stream key's op depends on the `channel`
     tag. It sends each output and ends when
     `closed` aborts.
7. **remoteData.** `remoteData({ todos })`
   takes plain `data` cells as shapes. It makes
   its own cell per key and exports it as a read
   view (ADR 0123). The key is the address.
   - `board({ serve: true, use })`: the app's
     writer ops set the passed cell. Each write
     is pushed.
   - `board({ read: sse.client })`: `call` and
     `watch` fill the cells.
   - The server is the only writer. A client
     changes data through an rpc key.
   - A cell's `parse` checks both sides.
   - One value per parameter (F12, Duke
     2026-11-07 06:26 "session is meant for
     that"): `remoteData(cells, { config:
{ project } })` takes the app's own tags.
     Bind `board.project("p1")` on a root, a
     session or a namespace. The server's fill
     op reads `board.project`. A write in a call
     tagged p1 pushes to p1 only. Built in
     9d3a939, 54563b6, 34109e5.
8. **Lifecycle, not middleware** (Duke
   2026-11-07 08:41; replaces `use`). Words
   from oRPC (`onStart`, `onSuccess`, `onError`,
   `onFinish`) and TanStack Query (`retry`; a
   context from the start hook reaches the
   later ones). See "The lifecycle" below.
   Built for rpc in c9f876e: both sides, and
   `implement` entries. remoteData's half is
   open.
9. **Outcomes are output.** A todo that is gone
   is `{ kind: "gone" }` in the output shape.
   No error lists. No kind is read off a thrown
   Error.
10. **Faults.** The call's own, from a fixed
    set, branded per definition
    (`api.fault.is(e)`), with a `traceId`:
    - `refused`: a middleware said no;
    - `failed`: the server threw (the cause
      stays in the server log);
    - `invalid`: the input or a value did not
      fit;
    - `encode`, `decode`: the codec could not
      do its job (`payload.side` says where);
    - `link`: the transport failed.
11. **Faults are data.** `board.faults` is a
    read view: each key's last fault, until a
    good value arrives. A read of a key never
    throws. The cell keeps its last good value,
    or its initial value.
    - It is a plain cell read, so the root, a
      session and a `depends` all see it.
    - remoteData has no resolve hook.
12. **Honest.** No fault is silent.
    - A value that fails `parse`: `faults`
      shows `invalid` until a good value comes.
    - A service throw: `failed`, logged.
    - An unknown stream address: `link`.
    - A stream that cannot open: `faults`
      shows `link`; it tries again with
      back-off.
    - A refused watch: `refused`.
    - A stream that ends is not a fault. The
      catch-up read decides.
    - A fault never fails start, so it never
      closes the scope.
13. **Client options** (the protocol's, so on
    the transport):
    - `pushes`: "whole" or "delta" (RFC 3229).
    - `streams`: "each" or "one" (one stream,
      one frame per tick).
    - `meta`: an op whose pairs go as headers.
    - `renew`: runs on `refused`; true means
      try once more. One at a time.
14. **Trace.** The transport sends its own span
    as `traceparent`. A push carries the
    writer's span; the client links to it.

## The lifecycle

Each hook is a Core operation, as middleware
was. A capsule config lists them; a list runs
in order.

```ts
api({
  implement,
  retry: { link: 2 },
  onStart: [signedIn],
  onSuccess: [],
  onError: [refusedAsFault],
  onFinish: [timing],
});
```

What each hook gets and may answer:

- `onStart` gets `{ key, input, meta }`.
  It answers nothing, `refuse(payload)`, or
  `{ meta?, tags?, context? }`.
- `onSuccess` gets `{ key, output, context }`.
  It may answer a new output.
- `onError` gets `{ key, error, context }`.
  It answers `refuse(payload)`, an output
  (recovery), or throws again.
- `onFinish` gets `{ key, outcome, context }`.
  It answers nothing.
- `retry` names faults and counts. A call
  runs again only for a fault it names. No
  default: a write is not safe to send twice.

The same hooks on every capsule:

- rpc, on both sides. An `implement` entry may
  add hooks for one key, or with
  `inherit: false` use only its own.
- remoteData: the same, with no `implement`
  entry.

Today's middleware, as hooks:

- `signedIn`: `onStart`, refuse or bind the
  user tag.
- `refusedAsFault` (Hedl): `onError`.
- `timing`: `onStart` gives the time as
  context; `onFinish` reads it.

What goes: a step that calls `next` twice or
wraps it. Only retry did, and it is an option.

## The wiring

Shared definitions:

```ts
const todos = data({
  initial: [] as Todo[],
  parse: z.array(todo),
});
export const board = remoteData({ todos });
export const api = rpc({
  "todo.add": {
    input: z.object({ title: z.string() }),
    output: z.object({ id: z.string() }),
  },
});
```

The server command:

```ts
const transport = sse.server({
  base: "/api",
  services: [board, api],
});
const scope = createScope({
  capsules: [
    board({ serve: true, use: [signedIn] }),
    api({
      use: [signedIn],
      implement: { "todo.add": addTodo },
    }),
    transport,
  ],
});
```

The client command:

```ts
const scope = createScope({
  capsules: [
    sse.client({ base: "/api" }),
    board({ read: sse.client }),
    api({ remote: sse.client }),
  ],
});
```

A feature:

```ts
const list = useData(board.todos);
const why = useData(board.faults).todos;
const add = useRun(api["todo.add"]);
if (why) return <SignIn />;
```

## Evidence

The todo stress app in a scratch copy, Core
0.11.0 plus the ADR 0126 change:

- 71 of 71 tests, 3 runs, `tsc` clean.
- 4 users, 5 clients each, 20 calls each, on
  memory and on SSE. All 20 clients end equal
  to the server.
- Two users in real Chromium over SSE.
- Each silent path from the audit has a test
  that fails before the fix.
- Home: built in tinker-app (b961bf6 ADR,
  f56a0d5 code); `rpc` and `live-read` went.
  Hedl runs it since 46543d7.
- Faults as data: a session read and an op's
  `depends` see `refused`. A guest in Chromium
  sees "Sign in to see the list.".
- One trace from the client call to the server
  op; pushes linked.

Code: `/mnt/project-files/tinkered/plans/`
`remote-cell/todo-faults/`.
Log of each step:
`.../remote-cell/decision-log.md`.

## Open

- A key with no input: the JSON codec sends
  `undefined` as `null`, so `z.void()` answers
  `invalid` (Hedl uses a `noInput` shim).
- Serving on tinker-app: `sse.server` should be
  a route of the `bun.server` capsule.
- A watch's text is held to 2 KiB on every
  transport (54563b6).
- Core rows: F18 (flat spans), F21 (a refusal
  logs as a crash), F28 (union config by cast),
  F32 (abort disposes depends), F39 (write hook
  has no span), O3 (a watch's close marks it
  failed).
