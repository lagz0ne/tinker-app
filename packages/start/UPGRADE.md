# Upgrade

## Unreleased

- The SQLite set installs onto an app made from the `app` item. `tinker add database-sqlite`
  (and `auth-sqlite`, `sync-sqlite`, which require it) no longer refuses with `is starter-only`.
  After the `cmds/*.ts` lines it prints the Reylo toolchain once, under
  `Paste into your toolchain (tinker add writes no config):`. Paste each line into the file it
  names: `package.json` (the `typecheck` script, TypeScript `7.1.0-beta` in `devDependencies`
  and `overrides`), `tsconfig.json` (`contentMappers`), `vite.config.ts` (`reylo()` first in the
  plugins, `test.globalSetup`; also `vitest.config.ts` if you have one), and a new `.reylo.yaml`.
  Then run `npm install` (or `pnpm install`). Add writes none of those files.
  ADR `docs/decisions/registry-toolchain.md`.
- A registry item declares that need in `meta.toolchain`: an object of app file -> lines.
  Add, update and check refuse a bad shape with `bad meta.toolchain in <name>: ...`.
  `meta.starterOnly` and its refusal are gone; no item uses it.
- The SQLite items ship their migrations to `sqlite/migrations/`, where the demo keeps them
  (the registry said `migrations/`, which no app could install). `databaseMigrationsFolder`
  now defaults to `sqlite/migrations`, relative to `databaseFolder`. An app made from the demo
  that binds `databaseMigrationsFolder("sqlite/migrations")` (`## 0.13.0`, step 3) can keep or
  drop that line. An app that relies on the old default `migrations` binds
  `databaseMigrationsFolder("migrations")` or moves the files.
- A component may now write `sqlite/migrations/` and the one file `maintain/sqlite-dev-db.mjs`
  as well as `drizzle/`. `database-sqlite` ships that file, the dev database builder. A file
  there with other bytes is a `conflict:`.
- `tinker update` now refuses an outside file that the lock does not list and that has other
  bytes than the registry copy: it prints `conflict: <path>` and keeps the file. `--force` still
  replaces it. Before, such a file was overwritten with no warning.
- `maintain/sqlite-dev-db.mjs` stops with `tsconfig.json has no Reylo "contentMappers" entry`
  when `database-sqlite` is installed and the mapper line is missing. Without it, tsc reads
  each `.sql` import as `any` and passes.
- An app made from the demo before this release has a lock without the SQLite items'
  `sqlite/migrations/` files and `maintain/sqlite-dev-db.mjs`, so `tinker check` prints
  `outdated: database-sqlite`, `outdated: auth-sqlite` and `outdated: sync-sqlite` (notes,
  exit 0). Run `tinker update database-sqlite`, then `auth-sqlite` and `sync-sqlite`, to record
  them. If update prints `conflict: maintain/sqlite-dev-db.mjs` and you did not edit that file,
  rerun with `--force`; if you did, keep your copy and leave the note.
- `database-sqlite` ships `sql.d.ts`: a `declare module "*.sql"` fallback, so tsgolint (the
  type-aware lint, TypeScript 7.0, no content mappers) reads each `.sql` import as a Reylo
  query. The type check (TypeScript 7.1, `--runExternalCode`) still uses Reylo's real types.

## 0.16.0

Start 0.16.0 is released from `lagz0ne/tinker-app`, tag `start-v0.16.0`.
The tag holds the Start tarball only. Core and React stay on 0.9.0.
Change the Start URL in your `package.json` to
`https://github.com/lagz0ne/tinker-app/releases/download/start-v0.16.0/tinker-start-0.16.0.tgz`,
then run `pnpm install`. The registry now reads from
`https://raw.githubusercontent.com/lagz0ne/tinker-app/start-v0.16.0/apps/start-scaffold/public/r`.
Exports refuse a tooling version below 0.16.0.

Two new parts: an MCP server, and sign-in with a code. Hedl found both gaps (#40, #43).
The design is in `docs/decisions/mcp-and-device-signin.md`.

- New `mcp` item. It serves your tools over stateless Streamable HTTP, POST only, with JSON
  replies. Each tool is a row in the `mcpTools` tag: a name, words, hints, a zod `input`, and the
  Core operation to run. Each call is one Core run, so one span. The raw arguments are parsed
  once, by the operation. A `Refused` error becomes `Not done: <message>`; any other error is
  logged and the reply says only that the tool failed. Bodies over `maxBody` (2 MB) get 413.
  Install `mcpRuns` on the root, and bind `mcpServer` and `mcpTools`. The item has no auth
  inside: your `/mcp` route checks the token first.
- `auth-sqlite` adds OAuth for MCP with Better Auth's `jwt()` and `@better-auth/mcp`:
  client registration with the `authMcp` redirect list (the two Claude callbacks and loopback
  `/callback` by default), PKCE, RFC 9728 metadata, and 5-minute access tokens bound to
  `<origin>/mcp`. `checkMcpToken` gives the caller, or the 401 or 403 challenge to send. Bind
  the caller with `mcpCaller` on the `handleMcp` call.
- `auth-sqlite` adds sign-in with a code (RFC 8628, as obelisk does it). A browser posts
  `/api/auth/signin/code` and shows the code; a signed-in person approves it through the
  `approveSignin` operation (an MCP tool); the browser posts `/api/auth/signin/code/finish` and
  gets that person's session. `listSignins` and `endSignin` list and end code sign-ins.
  Give `approveSignin`'s tool obelisk's warning text (see the ADR). A code start is held to 5
  per IP in 10 minutes where Better Auth's limiter is on: in production by its default, and
  anywhere with `authRateLimit({ enabled: true })`.
- New migrations: `20261031000200_auth_mcp.sql` and `20261031000300_auth_signin_client.sql`.
  They add Better Auth's OAuth, JWKS, and device-code tables, and the code sign-in columns.
- New error kinds: `Refused` and `McpNotInstalled`.
- An `authSettings.origin` that is plain `http` and not loopback now fails at startup:
  an MCP resource must be `https`, or `localhost` / `127.0.0.1` for development.
- Route these paths to `handleAuth`: `/api/auth/*`, `/.well-known/oauth-protected-resource`,
  `/.well-known/oauth-protected-resource/mcp`, and
  `/.well-known/oauth-authorization-server/api/auth`. The README part
  "MCP and sign-in with a code" shows the `/mcp` route.

The SQLite items are starter-only, so an app made from the demo takes this by the template
update to `demo-v0.16.0`. Postgres `auth` has neither part yet; `mcp` already works with it.

## 0.15.0

Start 0.15.0 is released from `lagz0ne/tinker-app`, tag `start-v0.15.0`.
The tag holds the Start tarball only. Core and React stay on 0.9.0.
Change the Start URL in your `package.json` to
`https://github.com/lagz0ne/tinker-app/releases/download/start-v0.15.0/tinker-start-0.15.0.tgz`,
then run `pnpm install`. The registry now reads from
`https://raw.githubusercontent.com/lagz0ne/tinker-app/start-v0.15.0/apps/start-scaffold/public/r`.
Exports refuse a tooling version below 0.15.0.

- New component `agent-talk` (ADR `docs/decisions/agent-talk.md`). A scope owns each Claude
  Agent SDK run (`@anthropic-ai/claude-agent-sdk@0.3.295`). `agentTalk.run(talk, turn)` runs one
  `query()` per turn and maps its stream to `TalkEvent`s. Its result never rejects: `done`,
  `failed`, `stopped`, `closed` or `busy`. `stop(talk)` aborts one talk. `warm(talk, plan)` runs
  quiet ping turns on the scope clock to keep the prompt cache warm. Closing or releasing the
  scope aborts every run, wait and timer, and joins them before close returns. The component fixes
  the safe options (`dontAsk`, no setting sources, strict MCP config, its own env) and never reads
  `process.env`. Bind the credential in the command, OAuth token first:

  ```ts
  env.CLAUDE_CODE_OAUTH_TOKEN
    ? agentCredentials({ oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN })
    : env.ANTHROPIC_API_KEY !== undefined && agentCredentials({ apiKey: env.ANTHROPIC_API_KEY }),
  agentConfigDir(join(dataDir, "claude")),
  ```

  With no credential, a run ends `failed` with `not-signed-in` and calls no `query()`. Tests
  preset `agentSdk` with a fake; `npm run test:agent-live` is a by-hand proof that needs a key and
  prints `not run` without one. The demo template ships it, so a new demo app installs the SDK and
  one platform binary of about 256 MB. An app made from the demo takes it by the template update
  from `demo-v0.14.0` to `demo-v0.15.0`; another app adds it with `tinker add agent-talk`.
  Hedl asked for it (gap TG2, #41).

## 0.14.0

Start 0.14.0 is released from `lagz0ne/tinker-app`, tag `start-v0.14.0`.
The tag holds the Start tarball only. Core and React stay on 0.9.0.
Change the Start URL in your `package.json` to
`https://github.com/lagz0ne/tinker-app/releases/download/start-v0.14.0/tinker-start-0.14.0.tgz`,
then run `pnpm install`. The registry now reads from
`https://raw.githubusercontent.com/lagz0ne/tinker-app/start-v0.14.0/apps/start-scaffold/public/r`.
Exports refuse a tooling version below 0.14.0.

- New component `blobs-sqlite` (SQLite set, starter-only like the other SQLite items): a blob
  store. Bytes are named by their sha256 and kept once under `blobFolder/<2 hex>/<sha256>`;
  rows live in the new migration `20261031000000_blobs.sql`. Operations: `putBlob`, `readBlob`,
  `openSlot`, `fillSlot` (an upload slot the client PUTs a byte stream to), and `takeSlot`
  (once, for the slot's owner). A write goes to a temp file, is fsynced, then renamed, so a half
  upload is never readable. A slot expires after `blobSlotTtl` (one hour) and has a size cap
  (`blobMaxBytes`, 25 MiB). `blobUnpackMax` (100 MiB) caps `putBlob` and is the unpacked-size cap
  an app's zip reader passes to inflate. Bind `blobFolder` (an absolute path) in
  `cmds/server.ts`. See `docs/decisions/blob-store.md`. Hedl asked for it (TG3).
- `errors` gains seven kinds: `BlobTooBig`, `BlobEmpty`, `BlobNotBytes`, `SlotMissing`,
  `SlotExpired`, `SlotUsed`, `SlotEmpty`. An app on 0.13.4 sees `errors` as outdated until it
  runs `tinker update errors`.

## 0.13.4

Start 0.13.4 is released from `lagz0ne/tinker-app`, tag `start-v0.13.4`.
The tag holds the Start tarball only. Core and React stay on 0.9.0.
Change the Start URL in your `package.json` to
`https://github.com/lagz0ne/tinker-app/releases/download/start-v0.13.4/tinker-start-0.13.4.tgz`,
then run `pnpm install`. The registry now reads from
`https://raw.githubusercontent.com/lagz0ne/tinker-app/start-v0.13.4/apps/start-scaffold/public/r`.
Exports refuse a tooling version below 0.13.4.

The demo's `scripts/check-plain.mjs` accepts three more forms. Hedl found each one.

- A module-level zod 4 `z.looseObject({...})` is a schema declaration, like `z.object` and
  `z.strictObject`. Before, it failed `module-effect`.
- A module-level `const` that holds a literal `new Set([...])` or `new Map([[key, value], ...])`
  is a static value, like a const lookup table:

  ```ts
  const stopWords = new Set(["a", "an", "the"]);
  ```

  Every element must be a literal, and `Set` and `Map` must be the built-in ones. Each use must
  only read the value: `has`, `get`, `forEach`, `keys`, `values`, or `entries` as a call, `size`,
  `for...of`, or a spread. Any other use, such as `add`, passing it to a function, or putting it in
  an object, still fails `module-effect` at the declaration.

- A function declaration inside an operation's `run` is part of that run, not a plain helper,
  when each use of its name is a direct call. A recursive function there no longer fails
  `two-sites`, and `PLAIN.md` does not list it. A method, a function value, or a declaration
  that is returned or passed still gets the plain checks. A module-level function still needs
  two callers.

New `--prove` cases cover each form and its refused twins. An app made from the demo takes the new
`scripts/check-plain.mjs` by the template update from `demo-v0.13.3` to `demo-v0.13.4`, or copies it
from tag `start-v0.13.4`.

## 0.13.3

Start 0.13.3 is released from `lagz0ne/tinker-app`, tag `start-v0.13.3`.
The tag holds the Start tarball only. Core and React stay on 0.9.0.
Change the Start URL in your `package.json` to
`https://github.com/lagz0ne/tinker-app/releases/download/start-v0.13.3/tinker-start-0.13.3.tgz`,
then run `pnpm install`. The registry now reads from
`https://raw.githubusercontent.com/lagz0ne/tinker-app/start-v0.13.3/apps/start-scaffold/public/r`.
Exports refuse a tooling version below 0.13.3.

- `database-sqlite`'s `databaseUrl` now takes a string as well as a `file:` URL, and resolves a
  relative one against the new `databaseFolder` tag: the app folder, which the command binds from
  `defineMain`'s `cwd`. Before, `DATABASE_URL=file:./data/app.db` opened `/data/app.db`. The fix in
  `## 0.13.0`, step 2, needs `node:url` in the command. Hedl's own `file://${cwd}/` base broke
  when the folder name held `%`, `#`, or `?`. A database string with no `databaseFolder` fails
  with `DatabaseFolderMissing` before it opens any file, and an empty string is refused. Bind
  both values in `cmds/server.ts`, and in `cmds/worker.ts` if your app has one:

  ```ts
  env.DATABASE_URL !== undefined && databaseUrl(env.DATABASE_URL),
  databaseFolder(cwd),
  ```

  A `databaseUrl(url)` binding still works as given, so a command that builds its own
  `pathToFileURL` keeps working. `databaseMigrationsFolder` also resolves against
  `databaseFolder` when it is bound, and against the working directory when it is not.
  Hedl found it. The SQLite items are starter-only, so an app made from the demo takes this by
  the template update from `demo-v0.13.2` to `demo-v0.13.3`.

## 0.13.2

Start 0.13.2 is released from `lagz0ne/tinker-app`, tag `start-v0.13.2`.
The tag holds the Start tarball only. Core and React stay on 0.9.0.
Change the Start URL in your `package.json` to
`https://github.com/lagz0ne/tinker-app/releases/download/start-v0.13.2/tinker-start-0.13.2.tgz`,
then run `pnpm install`. The registry now reads from
`https://raw.githubusercontent.com/lagz0ne/tinker-app/start-v0.13.2/apps/start-scaffold/public/r`.
Exports refuse a tooling version below 0.13.2.

- The demo's `scripts/check-plain.mjs` lets a copied `tinker/base/` helper have one caller.
  Other plain helpers still need two (`two-sites`), and a base helper with no caller still fails.
  Before, `tinker/base/main.ts#mainErrorCode` needed two commands to call it, so an app with
  only `cmds/server.ts` failed the plain check. Hedl found it: the move to the SQLite set
  (`## 0.13.0`, step 1) drops the mail worker, which leaves the server as the only caller, and
  `tinker/` may not be edited in the app. Two new `--prove` cases cover it:
  `base-helper-zero-site` (red) and `base-helper-one-site-allowed` (green).
  An app made from the demo takes the new `scripts/check-plain.mjs` by the template update from
  `demo-v0.13.1` to `demo-v0.13.2`, or copies it from tag `start-v0.13.2`.
- `tinker add` and `tinker update` record each component in `tinker/components.lock`: the Start
  version it came from and a sha256 per file. `update` now refuses only when local files differ from
  the lock, so a clean copy updates across a Start release without `--force`; `check` reports edits
  against the lock. Template exports ship a lock made from their own bytes, so a fresh small or
  demo app checks clean. A killed update rolls forward from the files on disk; a failed one leaves
  the old folder and lock entry whole.

## 0.13.1

Start 0.13.1 is released from `lagz0ne/tinker-app`, tag `start-v0.13.1`.
The tag holds the Start tarball only. Core and React stay on 0.9.0.
Change the Start URL in your `package.json` to
`https://github.com/lagz0ne/tinker-app/releases/download/start-v0.13.1/tinker-start-0.13.1.tgz`,
then run `pnpm install`. The registry now reads from
`https://raw.githubusercontent.com/lagz0ne/tinker-app/start-v0.13.1/apps/start-scaffold/public/r`.
Exports refuse a tooling version below 0.13.1.

- `sync-sqlite` gets a second migration, `20261030000000_sync_public.sql`. It seeds the
  `public` stream row, as the Postgres set's `account_streams` migration does. Without it,
  `eventHistory.read(tx, "public")` fails with `StreamMissing`, so a bootstrap of the public
  stream fails on a fresh SQLite database. Hedl found it: its bootstrap, the first app
  code on the SQLite set to read the public stream, failed on a fresh database.
  The demo template carries the file in
  `sqlite/migrations`. The SQLite items are starter-only, so `tinker add` and `tinker update`
  refuse them: an app made from the demo takes it by the template update from `demo-v0.13.0`
  to `demo-v0.13.1`, or copies `apps/start-scaffold/sqlite/migrations/20261030000000_sync_public.sql`
  from tag `start-v0.13.1` into its migrations folder. `migrate` applies it once; it changes no
  existing row.

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
