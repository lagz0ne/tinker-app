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
  plugins: [tinker({ serverEntry: "cmds/server.ts" })],
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
The server command owns config input and close order.
It closes the app on SIGINT or SIGTERM. Asset paths, compression, ETags, and conditional
requests remain covered by the tooling tests. The app must keep the host package installed
where it runs `tinker serve`.

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

Review a component before copying a new version:

```bash
npx shadcn@4.21.0 add \
  http://127.0.0.1:4870/r/mail.json \
  --diff tinker/components/mail/mail.server.ts
```

An accepted component update replaces its files whole. It does not merge user edits.
There is no `tinker upgrade`, byte pin check, or runtime package version check.
Use the package manager to update this dev tool. Review copied code separately.

Read the scaffold's [commands and component guide](../../apps/start-scaffold/README.md)
for the actual auth hooks, sync slots, and manual demo shell edits.

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
Components, src, and commands have no function skips.

The lander runs mutation checks. Tooling keeps its 75 floor;
the golden copied runtime has an 85 floor in the scaffold's `stryker.config.json`.
Local package packing and registry builds publish nothing.
