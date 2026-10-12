# Upgrade notes for `@tinker/start`

`tinker upgrade` prints the sections between your old and new version.

## 0.8.0

Core, React, and Start move to 0.8.0 together.
`tinker upgrade 0.8.0` sets all three release URLs.
Five changes can need an app edit:

- `env` is gone from `@tinker/start/server` (ADR 0113).
  A unit never reads env; it names typed tags.
  The `Env.Values` and `Env.Read` types stay.
- `src/lib/tinker.server.ts`, when it exists,
  must also export `settings`, an `Env.Read`:
  `(env) => [bindings]` for the app's own tags.
  Doctor names the file when it does not.
  With no app tags: `export const settings = () => [];`.
- A scope handle is not plain data (ADR 0108).
  Do not spread it or destructure its verbs:
  write `scope.run(op)`, not `const { run } = scope`.
  `list.forEach(scope.release)` still works.
- A preset replaces the whole node (ADR 0109).
  Its factory or run gets empty deps;
  a preset that needs a value makes it itself.
- A path that ends a session sends
  `accountNotice(userId)` from `@tinker/start/server`
  after its commit (ADR 0110). Sign-out, session
  revoke, and user delete in the scaffold already do.
  Without it, a stream closes at its 30 s lease.

New, with no edit needed:

- `drizzleOrm` on `@tinker/start/server` gives a body
  the Drizzle module through its deps (ADR 0107).
- Telemetry reads `LOG_LEVEL` (default `info`)
  and `SPAN_HISTORY` (default `80`).
- One telemetry root per server process;
  a render never waits for a telemetry send.
- Faster core runs and closes, React handle reuse,
  compressed HTML, and leaner sync frames.

## 0.7.0

Core, React, and Start now share one version.
`tinker upgrade 0.7.0` sets all three GitHub release URLs,
then installs and runs prepare and doctor.
The tag is `start-v0.7.0` on `lagz0ne/tinkered`.
No app source or config change is needed.
An edited base still stops the upgrade before any write.
This set is prepared locally; publication needs the user's go.

## 0.6.0

The sync part's client side; it is off by default,
and no app change is needed while it stays off.
With `tinker({ sync: true })`:

- `src/lib/tinker.server.ts` also exports `bootstrap`,
  the app's snapshot operation.
- `src/lib/tinker.ts` exports `records`, `readSnapshot`,
  `readBootstrap`, `readBatch`, and `streamMessage`.
  `records` fits `Sync.Records`; type its factory with it.
- Some file in `src/` declares the `Register` bodies:
  `declare module "@tinker/start" { interface Register { … } }`.
- A route that reads `context.bootstrap()` or
  `context.account()` needs a shell made with
  `createRootRouteWithContext<Sync.RouterContext>()`.
- The tab's units come from `@tinker/start/client`.

## 0.5.0

The sync part's server side; it is off by default,
and no app change is needed while it stays off.
`tinker({ sync: true })` turns it on, and auth with it:

- It mounts `GET /api/sync`, a Server-Sent Events stream.
- `src/lib/tinker.server.ts` must export `database`
  (a drizzle Postgres database with `listen`),
  besides auth's `auth` and `readAccount`.
- The app's migrations create the sync tables
  and the `start_sync` trigger (see the README).
- `auth: false` with `sync: true` fails the build.

## 0.4.0

The auth part is off by default; no app change is needed
while it stays off.
`tinker({ auth: true })` turns it on:

- It mounts `/api/auth/$` for the app's auth library.
- `src/lib/tinker.server.ts` must export
  `auth` and `readAccount`; the build stops without them.
- Set `PUBLIC_ORIGIN` and `AUTH_SECRET`
  (at least 32 characters) in `.env` or the shell.
- Build the app's `auth` on `authSettings`
  from `@tinker/start/server`.

## 0.3.0

The telemetry part is on by default.
It takes `POST /api/telemetry`,
and sends spans and log lines to
`VICTORIA_TRACES_URL` and `VICTORIA_LOGS_URL`.

- An app route at `/api/telemetry` now fails the build.
  Set `tinker({ telemetry: false })` to keep it.
- Set the two URLs, or run the default storage
  on `127.0.0.1`; doctor names a URL that is not http(s).
- `OTEL_SERVICE_NAME` names the service;
  the default is `tinker-app`.

## 0.2.0

The base reads five named files, and no others:
`src/router.ts`, `src/start.ts`, `src/server.ts`,
`src/routes/__root.tsx`, and `src/style.css`.

- Move router options from `src/router.tsx`
  to `export const router` in `src/router.ts`.
- `vp build` now stops on a type error,
  and on each mistake `tinker doctor` names.
- Add `"postinstall": "tinker prepare"`
  to `package.json`, or run `tinker doctor --fix`.
- Add `.tanstack/` to `.gitignore`.

## 0.1.1

`/api/health` replies with `Cache-Control: no-store`.
No app change is needed.

## 0.1.0

The first base: Start bridge, entries, `/api/health`, `/tinker`.
