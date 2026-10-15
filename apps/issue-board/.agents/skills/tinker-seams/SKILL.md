---
name: tinker-seams
description: Keep app wiring on the base's public entries.
---

# Keep the seams

Omit `.ts`, `.tsx`, and `.mts` endings in imports and exports.

Use this when changing imports or app wiring.
Runtime source is copied into `tinker/base` and `tinker/components`.
The package `@tinker/start` holds only build tooling, doctor, and the host.
Review copied updates with `shadcn add --diff`; accepted updates replace a component whole.

Public entries belong to their owner:

- `~/components/requests`: startRequests, backendStop, requestStop.
- `~/components/requests/index.server`: readResult and request protocol state.
- `~/components/errors`: managed errors, and abort reasons.
- `~/components/database/index.server`: database, databaseUrl, databaseSetup, and drizzleOrm.
- `~/components/auth/index.server`: auth settings, principal, and required hooks.
- `~/components/sync` and `~/components/sync/index.server`: sync APIs and slot tags.
- `~/components/http/index.server`: httpRequest; tests bind httpBackend from `~/components/http`.
- `@tinker/start/vite`: the build plugin, used only in Vite config.

Commands bind app values through each required tag.
Components never read commands. Commands own roots; base receives native router options, observers and close callbacks.
Commands import only ~/base, ~/components, @/, and @tinker/core.
Src and components never import base. Components never import src or cmds.

The server command exports only async main and has no import-time startup or saved state.
Prod calls main once before listening. The dev host starts on its first fetch, shares one
startup promise, clears it on failure, and closes on HMR replacement.
The host calls `main({ env, signal, stdout, stderr })` once. The streams need only
`write(chunk: string): unknown`. The command reads no process globals and loads no env file.
It binds each value inline, for example `env.SMTP_FROM !== undefined && mail.mailFrom(env.SMTP_FROM)`.
Main returns `{ fetch, closed }`. Aborting the host signal closes app, then telemetry.
The one `closed` promise reports app failure first, then the first teardown error.
A start error closes what started, writes cleanup errors to stderr, and rethrows the start error.
The Node host loads .env and stops accepting requests on SIGINT or SIGTERM.
The dev host owns startup sharing, retry after failure, and abort on HMR replacement.
Inside main, the server command fills each typed config tag beside its scope.
Each component checks its required tags in its one startup extension.
Missing bindings reject ready with MissingTag and the tag name. Components never read env.

Doctor checks command exports, import directions, and build import violations.

Fill `Register` on `~/components/sync` in app source. Import sync types and readers directly from its public index; never forward them through an app barrel.
Commands import `~/components/name`; components never import src or cmds.
A component imports another public index only with a direct requires entry.
See `src/demo/contracts/sync.ts` for this app's bodies.
Put raw-input readers in `src/contracts/`.

Feature HTTP operations import httpRequest from
`~/components/http/index.server`.
Tests bind httpBackend from `~/components/http`.
App code never uses that tag or the raw http resource.
Import component operations from their public index.
A server seam that re-exports a feature can form a loop.

The app owns its migrations and wake triggers.
It imports sync tables from `~/components/sync/index.server`.
Server imports belong in server functions and routes.
Never import the server seam into a browser view.

After changing wiring:

```bash
npm run build
npm run typecheck
node scripts/check-plain.mjs
npm run doctor
node scripts/check-schema.mjs
```
