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
export { auth, readAccount } from "../backend/auth.ts";
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

- **sync**: off by default; its server side
  is built, its client side comes next.
  - It turns auth on.
    `sync: true` with `auth: false` fails the build.
  - Route: `GET /api/sync`, a Server-Sent Events stream.
  - Reads `database` from `src/lib/tinker.server.ts`:
    a drizzle Postgres database with `listen`
    (the `Database` type on `@tinker/start/server`).
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
  envelopes, and readers.
- `@tinker/start/server`: `readResult`, `env`,
  `createServerEntry`, `authSettings`
  (the auth part's origin and secret),
  and `eventHistory` with the `Database` type
  (the sync part's writes).
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
- Each entry makes a telemetry root
  that observes the app root and closes after it.
  Its own sends are not traced.
  With telemetry off, it is empty,
  and nothing is observed.
  - Each finished span and log line at info or above
    becomes a record, and a line on the local console:
    JSON on the server, an object in a tab.
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
    a server render sends when it closes.
    One send waits at most 750 ms,
    and carries at most 48,000 bytes.
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
  - The queue holds 512 records and 1 MiB;
    one record is at most 48,000 bytes,
    and one send at most 64 records.
    Sent records free their room.
    A send that storage refuses, or that throws,
    in a tab or on the server,
    keeps its records for the next send.
    Each kind leaves on its own: when the trace send
    fails, the traces stay and the logs sent beside them leave.
    Drops are counted.
  - Closing sends what is left, for at most 1.5 s.
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
- With sync on, `GET /api/sync` streams events:
  - The cursor comes from `Last-Event-ID`,
    else `?cursor=`, else the start.
    A cursor that does not read is a `400`;
    another account's is a `403`.
  - It replays the events after the cursor,
    public and the account's own,
    at most 100 to a frame,
    each frame with its resume cursor as its `id`.
  - Then it greets once (`: connected`),
    and sends each commit as it lands.
  - A quiet stream sends `: heartbeat` each 10 s,
    and closes at its 30 s lease.
  - Each wake re-reads the account.
    An account stream that signs out,
    or an anonymous stream that signs in,
    is an account change: it sends `event: account`
    and closes, with no saved rows after it.
  - A request or backend stop ends it.
  - `eventHistory` locks a stream, appends events
    at the next revisions, saves a result,
    and refuses another owner's execution.
  - Notifications wake after a commit
    and stay silent on a rollback;
    a read made before waiting still wakes.
  - One listener wakes every stream.
    A listener that cannot start fails the subscribe,
    so the stream's open fails; a listener that breaks
    ends its subscribers, and the next subscribe
    starts a new one.
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
- Check 5 also names a server seam without
  `database` while sync is on.
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

## Upgrade

```bash
tinker upgrade 0.3.0
tinker upgrade 0.3.0 --from ../packs
```

1. It stops when a base file in `node_modules`
   was edited (doctor check 2). `--force` goes on.
2. `package.json` gets the new version.
   With `--from`, it names the packed file,
   and each peer moves to the version
   that release was tested with.
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
