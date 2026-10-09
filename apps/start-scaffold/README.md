# Your Start app

A shared counter, accounts, profiles, and private todos.
The app uses Postgres, Better Auth, and SMTP.
Victoria stores traces and logs.

## Start

This app runs on the package `@tinker/start`.
The base owns entries, telemetry, auth routes, and sync.
Core, React, and Start come from one GitHub release tag.
The `0.7.0` release is prepared locally; it is not published.
After the lead publishes it, start in an empty folder:

```bash
npx shadcn@4.21.0 add https://raw.githubusercontent.com/lagz0ne/tinkered/start-v0.7.0/apps/start-scaffold/public/r/app.json --yes
```

This is the smallest app, with telemetry on.
The items below add the full demo.

From your project folder:

```bash
cp .env.example .env
npm install
```

For a copied demo, use `examples/demo.env.example`
in place of `.env.example`.
Set `AUTH_SECRET` in `.env` to a long random value.
The other sample values point at the local compose stack.
SMTP user and password may be empty for Mailpit.

```bash
docker compose pull
docker compose up -d --wait
npm run dev
```

Open `http://localhost:4318`.
For a copied demo, open its `/demo` page.
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
Requests share one auth instance.
Backend files use `.server.ts`; server functions use `.functions.ts`.
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
Sign-up and password reset do not wait for mail.
Auth mail failure writes `mail.failed` to the log sink.
Profile save and retry return a receipt without waiting for mail.
A profile save is complete after commit and mail acceptance.
Mail failure gives a partial result and keeps the saved name.
Retry sends mail without saving the name again.
The process owns sends and waits for them on graceful close.
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
import { databaseSetup } from "../backend/database.server";
export const extensions = [databaseSetup];
export { database } from "../backend/database.server";
export { auth, readAccount } from "../backend/auth.server";
export { bootstrap } from "../backend/sync.server";
```

Read the filled [browser seam](src/lib/tinker.ts) for
records, wire readers, and the app's `Register` bodies.

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
vp test
npm run doctor
node scripts/check-plain.mjs --prove
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

## Local registry

The registry is built from source.
It publishes nothing.
`app` writes the smallest app once.
Its package and page come from `apps/start-min`.
Its two seams start with empty extensions.
Its config uses `tinker()` and the generated tsconfig.
The base stays in `node_modules/@tinker/start`.

Run the full local proof from this repo's root:

```bash
node apps/start-scaffold/maintain/proof-registry.mjs
```

It packs Core, React, and Start without publishing.
It serves the registry at 127.0.0.1.
It starts from an empty folder and runs real shadcn.
It builds, runs doctor, and curls the served page.
It adds examples and checks a changed source with `--diff`.
It upgrades to a local 0.7.1 version-bump fixture.
It checks user files stay the same, then stops each server
by its own PID.
The scratch folder stays for review.
The printed local URL works only during that proof.

For a local registry you keep running, pack these first:

```bash
mkdir -p /tmp/tinker-packs
vp pm --dir packages/core pack \
  --pack-destination /tmp/tinker-packs
vp pm --dir packages/react pack \
  --pack-destination /tmp/tinker-packs
node packages/start/scripts/pack.mjs /tmp/tinker-packs
```

Build with a local package override:

```bash
export TINKER_PACKAGE_DIR=/tmp/tinker-packs
TINKER_REGISTRY_URL=http://127.0.0.1:4870/r
export TINKER_REGISTRY_URL
vp run @tinker-start-scaffold#registry:build
```

`TINKER_PACKAGE_DIR` writes absolute `file:` tarball specs.
They work on this machine only.
`TINKER_REGISTRY_URL` sets links between example items.
`TINKER_REGISTRY_OUT` can keep proof output outside this repo.
Without the overrides, builds use GitHub release URLs
and raw GitHub registry URLs at the same tag.
Run `registry:build` again without overrides before committing.
`test:registry` rejects built items that differ from source.

Serve it from this repo root:

```bash
python3 -m http.server 4870 --bind 127.0.0.1 \
  --directory apps/start-scaffold/public
```

Stop that server with Ctrl-C when you finish.
From an empty app folder, the one install command is:

```bash
npx shadcn@4.21.0 add \
  http://127.0.0.1:4870/r/app.json --yes
```

Then run:

```bash
npm install
vp build
npx tinker doctor
npm start
```

Never re-apply `app` to update an app.
Upgrade its base with `tinker upgrade`.
Review example changes with `shadcn add --diff`.

## Example items

Examples add their own files.
They never replace the app's config, first page, or seams.
The registry build refuses a protected app target.
It also refuses two items that own the same target.

- `mail-example`: SMTP settings, client, send action, and errors.
  No base part or seam export is needed.
  SMTP settings are needed only when sending mail.
- `postgres-auth-mail-example`: the shared demo bodies,
  migrations, UI, and a new page at `/demo`.
  It depends on mail.
- `todos-example`, `profile-example`, `auth-pages-example`,
  `counter-example`, and `example-wiring`:
  each adds its own requirements file.
  Each depends on the shared demo.
- `starter`: the shared demo plus tests and guides.
  Add it to an existing `app`; it adds no app template files.
- `runtime`: a package-only item for old users.

The demo's feature bodies stay joined.
Adding one feature installs the whole shared demo.
The first page stays yours; the demo starts at `/demo`.
Its copied env sample is `examples/demo.env.example`.
No example writes `.env` or a secret.

Every example states `meta.parts` and `meta.seams`.
A copied `src/examples/<item>.tinker.json` file keeps
those needs beside the app, so doctor needs no network.
Doctor names each missing switch and the exact export line.
It also names a database startup extension missing from
an existing empty extensions list.

From an app made with `app`:

```bash
npx shadcn@4.21.0 add \
  http://127.0.0.1:4870/r/todos-example.json --yes
npx tinker doctor
```

Keep your config and add these switches to its `tinker()` call:

```ts
tinker({ auth: true, sync: true });
```

Keep your server extensions and add `databaseSetup`.
The other server exports doctor names are:

```ts
export { database } from "../backend/database.server";
export { auth } from "../backend/auth.server";
export { readAccount } from "../backend/auth.server";
export { bootstrap } from "../backend/sync.server";
```

For an empty server seam, the filled startup list is:

```ts
export { extensions } from "../examples/demo.server";
```

The browser seam exports the copied demo's readers and types:

```ts
export { records, readSnapshot, readBootstrap, readBatch, streamMessage } from "../examples/demo";
```

The copied module also adds the app's `Register` bodies.
For a server seam with your own extensions, keep that list
and join the demo's startup extension:

```ts
import { databaseSetup } from "../backend/database.server";
export const extensions = [databaseSetup];
```

Then set the env values and check:

```bash
cp examples/demo.env.example .env
vp build
npx tinker doctor
```

Build and doctor need no running Postgres or SMTP.
Serving the joined demo needs Postgres and SMTP settings.
The server applies migrations at startup.
Auth needs `AUTH_SECRET` and `PUBLIC_ORIGIN`.
Sync uses auth and the database.
Telemetry is on by default.

Run the proof of safe example adds:

```bash
node apps/start-scaffold/maintain/\
  proof-no-overwrite.mjs
```

It uses real shadcn and a local registry at 127.0.0.1.
Each item is added to a fresh app without overwrite.
It checks config and seam hashes before applying doctor's lines.
All servers stop by their own PID.
Nothing is published.

Review newer mail source without writing any file:

```bash
npx shadcn@4.21.0 add \
  http://127.0.0.1:4870/r/mail-example.json \
  --diff src/backend/mail.server.ts
```

Publishing waits for the user's go.
No account or domain is needed for an app install.
[The release steps](../../docs/roadmap/start-base/RELEASE.md)
name the tag, assets, and raw GitHub registry paths.
No package or registry is published by the local scripts.

## Promises tested through app scopes

- Real accounts can sign up, sign in, sign out, and save a profile.
- Releasing mail makes a fresh sender.
- Releasing database makes a fresh handle.
- A bad stored event returns a managed input failure.
- A bad stored notification result has no retry available.
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
  A held SSE reader receives the next saved batch.
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
