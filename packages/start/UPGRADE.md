# Upgrade notes for `@tinker/start`

`tinker upgrade` prints the sections between your old and new version.

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
