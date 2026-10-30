# Upgrade

## 0.13.0

Start 0.13.0 is released from `lagz0ne/tinker-app`, tag `start-v0.13.0`.
The tag holds the Start tarball only. Core and React stay on 0.9.0:

```json
"@tinker/core": "https://github.com/lagz0ne/tinkered/releases/download/start-v0.9.0/tinker-core-0.9.0.tgz",
"@tinker/react": "https://github.com/lagz0ne/tinkered/releases/download/start-v0.9.0/tinker-react-0.9.0.tgz",
"@tinker/start": "https://github.com/lagz0ne/tinker-app/releases/download/start-v0.13.0/tinker-start-0.13.0.tgz"
```

Change the Start URL in your `package.json`, then run `pnpm install`.
The registry now reads from
`https://raw.githubusercontent.com/lagz0ne/tinker-app/start-v0.13.0/apps/start-scaffold/public/r`.
Exports refuse a tooling version below 0.13.0.

### The SQLite set

Three new components are a second database set
(ADR `docs/decisions/sqlite-variants.md`). An app picks one set.

- `database-sqlite`: the same public names as `database` (`database`,
  `databaseSetup`, `migrate`, `transaction`, `databaseUrl`), on `node:sqlite`.
  `databaseUrl` takes a `file:` URL. One write transaction per process at a
  time (`BEGIN IMMEDIATE`); reads use their own connection (WAL). `migrate`
  runs each new numbered `.sql` file in `databaseMigrationsFolder` (default
  `migrations`, relative to the working folder) and records it in
  `start_migrations`. `listen` and `notify` use a `start_notify` table.
- `auth-sqlite`: Better Auth on the `DatabaseSync` through its Kysely
  dialect. No Drizzle adapter.
- `sync-sqlite`: the sync twin. JSON columns are `text`; the publish step
  notifies in the same transaction, so there is no trigger.

Queries are plain `.sql` files, typed and run by Reylo 0.6.0
(`import readUser from "./read_user.sql"`, then `.runSync()`).
The migration files are the schema: no Drizzle and no `drizzle-kit generate`.
There is no `mail-sqlite`; an app on the SQLite set sends no mail yet.
The Postgres set (`database`, `auth`, `sync`, `mail`) is unchanged and keeps Drizzle.

### The toolchain the SQLite set needs

- TypeScript `7.1.0-beta`, also in `overrides`. The type check runs
  `tsc --noEmit --runExternalCode`.
- `reylo` 0.6.0 (dependency) and `@reylosql/sqlite` 0.6.0 (dev dependency).
- For `auth-sqlite`: `kysely` 0.29.6 and `@better-auth/kysely-adapter` 1.7.7,
  with the `overrides` `@better-auth/core` 1.7.7, `@better-auth/utils` 0.4.2
  and `better-call` 1.4.0.
- `reylo()` from `reylo/vite` first in the plugins of `vite.config.ts`, and
  in `vitest.config.ts`, which also runs
  `test.globalSetup: ["./maintain/sqlite-dev-db.mjs"]`.
- `"contentMappers": [{ "package": "reylo", "extensions": [".sql", ".reylo.yaml", ".reylo.yml"] }]`
  in `tsconfig.json`.
- `.reylo.yaml` with `direct_url: file:./.tinker/sqlite-dev.db`, and
  `maintain/sqlite-dev-db.mjs`, which rebuilds that dev database from
  `sqlite/migrations` (or `migrations`). The `typecheck` script runs it first:
  `node maintain/sqlite-dev-db.mjs && DATABASE_URL=file:.tinker/sqlite-dev.db node node_modules/typescript/bin/tsc --noEmit --runExternalCode`.
- Node 24 or later.

The registry marks the three items `meta.starterOnly`, because the `app` item
has none of this toolchain. `tinker add database-sqlite` refuses them in an
existing app, and `tinker update` refuses them too. An app gets them from the
demo template, as below, and updates them by the next template update.

### Move an app made from demo-v0.12.0

The demo template now carries both sets. Bring its changes in as a template
update: apply the template's own diff from `demo-v0.12.0` to `demo-v0.13.0` as
a 3-way merge. Your local changes stay. The app must be a git repository
(a degit copy is not one until you run `git init` and commit), and the work
must be committed first: `git apply --3way` applies to the index.

```bash
git fetch --no-tags https://github.com/lagz0ne/tinker-app.git \
  refs/tags/demo-v0.12.0:refs/tags/demo-v0.12.0 \
  refs/tags/demo-v0.13.0:refs/tags/demo-v0.13.0
git diff --binary demo-v0.12.0 demo-v0.13.0 | git apply --3way
```

Fix any conflict, then run `npm install` (or `pnpm install`) and `npm run typecheck`.
The app still runs on Postgres. To move it to SQLite:

1. In `cmds/server.ts`, `cmds/router.ts`, `src/routes/__root.tsx`,
   `src/routes/api.auth.$.ts`, `src/routes/api.sync.ts`, and app files that
   import `~/components/sync` (such as the demo's `src/frontend/Todos.tsx` and
   `src/demo/frontend/state.ts`), import from `~/components/database-sqlite`,
   `~/components/auth-sqlite` and `~/components/sync-sqlite`. Drop `mail` and
   its tags. Drop the mail worker: `cmds/worker.ts`, `vite.worker.config.ts`,
   `maintain/worker.mjs`, and the `worker` and `build:worker` scripts.
   `database-sqlite` has no connect, lock or statement timeout tags.
2. Resolve `DATABASE_URL` against the working folder, so `file:./data/app.db`
   stays inside the app: `databaseUrl(new URL(env.DATABASE_URL, pathToFileURL(cwd + "/")))`.
   A bare `new URL("file:./data/app.db")` is `/data/app.db`.
   `node:sqlite` does not make the folder; make it first.
3. Bind `databaseMigrationsFolder("sqlite/migrations")`: the template keeps
   the SQLite migrations there, and the default is `migrations`.
4. Move your app code off Drizzle onto `.sql` files, then delete the Postgres
   components, `drizzle/`, `drizzle.config.ts`, their tests, and
   `drizzle-orm`, `drizzle-kit`, `pg`, `nodemailer` and their types.

### Other changes

- `tinker add <name>`, `tinker update <name> [--force]` and `tinker check`
  manage copied components. `add` copies a component and the ones it
  requires, merges npm dependencies without changing your specs, writes outside
  files such as migrations, and prints the import lines for `cmds/*.ts`. It
  never writes `cmds/` or `src/`. `update` replaces one component folder whole,
  so a killed update leaves the old folder whole; it refuses local edits unless
  `--force`. `check` reports edited files, unknown components, missing
  requires and interrupted updates, and exits 1 on any finding.
- `mail.server.ts` spells out the options type of `send`: TypeScript 7.1
  stops typing a destructured parameter default from context. Same behavior.
- Start now releases itself: when a version bump lands green on `main`,
  `release.yml` publishes `start-vX.Y.Z` and tags `small-vX.Y.Z` and
  `demo-vX.Y.Z`.

## 0.12.0

Start 0.12.0 is released from `lagz0ne/tinker-app`, tag `start-v0.12.0`.
The tag holds the Start tarball only. Core and React stay on 0.9.0:

```json
"@tinker/core": "https://github.com/lagz0ne/tinkered/releases/download/start-v0.9.0/tinker-core-0.9.0.tgz",
"@tinker/react": "https://github.com/lagz0ne/tinkered/releases/download/start-v0.9.0/tinker-react-0.9.0.tgz",
"@tinker/start": "https://github.com/lagz0ne/tinker-app/releases/download/start-v0.12.0/tinker-start-0.12.0.tgz"
```

Change the Start URL in your `package.json`, then run `pnpm install`.
The registry now reads from
`https://raw.githubusercontent.com/lagz0ne/tinker-app/start-v0.12.0/apps/start-scaffold/public/r`.
Exports refuse a tooling version below 0.12.0.

- Doctor's glue check also accepts `tinker prepare` in the `prepare` script,
  for a package that other apps install. pnpm refuses to install a tarball
  that has a `postinstall` script until the user approves it, and an install
  of a tarball never runs `prepare`. Its pass line then reads
  `prepare runs tinker prepare`. An app keeps `postinstall`, and
  `doctor --fix` still writes `postinstall`.
- `MainContext` gets `cwd`, the folder the process runs in. The host fills it:
  `runMain` and `tinker serve` read the process folder, and `createMainHost`
  takes a `cwd` option that defaults to it. Commands read `cwd` from the
  context, not `process.cwd()`. Copy the new `tinker/base/main.ts`. A test that
  builds a context by hand adds `cwd`, such as `cwd: import.meta.dirname`.
- `runMain` and `tinker serve` stop on SIGHUP with exit 129, as they stop on
  SIGINT (130) and SIGTERM (143).
- Output that goes away no longer fails the run: a reader that closes the
  pipe early, such as `head` (EPIPE), or a closed terminal (EIO on a terminal
  stream). `runMain` and `tinker serve` ignore those on stdout and stderr, and
  the command's exit code stands, such as 129 after a hangup. EIO on a file or
  a pipe is a real write error, and still fails the run.
- The contract adds two rules. A command that owns child processes ends them
  inside the 10-second grace. A command may give exit 2 one documented meaning.
- An app may be CLI-only: `tinker({ cliEntry: "cmds/cli.ts" })` with no
  router, start, or server entry. An app that names any of those three stays a
  web app, and doctor reports the ones it lacks. A CLI-only app needs no
  `src/routes`, and no React or TanStack: those are now optional peers, and
  `tinker()` loads them only for a web app. `tinker prepare` writes no route
  tree for it, and deletes an old one. Doctor skips the routes check and does
  not ask for `.tanstack/` in `.gitignore`. Its `vp build` runs the named check
  and tsc, then builds `cmds/cli.ts` to the `build.outDir` that
  `vite.cli.config.ts` names. The registry's new `base-main` item copies only
  `tinker/base/main.ts`; the web `base` item requires it.
- A CLI-only app may ship its CLI as a package `bin`. The app owns the bin
  file, and `@tinker/start` and `@tinker/core` are its runtime dependencies:

  ```json
  "bin": { "hello": "./bin/hello.mjs" },
  "files": ["bin", "dist-cli"]
  ```

  ```js
  #!/usr/bin/env node
  import { runMain } from "@tinker/start/main-host";

  import main from "../dist-cli/cli.js";

  await runMain(main);
  ```

  Its `vp build` keeps `@tinker/start` and `@tinker/core` as imports, so
  `dist-cli` holds no copy of them. Doctor checks each bin: the file exists,
  it imports the built CLI entry, which is the `build.outDir` in
  `vite.cli.config.ts` plus the entry's name, and `files` lists both.

- A main that returns no `closed` promise, such as `{}` or `{ closed: true }`,
  now fails with exit 1 and prints `main must return closed`. Before, the host
  itself crashed with a TypeError instead of giving an exit code.
- The copied `tinker/base/main.ts` adds `mainErrorCode(error)`: 78 for a
  missing or invalid tag (`MissingTag`, `DataValidationFailed`) or a bad URL,
  else 1. The scaffold's `cmds/server.ts` and `cmds/worker.ts`, and the small
  app's `cmds/server.ts`, call it instead of their own copy of that block. Copy the new
  `tinker/base/main.ts` (registry item `base-main`) before the new commands.
- The copied database pool no longer crashes the process when Postgres drops
  an idle client: it logs `database.idleLost`, and queries still reject. Copy
  the new `tinker/components/database/database.server.ts` (item `database`).
- The copied `tinker/base/router-entry.tsx` drops its own route-tree cache;
  the module loader caches it, and Vite swaps it after a route edit.
- Copied tags with a `parse` schema take their type from it:
  `tag({ parse })`, not `tag<T>({ parse })`. Old copies still type-check.
- The demo drops its forwarding files `src/demo/client.ts`,
  `src/demo/index.server.ts` and `src/frontend/actions.ts`. Callers import
  each owner file. The sync registry augmentation moves to
  `src/demo/contracts/sync.ts`. An app built from the old demo may keep them.
- Start's own tests now kill 89% of its mutants (Stryker floor stays 85).
  The new tests prove the reply writer, the dev entry, the dev host
  registry, compression, static assets, the build plugins, and the source
  readers. No API change.
- Not in the tarball: `@tinker/loop` (private, in this repo) moved onto the
  app layout in loop tickets 5 to 9, with its 120 frozen tests unchanged.
  App pull requests get a changed-line mutation gate at floor 60.

## 0.11.0

Start 0.11.0 is released from `lagz0ne/tinker-app`, tag `start-v0.11.0`.
The tag holds the Start tarball only.
Core and React move to 0.9.0, from the tinkered `start-v0.9.0` release:

```json
"@tinker/core": "https://github.com/lagz0ne/tinkered/releases/download/start-v0.9.0/tinker-core-0.9.0.tgz",
"@tinker/react": "https://github.com/lagz0ne/tinkered/releases/download/start-v0.9.0/tinker-react-0.9.0.tgz",
"@tinker/start": "https://github.com/lagz0ne/tinker-app/releases/download/start-v0.11.0/tinker-start-0.11.0.tgz"
```

Change the three URLs in your `package.json`, then run `pnpm install`.
The registry now reads from
`https://raw.githubusercontent.com/lagz0ne/tinker-app/start-v0.11.0/apps/start-scaffold/public/r`.
Exports refuse a tooling version below 0.11.0.

- Server telemetry leaves the request thread (ADR `docs/decisions/telemetry-worker.md`,
  option B). The request thread writes span and log records to a shared ring;
  `cmds/telemetry-worker.ts` drains it on its own worker thread and exports.
  On start-min, telemetry costs 43 µs per SSR request instead of 127 µs, and
  the sink got 30,002 of 30,002 spans at 10,000 requests under load.
  Apps with their own `cmds/server.ts` take the new `cmds/telemetry-worker.ts`
  and the server wiring from the `app` registry item.

- An extension's `start` hook now has a time limit: 10 s by default.
  The whole start chain counts: the database connect, the migration-owner
  wait (`DATABASE_MIGRATION_TIMEOUT_MS`, default 5000, max 60000), and the
  migrations. On timeout `ready` rejects with `StartTimeout`, naming the
  extension, and the scope closes.
- Every command root that runs `databaseSetup` now passes
  `startTimeout: 70_000`: the 60 s max owner wait plus 10 s for connect
  and DDL. In issue-board that is `cmds/server.ts`, `cmds/worker.ts` and
  `cmds/cli.ts`; in the scaffold, `cmds/server.ts` and `cmds/worker.ts`.
  An app with its own copies adds the same line to each such root.
  `0` turns the timer off.
- The timer sleeps on the scope's clock. A test that counts a test
  clock's sleeps also sees one 10 000 ms sleep at start; pass
  `startTimeout: 0` there (the copied sync and database-ownership tests do).
- New, no edit needed: `event.tap(config)` in a `start` hook adds a
  telemetry sink; `namespace({ observe: false })` keeps a tool's own
  work untraced; faster runs, sessions, writes, and React server renders.
  See the tinkered `start-v0.9.0` release notes for the numbers.

- `mailMaxSenders` (`mail.maxSenders`, default 4) caps SMTP connections; extra sends wait without starting their send deadline.
- An acknowledgement failure counts as a crash attempt; remaining claims keep their leases until expiry.
- `MigrationBusy` exits 1; only migration-lock polling is bounded. DDL has no `lock_timeout`.
- Mail leases use each worker's clock; keep worker hosts' clocks in sync.

- Concurrent mail sends own separate connections; a timeout closes only its send.
  Healthy sends reuse idle connections. The auth mail example carries the outbox
  migrations without requiring starter; exhausted mail has its own partial index.

- Mail leases require at least 120000 ms. Before each send, the worker reserves
  its send deadline, checkout, two SQL statement bounds, and a 1000 ms setup margin.
  Unsent claims released on stop or a short remaining lease refund their attempt.
- Migration proofs exercise all three command entries; the live SQL contract
  also checks the sync event trigger and committed/rolled-back start_sync wakes.

- Worker is a telemetry side. Worker commands keep stdout/history by default;
  setting either VICTORIA_TRACES_URL or VICTORIA_LOGS_URL enables export and
  requires both. OTEL_SERVICE_NAME defaults to tinker-worker. Work closes before
  the bounded telemetry flush; exporter failure cannot replace the work error.

- test:migrations applies the actual chain to fresh local Postgres and checks
  notification trigger shape, empty inserts, rollback, and committed batches.
  Its controls show schema-only checks accept missing or changed trigger SQL.
  CI runs this live gate for both copied apps; no Drizzle trigger claim is made.

- database.listen takes a validated lowercase channel name before its callbacks,
  plus an optional abort signal. Sync passes start_sync; mail passes board_outbox.
  Mail keeps its existing reconnect/backoff and poll using this shared listener.

- Auth mail callbacks await durable enqueue. Better Auth uses its own pool
  adapter, so enqueue has a separate committed call; app writes may enqueue in
  their existing session transaction. Mail owns its table and batch delivery.
  Run the scaffold mail worker beside its server; old in-memory pending sends
  are not migrated. Existing board rows keep their table and dedupe keys.

- Public mail sends have a total deadline (default/max 3000 ms), owned socket
  cleanup, and an optional per-send abort signal. Worker checkout is bounded to
  500 ms; record and COMMIT each have a 750 ms statement bound. Sending,
  acknowledgement, releasing unstarted leases, and the 1500 ms telemetry close
  fit within the 10 s host grace.

- Board workers claim up to 20 mail rows in a short UPDATE/SKIP LOCKED call.
  OUTBOX_LEASE_MS defaults to 180000. Sends hold no row locks; acknowledgements
  require the matching lease token. Attempts survive crashes; exhausted rows
  have dead_at. SMTP remains at least once, including after a lost acknowledgement.

- Server, worker, and CLI startup await one Postgres advisory-lock migration
  owner. DATABASE_MIGRATION_TIMEOUT_MS bounds the ownership wait (default 5000).
  Run every migration on the connection holding the stable TINK/MIGR lock.

## 0.10.0

Start 0.10.0 is released from `lagz0ne/tinker-app`, tag `start-v0.10.0`.
The tag holds the Start tarball only.
Core and React stay at 0.8.0, from the tinkered `start-v0.8.0` release:

```json
"@tinker/core": "https://github.com/lagz0ne/tinkered/releases/download/start-v0.8.0/tinker-core-0.8.0.tgz",
"@tinker/react": "https://github.com/lagz0ne/tinkered/releases/download/start-v0.8.0/tinker-react-0.8.0.tgz",
"@tinker/start": "https://github.com/lagz0ne/tinker-app/releases/download/start-v0.10.0/tinker-start-0.10.0.tgz"
```

The registry now reads from
`https://raw.githubusercontent.com/lagz0ne/tinker-app/start-v0.10.0/apps/start-scaffold/public/r`.

The templates need this host and its matching registry. The 0.9.0 host cannot
run the new main contract; do not mix the new main with the old host. Exports
refuse a tooling version below 0.10.0. See the [authoring contract](https://github.com/lagz0ne/tinker-app/blob/start-v0.10.0/docs/decisions/start-decompose.md).

- Process commands use defineMain with env, args, signal, stdout, stderr, and exit.
  Exit requests cleanup, keeps the first code, prints the reason once, and returns
  a stopped result. A startup exit closes dev; fix config and restart vp dev.
- Writes can use the lazy session transaction resource. Defer joins COMMIT or
  ROLLBACK before the call returns. Idle handles end without checkout; ended
  queries fail; failed transaction SQL destroys the connection. Typed SQL limits
  bound lock and statement waits. Board alert sends have a total send budget.
- Auth directly depends on sync and mail; hook slots and the context bridge are
  removed. Streams are created at sign-up, repaired at sign-in, and backfilled.
  Page reads write no tables; the browser renews aged logins through explicit POST.
- Counter and todo writes also use the owned session transaction. The profile
  mail/retry flow remains an explicit migration; its native transactions are awaited.
- Golden and minimal templates, registry output, and shared tests follow that
  pattern. Start add/update/check is planned; it is not an available command.

The serial gate reads optional workerEntry and cliEntry beside serverEntry.
Each extra entry has its own vite.worker/cli.config file with literal build.ssr
and build.outDir. Build and doctor name those commands; gate:commands compiles
and checks every configured process main with the host, in order. CI runs the
app gates and live PostgreSQL proofs in one serial job.

## 0.9.0

Start 0.9.0 is released from `lagz0ne/tinker-app`, tag `start-v0.9.0`.
The tag holds the Start tarball only.
Core and React stay at 0.8.0, from the tinkered `start-v0.8.0` release:

```json
"@tinker/core": "https://github.com/lagz0ne/tinkered/releases/download/start-v0.8.0/tinker-core-0.8.0.tgz",
"@tinker/react": "https://github.com/lagz0ne/tinkered/releases/download/start-v0.8.0/tinker-react-0.8.0.tgz",
"@tinker/start": "https://github.com/lagz0ne/tinker-app/releases/download/start-v0.9.0/tinker-start-0.9.0.tgz"
```

The registry now reads from
`https://raw.githubusercontent.com/lagz0ne/tinker-app/start-v0.9.0/apps/start-scaffold/public/r`.

Three changes need an app edit:

- Start runtime code is now app source in `tinker/base` and `tinker/components`.
  `@tinker/start` keeps only build tooling, doctor, and the Node host.
  Follow "Move to copied Start components" below.
- Config is tags. Each component names typed config tags.
  Only `cmds/server.ts` reads env and binds those tags.
  A start extension names each missing required tag at boot.
- `cmds/server.ts` exports one async `main`.
  The host calls `main({ env, signal, stdout, stderr })` once, before it listens.
  Main returns `{ fetch, closed }`.
  Aborting `signal` closes the app root, then telemetry.
  `closed` reports the app failure first, then the first teardown error.
  Importing the command must open nothing.

New, with no edit needed:

- Doctor warns when a copied layer imports the wrong way.
- Vite needs all three command paths: `cmds/server.ts`, `cmds/router.ts`, `cmds/start.ts`.
- On a stop signal during startup, the prod host closes the app,
  never listens, and exits 0.

### Move to copied Start components

`@tinker/start` now holds build tooling, doctor, and the Node host.
It has no root, server, client, or testing runtime exports.
There are no part switches, generated wiring, or package defaults for app entries.

1. Copy base, errors, requests, health, and the components your app needs.
   The source lives in `apps/start-scaffold/tinker/`.
2. Put command glue in `cmds/server.ts`, `cmds/router.ts`, and `cmds/start.ts`.
   Read the scaffold's actual commands. Keep your own order and bindings.
3. Import runtime code from `~/components` and entry helpers from `~/base`.
   Import `createScope` directly from `@tinker/core`.
4. Bind auth's required `sendAuthMail` and `sessionDeleted` tags in the server command.
   Bind each sync operation, reader, and records slot in the command that owns it.
   Neither component imports a command or uses a default that imports app work.
5. Point sync's `Register` declaration at `~/components/sync`.
   Move tests from the removed testing barrel to the copied component files.
6. Keep an app-owned root route and stylesheet.
   The demo ships `examples/demo-root.tsx` and `examples/demo-style.css` as references.
   Copy their shape by hand; the installer never replaces app-owned files.
7. Move `@tinker/start` to devDependencies. Keep it installed when using `tinker serve`.
   Run `tinker prepare`, then build, type checks, tests, and doctor.

Each `component.json` declares direct `requires` only.
Components take typed config tags. Their start extensions name missing required tags.
Only cmds/server.ts reads inputs and fills those tags.
One request uses one `startRequests` middleware from the requests component.
Move all routes and server functions to that same copy together.

Use `shadcn add --diff` to review copied code changes.
An update replaces a component whole. There is no automatic merge,
`tinker upgrade`, byte pin check, or runtime version check.
Update the tooling package with the package manager.
