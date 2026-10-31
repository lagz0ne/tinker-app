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

Setup starts the local Compose services and installs packages.
Fill the required tags in cmds/server.ts before starting the app.
Setup never writes secrets, commands, or app wiring.
Open `http://localhost:4318` when dev starts.

## Layout and rules

| Path                 | Owns                                                                             |
| -------------------- | -------------------------------------------------------------------------------- |
| `cmds/server.ts`     | Server roots, settings, auth hooks, sync slots, and shutdown                     |
| `cmds/router.ts`     | Browser roots, router options, records, and reader slots                         |
| `cmds/start.ts`      | CSRF, requests, and app middleware in order                                      |
| `src/`               | App business code in src/demo, routes, UI, transport, root shell, and styles     |
| `tinker/base/`       | Entry, close, panics, and observer hand-off                                      |
| `tinker/components/` | Copied errors, requests, health, http, database, auth, telemetry, sync, and mail |
| `tests/runtime/`     | Tests for the copied runtime, with strict type isolation                         |

Commands import only `~/base`, `~/components`, `@/`, and `@tinker/core`.
Src imports components and npm packages, plus its own source.
Components declare direct `requires` in `component.json`; they never import src, cmds, or base.
Base imports requests and errors. Commands choose optional components and pass their native router options and observers.
Imports omit TypeScript file endings. Keep blank-line steps in function bodies.

Choose tags for fixed inputs, data for changing records, resources for owned clients,
and operations for actions. Read [AGENTS.md](AGENTS.md) and the copied skills before editing.
No module owns an app scope outside commands or copied entry code.
The plain-function cap is 17. Only named entry functions have exceptions.
Only cmds/router.ts#getRouter and cmds/server.ts#main have approved cmd entry exceptions; no component or src function is skipped.

## Command wiring

Follow the [current authoring contract](https://github.com/lagz0ne/tinker-app/blob/main/docs/decisions/start-decompose.md) and the actual
[server](cmds/server.ts) and [router](cmds/router.ts) commands. They show inline
config bindings and the full owned close order. Auth imports its sync/mail work
directly; sync's app readers and records still use required tags.

## MCP and sign-in with a code

`mcp` serves tools to MCP clients such as Claude. `auth-sqlite` gives them OAuth and the
`approve_signin`, `list_signins`, and `end_signin` operations. Bind `mcpServer` and `mcpTools`
on the root, and install `mcpRuns` there. Each tool row names the operation and its own input.
Send `/api/auth/*`, `/.well-known/oauth-protected-resource*`, and
`/.well-known/oauth-authorization-server/api/auth` to `handleAuth`. Wire `/mcp` like this:

```ts
const answer = await root.run(checkMcpToken, {
  input: {
    authorizationHeader: request.headers.get("authorization"),
    dpopProofJwt: request.headers.get("dpop"),
    method: request.method,
    url: request.url,
  },
});
if (answer.challenge) return new Response(JSON.stringify(answer.challenge.body), answer.challenge);

return root.run(handleMcp, { input: request, tags: mcpCaller(answer.caller), signal: request.signal });
```

`tests/mcp-live-sqlite.test.ts` runs all of it over a real socket.

## Registry items and app ownership

Build JSON from the actual app source:

```bash
vp run registry:build
vp run test:registry
```

There is one item per component. Its `registryDependencies` equal its direct `requires`.
`demo` ships app-owned business code in `src/demo`, with its own paths and no component manifest.
Code imports each demo owner file directly. There is no demo barrel (rule I4).
Copy the example once; edit later app changes by hand. Never apply a whole-component update to it.
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
+import type { Sync } from "~/components/sync";

-export const Route = createRootRoute({
+export const Route = createRootRouteWithContext<{
+  bootstrap: () => Promise<Sync.Snapshot>;
+  account: () => Promise<string | null>;
+}>()({
```

Keep the shell's HTML, `<Outlet />`, and stylesheet link. Mount the AuthSession
shown in examples/demo-root.tsx so active logins renew through explicit POST.
Copy `examples/demo-style.css` into `src/style.css`, keeping your own styles.
Read the required tag list in `examples/demo.env.example`; bind each tag in cmds/server.ts.
No installer writes `.env`, a secret, or these app edits.

Components take typed tags. They never take env objects or convert env values.
Startup extensions check host config and startup slots; request tags are bound per call.

| Component   | Required tags                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| auth        | authSettings                                                                                                 |
| database    | databaseUrl                                                                                                  |
| mail        | smtpUrl, mailFrom                                                                                            |
| telemetry   | telemetrySide, telemetryService; tracesUrl and logsUrl on the server                                         |
| requests    | backendStop                                                                                                  |
| sync server | syncSide("server"), bootstrapSlot, readAccountSlot                                                           |
| sync tab    | syncSide("tab"), tabStop, recordsSlot, readBatchSlot, readBootstrapSlot, readSnapshotSlot, streamMessageSlot |

Telemetry keeps safe defaults: logLevel info (30) and spanHistory 80.
The server command accepts LOG_LEVEL as 20 (debug), 30 (info), 40 (warn), or 50 (error).
A bad value fails start and names telemetry.logLevel.

Auth imports sync and mail directly. authStartup checks authSettings before ready.
See the [current auth contract](https://github.com/lagz0ne/tinker-app/blob/main/docs/decisions/start-decompose.md#auth-and-account-streams)
for hook calls and their owner.
Doctor checks component dependencies and imports from JSON; it does not read app config.
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

Default exports pin the released Start 0.15.0 host and its matching registry.
Start 0.9.0 cannot run these templates. Local proofs pass an explicit current
host pack; the export carries it in vendor and checks its host files against
this source. Nothing is published.

The export copies source. It never changes template branches or another checkout.
The golden runtime is `tinker/`. Each push to the trunk runs the changed-line mutation
gate at floor 60; the weekly full run is a report. `packages/start` stays at 85.

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

## Deploy

`npm start` uses the `tinker serve` host from the `@tinker/start` dev dependency.
Keep dev dependencies installed on the server; an `npm install --omit=dev` install cannot start it.
Templates use the Start 0.15.0 contract. Default installs use its released host
and registry.
Local registry proofs use a packed Start through `TINKER_PACKAGE_DIR`.
The standalone export proof supplies a current host pack explicitly.

## Durable mail worker

Auth callbacks await a saved mail row. Better Auth writes through its own pool
adapter, outside the session transaction, so auth enqueue is a separate call.
App writes can call enqueueMail in their own transaction. SMTP can deliver more
than once after acceptance followed by a lost acknowledgement.

Build and run the starter's worker beside its server:

```bash
npm run build:worker
npm run worker
```

Both await the same migration lock. The worker uses DATABASE_URL, SMTP_URL, and
SMTP_FROM from the local .env or host environment. It claims up to 20 rows, sends
outside locks, and saves results by lease token. OUTBOX_LEASE_MS defaults to
180000 and must be at least 120000. A send starts only while its send and ack
budgets fit in the remaining lease. Released unsent claims refund their attempt.
OUTBOX_SMTP_TIMEOUT_MS defaults to 3000 and may only shorten it.

Worker traces use side worker. Stdout and bounded history work without a
collector. To enable export, bind both VICTORIA_TRACES_URL and VICTORIA_LOGS_URL;
setting only one is a startup config error. OTEL_SERVICE_NAME defaults to
tinker-worker. Work closes before the existing bounded telemetry flush.
