# Your Start app

A shared counter, accounts, profiles, private todos, and mail.
Postgres stores app data. Better Auth owns accounts. SMTP sends mail.
Victoria stores traces and logs.

## Start

The app owns its runtime in `tinker/base` and `tinker/components`.
`@tinker/start` is a dev dependency for builds, doctor, and the Node host.
Core and React come from the immutable tarball URLs in `package.json`.

```bash
npm run setup
npm run dev
```

Setup writes `.env` with a new secret, starts the local Compose services,
and installs packages. It never writes commands or app wiring.
Open `http://localhost:4318` when dev starts.

## Layout and rules

| Path                 | Owns                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------- |
| `cmds/server.ts`     | Server roots, settings, auth hooks, sync slots, and shutdown                           |
| `cmds/router.ts`     | Browser roots, router options, records, and reader slots                               |
| `cmds/start.ts`      | The Start middleware hand-off                                                          |
| `src/`               | App routes, UI, transport, root shell, and styles                                      |
| `tinker/base/`       | Entry, close, panics, and observer hand-off                                            |
| `tinker/components/` | Copied errors, requests, health, http, database, auth, telemetry, sync, mail, and demo |
| `tests/runtime/`     | Tests for the copied runtime, with strict type isolation                               |

Commands import only `~/base`, `~/components`, `@/`, and `@tinker/core`.
Src imports components and npm packages, plus its own source.
Components declare direct `requires` in `component.json`; they never import src, cmds, or base.
Base imports requests and errors; the commands pass optional parts into it.
Imports omit TypeScript file endings. Keep blank-line steps in function bodies.

Choose tags for fixed inputs, data for changing records, resources for owned clients,
and operations for actions. Read [AGENTS.md](AGENTS.md) and the copied skills before editing.
No module owns an app scope outside commands or copied entry code.
The plain-function cap is 17. Only the named copied base entry functions have exceptions.
No component, src, or cmd function is skipped.

## Command wiring

Vite names the server command, with no part switches:

```ts
tinker({ serverEntry: "cmds/server.ts" });
```

The command reads env once and calls each component's `settings(values)`.
It starts telemetry before the app, borrows its observer, and closes roots in reverse order.
The full working pattern is in [cmds/server.ts](cmds/server.ts).
These are the actual auth hooks and server slots inside its tags list:

```ts
bootstrapSlot(bootstrap),
readAccountSlot(readAccount),
sendAuthMail((message) => app.resolve(mail.authMail).enqueue(message)),
sessionDeleted((accountId) => app.run(publishAccountNotice, { rawInput: { accountId } })),
```

Auth's two hooks are required and have no defaults.
A missing hook fails `root.ready` with its name and the command file to edit.
Auth depends only on errors, requests, and database; the command joins mail and sync.

The browser command binds each app-owned reader and records descriptor:

```ts
recordsSlot(records),
readBatchSlot(readBatch),
readBootstrapSlot(readBootstrap),
readSnapshotSlot(readSnapshot),
streamMessageSlot(streamMessage),
```

Read [cmds/router.ts](cmds/router.ts) for the full pattern.
The demo declares its sync bodies at `~/components/sync`.
Every route and server function uses the same copied requests middleware.
There are no generated wiring modules or role files.

## Registry items and app ownership

Build JSON from the actual app source:

```bash
vp run registry:build
vp run test:registry
```

There is one item per component. Its `registryDependencies` equal its direct `requires`.
`base` owns the copied entry helpers. `app` adds base, health, telemetry, and user files
into an empty folder. Examples add their own files and never overwrite app files.
The build refuses two owners for one path and any example aimed at a protected app path.

For a local registry served at `http://127.0.0.1:4870/r`, start in an empty folder:

```bash
npx shadcn@4.21.0 add http://127.0.0.1:4870/r/app.json --yes --overwrite
npm install
vp build
npx tinker doctor
npm start
```

Use `maintain/build-registry.mjs` with `TINKER_REGISTRY_OUT` and `TINKER_REGISTRY_URL`
to write payloads for a local HTTP server. `TINKER_PACKAGE_DIR` selects a locally packed Start.
No command here publishes a registry or package.

Use that first install only in an empty folder. `--overwrite` replaces the dependency
stub that shadcn creates before copying the app package file.
Example installs use no overwrite flag.

Never re-apply `app`. Review a copied component with `shadcn add --diff`.
An update replaces that component whole. It does not merge changes into user code.
The old runtime package item and `tinker upgrade` are retired.

`postgres-auth-mail-example` keeps the demo bodies, migrations, and UI together.
It adds a `/demo` page and leaves your first page alone.
`todos-example`, `profile-example`, `auth-pages-example`, `counter-example`,
and `example-wiring` depend on that shared demo.
`mail-example` adds only the mail component and its declared dependencies.
`starter` adds the shared demo, tests, and guides to an existing app.

After an example install, wire its command slots by hand as shown above.
The app owns `src/routes/__root.tsx` and `src/style.css`.
The demo ships actual scaffold source as `examples/demo-root.tsx`
and `examples/demo-style.css`. Read both, then copy their shape by hand.
For the untouched `app` shell, the exact edits are:

```diff
-import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
+import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
+
+import type { Sync } from "~/components/demo";

-export const Route = createRootRoute({
+export const Route = createRootRouteWithContext<{
+  bootstrap: () => Promise<Sync.Snapshot>;
+  account: () => Promise<string | null>;
+}>()({
```

Keep the shell's HTML, `<Outlet />`, and stylesheet link.
Copy `examples/demo-style.css` into `src/style.css`, keeping your own styles.
Set the keys from `examples/demo.env.example` in your own `.env`.
No installer writes `.env`, a secret, or these app edits.

Doctor reads env rules from copied `component.json` files, without importing runtime code.
A build starts no Postgres or SMTP client. A running demo needs both services.
Its database startup applies the committed migrations.

## Checks and local copies

Run heavy jobs one at a time:

```bash
VITEST_MAX_WORKERS=1 VP_RUN_CONCURRENCY_LIMIT=1 vp build
VITEST_MAX_WORKERS=1 VP_RUN_CONCURRENCY_LIMIT=1 vp check
VITEST_MAX_WORKERS=1 VP_RUN_CONCURRENCY_LIMIT=1 vp test
node scripts/check-plain.mjs
node scripts/check-plain.mjs --prove
npm run doctor
node scripts/check-schema.mjs
```

The native proof in `maintain/scaffold-proof.mjs` uses real Postgres, SMTP, and two tabs.
Entry proofs cover HMR, full reload, root close, render observers, and panic cleanup.
Registry proofs check source equality, direct dependencies, protected paths, and real copies.
The notes fixture builds another app's sync bodies with no demo files.

From the workspace root, copy both templates into a new empty output folder:

```bash
node apps/start-scaffold/maintain/template-sync.mjs /tmp/tinker-app-export
```

The export copies source. It never changes template branches or another checkout.
The golden runtime is `tinker/`; its mutation floor is 85. The lander runs mutation checks.

## Promises tested through app scopes

- Real accounts can sign up, sign in, sign out, and save a profile.
- Releasing mail makes a fresh sender.
- Releasing database makes a fresh handle.
- A bad stored event fails with StoredDataInvalid, a server failure, never a rejected change.
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
- A private route check clears cached records after another tab signs out.
- Failed mail keeps the name and retry sends only mail.
- Committed profile work finishes after its request exits.
- Saved names stay readable while duplicate requests share a send.
- Commit wakes SSE; rollback publishes no wake.
- SSE replays saved events and refuses another account's cursor.
  A held SSE reader receives the next saved batch.
- A revoked session receives no queued private rows.
- A quiet private stream closes at the heartbeat after sign-out.
- A final result replay completes a wait after disconnect.
  The copied runtime tests cover request, HTTP, telemetry, and tab work.

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

Use `httpRequest` from `~/components/http/index.server`.
Map its reply to a feature value or managed error.
Tests bind `httpBackend` from `~/components/http`.
App code may not use that tag or the raw `http` resource.

The plain check refuses built-in fetch, raw HTTP clients,
computed module loads, and createRequire in app code.
It refuses raw request headers outside the auth resource.
Replies belong to routes; operations take plain params.
Operations never take Request or return Response.
Native WebSocket and EventSource remain allowed.
Their resources own and close the connection.
