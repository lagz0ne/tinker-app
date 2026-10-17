# Upgrade

## Unreleased

These templates require the planned Start 0.10.0 host and matching registry.
Released 0.9.0 cannot run the new main contract. Default source exports stop
with that message until the tooling version reaches 0.10.0. Local proof
exports carry an explicit current host pack in vendor; nothing is published.

These changes are in current source, not the released 0.9.0 tarball. Use the
matching tooling host with the copied runtime; do not mix the new main with the
old host. See the [current authoring contract](https://github.com/lagz0ne/tinker-app/blob/next/docs/decisions/start-decompose.md).

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
