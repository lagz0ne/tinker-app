# Your Start app

A shared counter, accounts, profiles, and private todos.
The app uses Postgres, Better Auth, and SMTP.
Victoria stores traces and logs.

## Start

This app runs on the package `@tinker/start`.
The base owns entries, telemetry, auth routes, and sync.
The source registry is built locally; it is not published.
Install packed Core, React, and Start releases first.

From your project folder:

```bash
cp .env.example .env
npm install
```

Set `AUTH_SECRET` in `.env` to a long random value.
The other sample values point at the local compose stack.
SMTP user and password may be empty for Mailpit.

```bash
docker compose pull
docker compose up -d --wait
npm run dev
```

Open `http://localhost:4318`.
Make an account, save a name, and add a todo.
Open `http://localhost:18025` to see mail in Mailpit.
Open two tabs to see shared changes.
Each account sees only its own profile and todos.
Startup applies the checked-in migrations.

For a built app:

```bash
npm run build
npm start
```

The Node host reads `.env`.
The dev command also reads `.env`.
`HOST` and `PORT` set the listen address.
Keep `PUBLIC_ORIGIN` equal to the URL you open.
All settings and compose ports are in `.env.example`.

## Layout

- `node_modules/@tinker/start/`: the base package.
  Update it with `tinker upgrade`; never edit its files.
- `.tinker/`: generated config, route tree, and parts.
  It is ignored by git; never edit it by hand.
- `src/lib/tinker.ts`: your browser values and `Register` types.
- `src/lib/tinker.server.ts`: your server values.
- `src/backend/`: database, auth, mail, and feature operations.
- `src/frontend/`: saved data, drafts, actions, and views.
- `src/contracts/`: readers for raw input and wire values.
- `src/transport/`: Start server functions.
- `src/routes/`: pages and HTTP routes.
- `drizzle/`: checked-in database migrations.
- `tests/`: scope tests and database/mail presets.
- `.agents/skills/`: short guides for app changes.

`.tinker/routeTree.gen.ts` is generated.
Never edit it by hand.
Native clients load inside their resource factories.
The browser build refuses server imports.

## Rules

Use a tag for settings, data for changing state,
a resource for a shared client, and an operation for an action.
Code outside these four forms needs a TSDoc reason.
Read `AGENTS.md` and the skill for the work you are doing.
The base reaches your code through the two lib seams.
`Register` fills its open types with your feature bodies.

A mutation returns an execution ID.
Sync applies saved changes, then ends the wait for that ID.
Remote changes use that same path.
Draft text stays separate from saved data.
A profile save is complete after commit and mail acceptance.
Mail failure gives a partial result and keeps the saved name.
Retry sends mail without saving the name again.
The profile shows your email and the last result.

The stream checks auth at open, once per wake, and on heartbeats.
Private route guards check the account with the server each time.
Route loads reuse the tab's snapshot while the account stays the same.
A signed-out private route checks only the account before redirecting.
Account exit cancels waits and starts a new snapshot lifetime.
Scope close cancels response readers left open by their consumer.

## Glue and seams

`vite.config.ts`:

```ts
import { defineConfig } from "vite-plus";
import { tinker } from "@tinker/start/vite";
export default defineConfig({
  plugins: [tinker({ auth: true, sync: true })],
});
```

`tsconfig.json`:

```json
{ "extends": "./.tinker/tsconfig.json" }
```

`src/lib/tinker.server.ts`:

```ts
import { databaseSetup } from "../backend/database.ts";
export const extensions = [databaseSetup];
export { database } from "../backend/database.ts";
export { auth, readAccount } from "../backend/auth.ts";
export { bootstrap } from "../backend/sync.ts";
```

`src/lib/tinker.ts`:

```ts
export const extensions = [];
export { records } from "../frontend/records.ts";
export { readBatch, readBootstrap, readSnapshot, streamMessage } from "../contracts/sync.ts";
import type { FeatureSync } from "../contracts/sync.ts";
declare module "@tinker/start" {
  interface Register {
    change: FeatureSync.Change;
    result: FeatureSync.Result;
    public: FeatureSync.Public;
    private: FeatureSync.Private;
  }
}
```

## Checks

From this repo's root:

```bash
vp run @tinker-start-scaffold#check
```

It runs every named app check, one at a time.
The Compose proof starts its own Postgres and Mailpit.
It needs Docker, curl, and agent-browser with Lightpanda.
It stops its servers and removes its own volumes.

Each check also has a name in `package.json`:

- `check:plain`: strict app forms and HTTP rules.
  It reads base symbols and checks `PLAIN.md`.
- `test:schema`: generate from a fresh prepared copy.
  No new migration may appear.
- `test:imports`: importing app units starts no services.
  Drizzle table declarations may load.
  Native drivers, auth, and mail clients may not load.
- `test:middleware`: native request and function calls
  share one session; SSE replays and closes.
- `test:serve`: the base host serves a native JSON reply.
- `test:seam:fixture`: notes compile with their own
  Register bodies and the installed base.
- `test:registry`: built items match source;
  their complete app builds in a scratch folder.
- `test:compose`: real auth, SMTP, migrations,
  and two tabs sharing a todo through sync.

`registry:build` writes the local registry payloads.
It publishes nothing.
Build, type checks, and scope tests run separately:

```bash
npm run build
npm run typecheck
npm test
npm run doctor
npm run check:plain -- --prove
```

Doctor 5 checks the names the base reads from the seams.
Doctor 6 checks imports through the base's public entries.
It also reads module declarations and import-equals.
An absolute path into the base fails too.
Doctor 10 reads the last build's import violations.
The plugin already refuses server code in a browser.
The old seam and boundary scripts are removed.
Their base rules are already checked there.

Tests use `createScope` and app operations.
They run no framework, server, build, or browser.
The named proof scripts run those outside tests.

## Example items

The local registry has these copy-in items:

- `todos-example`: todo table, operations, view,
  contracts, route, and server functions.
- `profile-example`: profile operations, form,
  actions, route, and server functions.
- `auth-pages-example`: auth resource, auth tables,
  sign-in actions, credentials, and public page.
- `mail-example`: SMTP settings, client, and send action.
- `counter-example`: shared counter and its view.
- `example-wiring`: shared state, sync bodies,
  seams, UI, database, and migrations.

The items share this demo's sync bodies and page links.
They are copy-in parts for an app with that wiring.
`postgres-auth-mail-example` joins all of them.
`starter` adds the app files once.
`runtime` now installs `@tinker/start@0.6.0` only.
It copies no runtime source.

Auth and profile forms and actions have separate files.
Shared error text stays in `src/frontend/error-text.ts`.
The old action entry re-exports them for existing tests.

Upgrade the base with `tinker upgrade`.
Review newer example files before copying them.
Never re-apply the app package file to update the base.
A clean registry CLI install and separate app template
belong to card `start/shadcn-registry`.
Publishing waits for the user's go.

## Promises tested through app scopes

- Real accounts can sign up, sign in, sign out, and save a profile.
- Signed-out private writes open no transaction.
- Refused work leaves the server root usable.
- Failed transactions keep old data and publish no saved change.
- A native commit failure never returns a saved profile.
- Email check and reset callbacks use the declared mail action.
- Accounts can read and change only their own todos and event stream.
- Another account's todo ID cannot change or delete its row.
- Empty titles and caller-selected owners are refused.
- Concurrent public writes replay in commit order.
- Repeated execution IDs do not repeat saved effects.
- Events before receipts finish waits after saved records are applied.
- Replayed events and old snapshots keep newer records and drafts.
- Account exit stops waits and ignores late old responses.
- Failed mail keeps the name and retry sends only mail.
- Committed profile work finishes after its request exits.
- Saved names stay readable while duplicate requests share a send.
- Commit wakes SSE; rollback publishes no wake.
- SSE replays saved events and refuses another account's cursor.
- A revoked session receives no queued private rows.
- A quiet private stream closes at the heartbeat after sign-out.
- A final result replay completes a wait after disconnect.
  The base owns the request, HTTP, telemetry, and tab tests.
  Read `@tinker/start`'s README for those promises.

## Limits

Event history has no retention rule yet.
SSE replays stored events; it is not a durable job queue.
A crash after commit can leave mail without a final result.
A crash after SMTP acceptance can cause a resend.
One send across several server processes is not promised.
SMTP acceptance means the server accepted mail.
Mailpit lets you see that message in local development.
Storage failure can drop records when its bounded queue fills.

## App HTTP rules

Use `httpRequest` from `@tinker/start/server`.
Map its reply to a feature value or managed error.
Tests bind `httpBackend` from `@tinker/start/testing`.
App code may not use that tag or the raw `http` resource.

The plain check refuses built-in fetch, raw HTTP clients,
computed module loads, and createRequire in app code.
It refuses raw request headers outside the auth resource.
Replies belong to routes; operations take plain params.
Operations never take Request or return Response.
Native WebSocket and EventSource remain allowed.
Their resources own and close the connection.
