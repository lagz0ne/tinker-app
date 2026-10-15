# Move to copied Start components

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

Each `component.json` declares direct `requires` and optional `env` data.
Doctor reads JSON only. Runtime settings check and convert env separately.
One request uses one `startRequests` middleware from the requests component.
Move all routes and server functions to that same copy together.

Use `shadcn add --diff` to review copied code changes.
An update replaces a component whole. There is no automatic merge,
`tinker upgrade`, byte pin check, or runtime version check.
Update the tooling package with the package manager.
