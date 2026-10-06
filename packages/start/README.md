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

## Entries

- `@tinker/start`: shared units, such as
  `startRequests` and `RouterOptions`.
- `@tinker/start/server`: `readResult`, `env`,
  `createServerEntry`.
- `@tinker/start/vite`: `tinker()`.

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
