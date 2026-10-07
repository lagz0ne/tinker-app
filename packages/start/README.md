# @tinker/start

The Start base: the fixed TanStack Start setup
for a Tinkered app, as one package
([ADR 0106](https://github.com/lagz0ne/tinkered/blob/main/docs/decisions/0106-the-start-base-is-a-package-glued-by-one-plugin.md)).

- It holds the entries, the base routes,
  the `tinker()` Vite plugin, and the `tinker` command.
- It ships TypeScript source, readable in `node_modules`.
- An app never edits it. An upgrade replaces it whole.

The smallest app is `apps/start-min` in the Tinkered repo:
two files in `src/`, and the two glue lines below.

## The glue

Two config lines join an app to the base.

`vite.config.ts`:

```ts
import { defineConfig } from "vite-plus";
import { tinker } from "@tinker/start/vite";

export default defineConfig({
  plugins: [tinker()],
});
```

`tsconfig.json`:

```json
{ "extends": "./.tinker/tsconfig.json" }
```

Add one script to `package.json`,
so a fresh clone gets `.tinker/`:

```json
"postinstall": "tinker prepare"
```

`.tinker/` is the generated folder.
It is gitignored, and nobody edits it.

## Parts

A base part is an opt-in slice of the base,
set in `tinker({ ... })`.
Turning a part off frees its route path for the app.

```ts
export default defineConfig({
  plugins: [tinker({ telemetry: false, auth: true })],
});
```

- **telemetry**: on by default.
  - Route: `POST /api/telemetry`, a tab's records.
  - Reads `VICTORIA_TRACES_URL`,
    default `http://127.0.0.1:10428/insert/opentelemetry/v1/traces`.
  - Reads `VICTORIA_LOGS_URL`,
    default `http://127.0.0.1:9428/insert/jsonline`.
  - Reads `OTEL_SERVICE_NAME`, default `tinker-app`.
  - Both URLs must be http(s).
    An empty value reads as unset.
- **auth**: off by default.
  - Route: `/api/auth/$`, GET and POST:
    the app's auth library answers.
  - Reads `auth` and `readAccount`
    from `src/lib/tinker.server.ts`.
  - Reads `PUBLIC_ORIGIN`, an http(s) URL,
    and `AUTH_SECRET`, at least 32 characters.
    Neither has a default.

The server seam with auth on, filled in:

```ts
// src/lib/tinker.server.ts
export const extensions = [];
export { auth, readAccount } from "../backend/auth";
```

```ts
// src/backend/auth.ts
import { resource } from "@tinker/core";
import { authSettings } from "@tinker/start/server";

export const auth = resource({
  label: "auth",
  depends: { settings: authSettings },
  factory: async ({ settings }) => {
    const { betterAuth } = await import("better-auth");
    return betterAuth({
      baseURL: settings.origin,
      secret: settings.secret,
    });
  },
});
```

- **sync**: off by default.
  - It turns auth on.
    `sync: true` with `auth: false` fails the build.
  - Route: `GET /api/sync`, a Server-Sent Events stream.
  - Server functions: `getBootstrap` (the seam's
    `bootstrap`) and `getAccount` (auth's `readAccount`).
  - Reads `database` and `bootstrap`
    from `src/lib/tinker.server.ts`;
    `database` is a drizzle Postgres database with `listen`
    (the `Database` type on `@tinker/start/server`).
  - Reads `records`, `readSnapshot`, `readBootstrap`,
    `readBatch`, and `streamMessage`
    from `src/lib/tinker.ts`,
    and the app's `Register` bodies.
  - Reads no env key of its own.

With sync on, the app's migrations create
the sync tables (`src/parts/sync/schema.ts`)
and this trigger, which wakes the streams:

```sql
CREATE FUNCTION start_sync_wake()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('start_sync', TG_TABLE_NAME);
  RETURN NULL;
END; $$;
CREATE TRIGGER sync_event_committed
AFTER INSERT ON sync_event
FOR EACH STATEMENT
EXECUTE FUNCTION start_sync_wake();
```

The client seam with sync on, filled in:

```ts
// src/lib/tinker.ts
export const extensions = [];
export { records } from "../frontend/records";
export { readSnapshot, readBootstrap } from "./sync";
export { readBatch, streamMessage } from "./sync";
```

```ts
// src/lib/sync.ts, the Register bodies
declare module "@tinker/start" {
  interface Register {
    change: { count: number };
    result: { kind: "done" };
    public: { count: number };
    private: { name: string };
  }
}
```

`records` keeps the tab's saved state.
It is a `Sync.Records`. Type its factory with it,
so a wrong method fails in the app's own file.
A revision of -1 means none yet.

```ts
// src/frontend/records.ts
export const records = resource({
  label: "records",
  depends: { count: count.controller },
  factory: ({ count }): Sync.Records => ({
    resetPrivate: () => {},
    bootstrapPublic: (saved, after) => {
      if (saved.revision >= after) count.set(saved.count);
    },
    bootstrapPrivate: () => {},
    change: (change) => count.set(change.count),
    snapshot: (revision) => ({
      public: {
        stream: "public",
        revision: Math.max(0, revision),
        count: count.get(),
      },
      private: null,
    }),
  }),
});
```

A route reads the router context sync adds,
`Sync.RouterContext` (`bootstrap` and `account`),
from a shell that declares it:

```tsx
// src/routes/__root.tsx
type Context = Sync.RouterContext;
const root = createRootRouteWithContext<Context>();
export const Route = root({
  component: () => <Outlet />,
});
```

A part switch takes `true` or `false`;
any other value fails the build.
`.tinker/base.json` records which parts are on,
so `tinker prepare` and doctor read the same switches.
When one part turns another on, the build says so
(`tinker: sync turns auth on`),
and so does the head of `.tinker/parts.server.ts`.

## Entries

- `@tinker/start`: shared units, such as
  `startRequests` and `RouterOptions`,
  and the sync part's `Register`, `Sync` types,
  envelopes, and readers. The readers take an app's
  wire values and refuse each broken one;
  a snapshot keeps the app's own fields
  beside the stream and revision.
- `@tinker/start/server`: `readResult`, `env`,
  `createServerEntry`, `authSettings`
  (the auth part's origin and secret),
  and `eventHistory` with the `Database` type
  (the sync part's writes), `event`, `execution`,
  and `stream` (the tables the app queries),
  `requestHeaders` (auth reads the request),
  and `httpRequest` (outgoing HTTP).
- `@tinker/start/client`: the tab's sync units:
  `syncClient`, `snapshotLoader`, `loadSnapshot`,
  `checkAccount`, `applyBootstrap`, `applyEvents`,
  `leaveAccount`.
- `@tinker/start/testing`: test bindings and units,
  including `httpBackend`, `http`, `handleAuth`,
  `requestHeaders`, `openSync`, `notifications`,
  the tab owner and stop tag, and the snapshot source.
  App code never imports this test entry.
- `@tinker/start/vite`: `tinker()`,
  with the part switches and Start's
  `prerender`, `pages`, `spa`, `sitemap`.

`@tinker/start/package.json` is exported too.
The package's `exports` refuses every other path.

## At run time

- Each request runs in its own session of the root
  scope, with its headers and its stop signal.
  A request with no root scope fails before any work.
- The session ends when the response body is read
  to the end: a graceful close.
  A body that is cancelled or fails to read,
  or a request that throws, closes it by force.
  A response with no body ends it at once.
- A held body keeps its status and headers.
- Closing the root scope cancels each open body.
  A request that cannot end fails the body's cancel,
  and the scope's close.
- `readResult` returns a settled value.
  It throws a failure as is,
  and a cancelled call as the base's `Cancelled` error.
- `/api/health` answers `{"ok":true,"base":"<version>"}`.
  The health operation reports the installed base version.
- The server owns one telemetry root per process.
  Server renders borrow its observer and queue.
  Their records keep side `ssr`.
  Render close finishes while a storage send is held.
  Process close sends records from all renders.
  Each browser tab owns its telemetry root,
  which closes after the tab's app root.
  Telemetry sends are not traced.
  With telemetry off, it is empty,
  and nothing is observed.
  - Each finished span and log line at info or above
    becomes a record, and a line on the local console:
    JSON on the server, an object in a tab.
    Lines below info are dropped;
    warn and error keep their level.
  - A record names its side: `server`,
    `ssr` (a server render), or `browser` (a tab).
  - A span with no end is sent with its start as its end.
    Names and keys are cut to 256 characters,
    values to 2048; a span keeps 31 attributes
    and 32 events.
    A bigint, `undefined`, or a cycle still
    encodes as text.
  - A server sends its spans grouped by side:
    server, then browser, then ssr.
  - The server and a tab send on their own
    once a second has passed;
    render close never waits for a telemetry send.
    One send waits at most 750 ms,
    Server records carry at most 48,000 bytes per send.
    A tab sends at most 32,000 UTF-8 bytes,
    including JSON framing, even when it closes.
  - A tab trusts the records it made itself.
    With sync off and no app import of zod,
    the built client chunk contains no zod.
  - A tab posts to `/api/telemetry`.
    The route answers each post with a status:
    `202` for a same-origin JSON post
    of at most 64 KiB, with tab records only;
    else `403`, `415`, `413`, `400`,
    or `503` while the server stops.
    A refused post's body is never opened;
    a read body is let go, and the request ends clean.
  - A batch is taken only when every record keeps
    the wire rules: ids in hex of the right length,
    times in digits, at most 64 records,
    and no keys beyond the record's own.
  - The route expects the request's own origin;
    behind a `*.preview.tini.works` proxy,
    its `https` one.
  - The route hands each good batch
    to the telemetry root, as a plain batch.
    A tab's record takes the server's service name.
  - A full queue drops what comes past 512 records,
    and counts the drops; each send stays within 64 KiB.
  - The queue holds 512 records and 1 MiB;
    one server record is at most 48,000 bytes,
    and one tab record at most 31,976 bytes,
    and one send at most 64 records.
    Each record is sized once when the queue takes it.
    Sent records free their room.
    A send that storage refuses, or that throws,
    in a tab or on the server,
    keeps its records for the next send.
    Each kind leaves on its own: when the trace send
    fails, the traces stay and the logs sent beside them leave.
    Drops are counted.
  - Closing sends what is left, for at most 1.5 s;
    then the owned clock aborts a stuck storage request.
    Then closing gives up on storage,
    and what is left is dropped.
  - A bad storage URL stops the telemetry root
    at its start with `BadSettings`, naming each key.
- With auth on, `/api/auth/$` hands the whole
  request to the app's `auth` library,
  and returns its reply as is.
  It takes only a request;
  a failing library fails the call.
- The auth part reads its two keys once,
  and hands them to the app's `auth` as `authSettings`.
  With auth on, the app root does not start
  while a key is unset or refused.
  With auth off, the app root reads no auth key.
  The auth part's work shows on the trace
  as `auth.settings` and `handleAuth`.
- With sync on, a tab keeps its sync state
  in its app root:
  - A server render loads the snapshot with
    `getBootstrap` and dehydrates it; the tab
    hydrates it, then opens `/api/sync`
    from its applied cursors.
  - A snapshot sets the records and cursors once
    per account version: a stale version or an older
    snapshot changes nothing. An anonymous snapshot
    keeps the tab anonymous on the public stream.
    A snapshot for another account leaves the account,
    even while a write is pending; one for the same
    account waits for the pending write.
  - A tab loads its snapshot once per account,
    and shares a load in flight. A sign-in holds
    loads and account checks until it completes.
    A tab whose snapshot came another way still loads
    its own at the next version. A load that cannot
    apply yet (a write is pending) is tried again,
    and a newer load is not dropped when an older one ends.
  - An account check keeps the same account,
    and leaves a changed one.
  - Changes apply in order: a repeat is skipped,
    and a gap stops the batch.
    An account frame leaves the account and reloads.
  - Eight unread frames wait; a ninth closes the
    connection, so the tab replays instead of lagging.
    A connection that ends re-checks the account.
    The tab reconnects 500 ms after each end.
  - A write waits for its result event.
    A send that throws is retried after 500 ms;
    a rejected reply fails the write;
    an account exit or its call's stop cancels it.
    A send that fails because its call stopped fails
    with its own error, and is not retried.
    A wait for an old account version, or with a
    stopped signal, fails at once. An account exit
    or a root close fails a wait that no signal stops. A result for a write
    this tab did not send is not kept for a later write
    of that id.
  - A connection that applies changes, then errors,
    ends false. Before any connection, closing does
    nothing, and reading the next frame ends at once.
  - The tab logs `sync.reconnecting` only after
    a failure, and checks nothing more once it stops.
    A stream loop that fails surfaces its error
    when the tab closes; one that ends clean
    closes with no error.
  - The server side has no page:
    the tab lifetime binds without listening.
  - A real page hide closes the tab's app root;
    a back-forward cache hide does not.
- With sync on, `GET /api/sync` streams events:
  - The cursor comes from `Last-Event-ID`,
    else `?cursor=`, else the start.
    A cursor that does not read is a `400`;
    another account's is a `403`.
  - It replays the events after the cursor,
    public and the account's own: each stream
    resumes past its own revision,
    at most 100 to a frame,
    each frame with its resume cursor as its `id`.
  - A stream opened after a wake still replays.
    A signed-in tab with no account cursor gets
    the account frame at once.
  - Then it greets once (`: connected`),
    and sends each commit as it lands.
  - A quiet stream sends `: heartbeat` each 10 s,
    and closes at its 30 s lease. Each heartbeat
    re-reads the account first; a sign-out found
    then sends the account frame instead.
  - The stream reads the account fresh each time:
    no cookie cache, and no session refresh.
  - Each wake re-reads the account before it reads
    rows, so a sign-out ends the stream even when its
    rows cannot be read. It re-reads it again after the
    read, so rows read for an account that signed out
    during the read are not sent.
    A held stream whose account signs out,
    or an anonymous stream that signs in,
    is an account change: it sends `event: account`
    and closes, with no saved rows after it.
  - A request or backend stop ends it.
    A body cancelled while it waits stops its wait at once.
  - `eventHistory` locks a stream, appends events
    at the next revisions, saves a result,
    and refuses another owner's execution.
  - Notifications wake after a commit
    and stay silent on a rollback;
    a read made before waiting still wakes.
  - One listener wakes every stream.
    A root that never listened closes clean.
    A closed subscriber is not told when it breaks.
    A listener that cannot start fails the subscribe,
    so the stream's open fails; a listener that breaks
    ends its subscribers, and the next subscribe
    starts a new one. A subscribe whose listener is
    replaced while it connects fails as disconnected.
- With no `src/server.ts`, the server entry
  goes straight to the base.
- In production, the error page shows no error text.
  In dev, Start's JSON 500 for a page load
  becomes a page that reloads after the fix.
  Every other response passes through.

## Doctor

```bash
tinker doctor
tinker doctor --fix
```

- It prints one line per check:
  `ok`, `skip`, `fail`, or `fixed`.
- Each finding names a file and a line.
- It exits 1 on any `fail`.
- `--fix` writes only base-owned and generated things:
  `.tinker/`, the `.gitignore` lines,
  the tsconfig `extends` key, and the `postinstall` script.
- It never edits `src/`, the Vite config, or `.env`.
- Check 5 (named files) also names each seam
  name an on part reads and the seam lacks,
  and a missing seam file. The build stops on it.
- Check 5 also names, while sync is on,
  a server seam without `database` or `bootstrap`,
  a client seam without one of its five names,
  and an app with no `Register` bodies.
- Check 6 reads literal module paths in imports, exports,
  dynamic imports, import types, module declarations,
  and import-equals statements.
  It also names `.ts`, `.tsx`, and `.mts` import endings
  in app code, tests, and config files, with file and line.
  Remove those endings; keep `.mjs`, `.js`, `.json`,
  `.css`, assets, and `?url` queries.
  A private alias or a relative or absolute path
  into the installed base fails with its file and line.
- Check 7 (routes) counts an on part's routes as base routes,
  and names the switch that frees one.
  A route under a base splat, such as
  `/api/auth/login` under `/api/auth/$`, counts too:
  TanStack would serve the app's file there.
- Check 9 (env) also reads each on part's keys,
  as the part does: the shell, then `.env`, then the default.
  A refused value is named at its `.env` line;
  an unset key with no default, as `.env`'s,
  unless `.env.example` lists it already.

`vp build` runs the same checks for named files,
imports, routes, and style before TanStack's route
generator, then the app's own `tsc`.
A fail stops the build with doctor's line.

## Packages from GitHub

Core, React, and Start ship together on `lagz0ne/tinkered`.
Each app pins three tarball URLs under one `start-v<version>` tag.
The lockfile pins their bytes.
The first set is `0.7.0`; it is prepared locally, not published.
Read [the release steps](../../docs/roadmap/start-base/RELEASE.md).

## Upgrade

```bash
tinker upgrade 0.7.0
tinker upgrade 0.7.0 --from ../packs
```

1. It stops when a base file in `node_modules`
   was edited (doctor check 2). `--force` goes on.
2. `package.json` gets three GitHub tarball URLs:
   Core, React, and Start from tag `start-v0.7.0`.
   All three share one version because they ship together.
   Other peers move to the versions the new base tested.
   With `--from`, only Start uses a local packed file;
   this mode is for local proofs.
3. Install, `tinker prepare`, then `tinker doctor`.
4. It prints the `UPGRADE.md` notes between versions.

It never writes `src/`.
Undo is git: restore `package.json` and the
lockfile, then install again.

## Work on the base

```bash
vp run @tinker/start#test
vp run @tinker/start#mutate
node packages/start/scripts/break-each-check.mjs
packages/start/scripts/proof.sh
```

- The tests call the glue as plain functions,
  and base behavior through a scope.
  None runs a build, a server, TanStack, or a browser.
- `break-each-check.mjs` breaks each check and each
  doctor message, one at a time; a test must fail.
- `proof.sh` builds and serves `apps/start-min`.
  Its logs land in `docs/roadmap/start-base/proof/`.
  [The proof](https://github.com/lagz0ne/tinkered/blob/main/docs/roadmap/start-base/PROOF.md).

## Outgoing HTTP

`httpRequest` depends on a session's HTTP resource.
Each call makes an `http.request` operation span
and its `http <METHOD> <path>` wire span (ADR 0102).
The wire span keeps method, path, and status;
the path has no query string.

Bind `httpBackend` in scope tests to send without network.
The request returns status, headers, and body text.
Each set-cookie stays separate; other headers stay joined.
The method accepts HTTP token characters and becomes upper-case.
A non-2xx status is a result.
A send or body read failure raises `HttpRequestFailed`:
method, path, and only the cause's name and code.
An inner socket cause wins for each readable field;
an unreadable inner field keeps its readable outer field.
A string cause is dropped.
The code can be a number or string; private text is dropped.
An abort failure keeps its numeric code without its message.

Caller cancellation keeps Core's cancelled result.
Cancelling a response body stops its active request work.
Forced close cancels in-flight sends and body reads.
A graceful close ends HTTP waits before other work drains.
The caller's signal stays open on graceful close.
The backend and request stop tags end HTTP waits
without closing the scope; sibling requests stay open.
An already stopped call sends nothing.
Releasing the HTTP resource aborts its own pending sends.
Other running work still finishes on graceful close.
When the backend answers during graceful close,
the caller's completed work stays completed.

Only the check after the rows read can stop rows
of an account that signed out during it.

Generated aliases and parts use the real package folder.
A linked workspace base has one sync Register,
so app snapshot fields keep their types in both entries.

Installed examples carry their part and seam needs in
`src/examples/*.tinker.json`.
Doctor names each missing `tinker({ part: true })` switch
and the exact export line to add to the seam file.
An empty server extensions list must also join the demo's
database startup extension.
Doctor accepts its re-export, an imported startup extension,
or a spread of the copied demo's extensions beside your own.
Example requirements also stop a build until they are joined.
