# @tinker/start

Build tooling for an app that owns its runtime source.
Install this package as a dev dependency. It exports `@tinker/start/vite`
and the `tinker` command. It has no runtime, server, client, or testing export.
Core and React stay packages. Start's runtime lives in the app's copied files.

## Build glue

```ts
import { tinker } from "@tinker/start/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [tinker({ serverEntry: "cmds/server.ts", routerEntry: "cmds/router.ts", startEntry: "cmds/start.ts" })],
});
```

The plugin points Start at `cmds/start.ts`, `cmds/router.ts`, and the named server command.
It uses the app's physical `src/routes` tree and its own `src/routes/__root.tsx` shell.
There are no auth, sync, or telemetry switches. Copy the component and wire it by hand.

The app may also pass `root`, `compileHints`, `prerender`, `pages`, `spa`, and `sitemap`.
Unknown options fail. The plugin keeps Start's import protection:
`.server.` and `/backend/` stay out of browser code, and `.client.` stays out of server code.
It checks app types before a build can ship a broken route link.

## Commands

```bash
tinker prepare
tinker doctor
tinker doctor --fix
tinker serve
```

Prepare writes build paths and version data under `.tinker/`, then asks TanStack
for `.tinker/routeTree.gen.ts`. It never writes app code or wiring.
Old generated parts and env modules are removed. The app owns its commands.
A missing server command gets a clear error and a complete starter to copy by hand.

Doctor checks the generated folder, Vite glue, named command exports, import directions,
routes, styles, and the last build's import boundary record.
It reads `component.json` for direct component dependencies only. It never imports a component.
`--fix` repairs build config keys and generated files; it never edits app source or secrets.
It does not pin copied runtime bytes or choose the order of app wiring.

Serve imports the default entry, serves public and built client assets, and calls its handler.
The host supplies env, args, signal, stdout, stderr, and exit; the command owns the close order.
The host aborts its signal on SIGINT or SIGTERM and waits for closed. Asset paths, compression, ETags, and conditional
requests remain covered by the tooling tests. The app must keep the host package installed
where it runs `tinker serve`.

On Node 22, the AsyncLocalStorage that TanStack Start uses hooks every promise.
Node 24 keeps that context in a frame by default. To get the same on Node 22, run:

```bash
NODE_OPTIONS=--experimental-async-context-frame tinker serve
```

The flag is experimental on Node 22. Node 24 refuses it, so leave it out of shared scripts.

## Components

```bash
tinker add <name>
tinker update <name> [--force]
tinker check
```

The registry is the release tag's `public/r` folder for this version. `--registry <path|url>`
points at another one: a folder, a `registry.json` file, or an `https://` base.
Add copies `tinker/components/<name>/` and every component its `requires` names, transitively.
It also writes the files a component owns outside its folder (mail's `drizzle/` migrations),
merges the npm deps into `package.json` without changing a spec the app already pins, and
prints the import lines to paste into `cmds/*.ts`. It never writes `cmds/` or `src/`.
An item's `meta.toolchain` (`{ "<file>": ["<line>", ...] }`) is printed once per closure after
those lines, under `Paste into your toolchain (tinker add writes no config):`. Add writes none
of those files; a bad shape is refused (ADR `docs/decisions/registry-toolchain.md`).
Update replaces one folder whole through `.tinker/update/`, so a failed or killed update leaves
the old folder intact. It refuses when the folder has local edits unless you pass `--force`,
and it skips that refusal when it just restored a killed update.
`tinker/components.lock` records a sha256 per file and the Start version that copied it, so an
edit and a Start release are told apart: update measures a folder against the lock, and check
prints `edited:`, `outdated:`, `no lock entry:`, `missing component:`, `missing requires:`, and
`interrupted update:` lines. Check exits 1 on a finding and writes nothing.
A component may write only its own folder, `drizzle/`, `sqlite/migrations/` and `maintain/`;
any other target is `bad target ...`.
Component names are folder names: lower case letters, digits, and dashes.

## Copied code

```text
cmds/*.ts  -> ~/base, ~/components, @/, @tinker/core
src/       -> ~/components and npm packages, plus its own source
base/      -> entry, close, panics, and observer hand-off
components -> declared components; never base, cmds, or src
```

The last two folders live under `tinker/`. Base uses requests and errors.
Commands pass optional telemetry and sync values into base. Base has no pass-through exports.
A component declares direct dependencies in `component.json` and exposes public indexes.
Tests may use its private files. Imports omit `.ts`, `.tsx`, and `.mts` endings.

The golden source is `apps/start-scaffold/tinker/`. Registry items copy those actual files.
Each component has one item; its `registryDependencies` equal its direct `requires`.
Copied route files target `src/routes/`. App source remains user code.

## Updates

Start has prepare, doctor, serve, add, update, and check. Registry items copy the golden
source in `apps/start-scaffold/tinker/`, one item per component; each item's
`registryDependencies` equal its direct `requires`. Update replaces whole components and
stops on local edits. App-owned source stays app-owned.
See the [current contract](https://github.com/lagz0ne/tinker-app/blob/main/docs/decisions/start-decompose.md#d3-tooling-and-copied-updates).

## Checks

From the worktree root:

```bash
VITEST_MAX_WORKERS=1 VP_RUN_CONCURRENCY_LIMIT=1 vp run -r build
VITEST_MAX_WORKERS=1 VP_RUN_CONCURRENCY_LIMIT=1 vp check
VITEST_MAX_WORKERS=1 VP_RUN_CONCURRENCY_LIMIT=1 vp run -r test
```

Tooling tests stay here. Runtime tests live in `apps/start-scaffold/tests/runtime/`.
That folder has a strict type project so the demo's sync bodies do not leak into generic tests.
The app's `PLAIN.md` has a cap of 17. Only named copied base entry functions have exceptions.
Components and src have no function skips. Commands allow only the named server and browser mains.

Each push to `main` runs the diff mutation gate at floor 60; the weekly full app
run is a report. Start tooling keeps floor 85 in its `stryker.config.json`.
Local package packing and registry builds publish nothing.

Read the [current authoring contract](https://github.com/lagz0ne/tinker-app/blob/main/docs/decisions/start-decompose.md) for the main context,
clean exit, direct auth dependencies, and write-session ownership. Each
released version has its own section in [UPGRADE.md](UPGRADE.md).
